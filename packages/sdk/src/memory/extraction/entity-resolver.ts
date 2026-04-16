import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { SemanticEntity } from '../types/memory.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import { createTemporal } from '../temporal.js'
import { generateId } from '../../utils/id.js'

// ── Alias validation ──

const PRONOUN_BLOCKLIST = new Set([
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'this', 'that', 'these', 'those',
  'who', 'whom', 'whose', 'which', 'what',
])

const GENERIC_NOUNS = new Set([
  'team', 'teams', 'roster', 'rosters', 'squad', 'squads',
  'company', 'companies', 'firm', 'firms', 'corporation', 'corporations',
  'organization', 'organizations', 'group', 'groups', 'unit', 'units',
  'city', 'cities', 'town', 'towns', 'country', 'countries', 'state', 'states',
  'nation', 'nations', 'area', 'areas', 'region', 'regions', 'place', 'places',
  'player', 'players', 'person', 'people', 'man', 'woman', 'individual', 'individuals',
  'league', 'leagues', 'conference', 'conferences', 'division', 'divisions',
  'game', 'games', 'match', 'matches', 'series', 'season', 'seasons',
  'award', 'awards', 'prize', 'prizes', 'committee', 'committees',
  'event', 'events', 'show', 'shows', 'movie', 'movies', 'film', 'films',
  'book', 'books', 'album', 'albums', 'song', 'songs',
  'thing', 'things', 'item', 'items', 'entity', 'entities',
  'one', 'ones', 'other', 'others', 'same', 'first', 'last', 'next', 'final',
  'protocol', 'protocols', 'framework', 'frameworks', 'ingredient', 'ingredients',
  'system', 'systems', 'service', 'services', 'project', 'projects',
  'finals', 'championship', 'championships', 'tournament', 'tournaments',
  'olympics', 'mvp', 'trophy', 'trophies', 'cup', 'cups',
  'medal', 'medals', 'title', 'titles', 'record', 'records',
  'draft', 'drafts', 'round', 'rounds',
])

/**
 * Validates whether a string is a legitimate alias (proper name, abbreviation, or nickname).
 * Rejects pronouns, generic noun phrases, pure numbers, and too-short strings.
 *
 * Examples:
 *   isValidAlias("NASA") → true
 *   isValidAlias("Celtics") → true
 *   isValidAlias("it") → false
 *   isValidAlias("the team") → false
 *   isValidAlias("2024") → false
 */
export function isValidAlias(alias: string): boolean {
  const trimmed = alias.trim()

  // Reject empty or single-character
  if (trimmed.length < 2) return false

  // Reject overly long aliases (book/article titles, descriptions)
  if (trimmed.length > 80) return false

  const lower = trimmed.toLowerCase()

  // Reject pronouns — only when original is all-lowercase (preserves "US", "IT" as abbreviations)
  if (trimmed === lower && PRONOUN_BLOCKLIST.has(lower)) return false

  // Reject pure numbers (years, counts, etc.)
  if (/^\d+$/.test(trimmed)) return false

  // Reject parenthetical disambiguators (e.g., "Paris (city)", "React (library)")
  if (/\((?:book|film|movie|album|song|TV\s+series|TV|series|disambiguation|band|comics?|video\s+game)\)/i.test(trimmed)) {
    return false
  }

  // Reject "the/a/an/this/that + optional adjectives + generic noun" patterns
  // Matches: "the team", "a company", "the final team", "the forthcoming American roster",
  //          "this professional roster", "an organization"
  const genericPattern = /^(?:the|a|an|this|that|these|those)\s+(?:\w+\s+)*(\w+)$/i
  const match = trimmed.match(genericPattern)
  if (match) {
    const lastWord = match[1]!.toLowerCase()
    if (GENERIC_NOUNS.has(lastWord)) return false
  }

  // Reject single-word generic nouns regardless of case
  // Catches "Finals", "Olympics", "MVP", "draft" etc.
  const words = lower.split(/\s+/)
  if (words.length === 1) {
    if (GENERIC_NOUNS.has(lower)) return false
  }

  // Reject bare multi-word generic noun phrases (without article)
  // e.g., "professional roster", "defending champions"
  if (words.length === 2) {
    const lastWord = words[words.length - 1]!
    if (GENERIC_NOUNS.has(lastWord) && words.every(w => !w.match(/^[A-Z]/) || GENERIC_NOUNS.has(w) || isCommonAdjective(w))) {
      // Only reject if the entire string is lowercase (no proper noun capitalization signal)
      if (trimmed === lower) return false
    }
  }

  return true
}

/** Common adjectives that appear in generic references but not proper names */
function isCommonAdjective(word: string): boolean {
  const ADJECTIVES = new Set([
    'professional', 'defending', 'former', 'current', 'main', 'primary',
    'final', 'forthcoming', 'upcoming', 'previous', 'next', 'last',
    'first', 'second', 'third', 'new', 'old', 'big', 'small',
    'american', 'national', 'international', 'local', 'regional',
  ])
  return ADJECTIVES.has(word)
}

// ── Entity Resolver ──
// Deduplicates entities using a 6-phase cascade:
//   Phase 0: In-memory session cache (instant)
//   Phase 1: Exact alias matching via DB ILIKE (cheapest DB call)
//   Phase 2: Normalized string matching (catches case/punctuation variants)
//   Phase 2.5: Fuzzy matching via trigram Jaccard (catches abbreviations/reorderings)
//   Phase 3: Vector similarity on name embeddings (catches semantic equivalents)
//   Phase 3.5: Description-confirmed near-miss (catches nickname/variant name matches)
//
// Cross-cutting guards:
//   - Type compatibility: prevents merging person with location, etc.
//   - Distinguishing attributes: prevents merging "1992 team" with "1988 team"

/** Minimum name similarity to enter Phase 3.5 description matching */
const NEAR_MISS_NAME_THRESHOLD = 0.45

/** Required description cosine similarity for Phase 3.5 merge */
const DESC_SIMILARITY_THRESHOLD = 0.8

export interface EntityResolverConfig {
  store: MemoryStoreAdapter
  embedding: EmbeddingProvider
  /** Cosine similarity threshold for considering entities as duplicates. Default: 0.68 */
  similarityThreshold?: number | undefined
}

export class EntityResolver {
  private readonly store: MemoryStoreAdapter
  private readonly embedding: EmbeddingProvider
  private readonly threshold: number
  // In-memory cache: normalized name → entity. Eliminates duplicates from
  // DB LIMIT misses and timing races between addTriple calls.
  private readonly nameCache = new Map<string, SemanticEntity>()

  constructor(config: EntityResolverConfig) {
    this.store = config.store
    this.embedding = config.embedding
    this.threshold = config.similarityThreshold ?? 0.85
  }

  private cacheEntity(entity: SemanticEntity): void {
    this.nameCache.set(normalizeForComparison(entity.name), entity)
    for (const alias of entity.aliases) {
      if (!isValidAlias(alias)) continue // skip indexing garbage aliases
      this.nameCache.set(normalizeForComparison(alias), entity)
    }
  }

  /**
   * Resolve a candidate entity against existing entities in the store.
   * Returns the existing entity if a match is found, or creates a new one.
   */
  async resolve(
    name: string,
    entityType: string,
    aliases: string[],
    scope: typegraphIdentity,
    description?: string,
  ): Promise<{ entity: SemanticEntity; isNew: boolean }> {
    // Phase 0: In-memory cache (instant — catches all prior entities in this session)
    const normalizedName = normalizeForComparison(name)
    const cached = this.nameCache.get(normalizedName)
    if (cached && typesCompatible(entityType, cached.entityType)) {
      const merged = await this.merge(cached, { name, entityType, aliases, description })
      this.cacheEntity(merged)
      return { entity: merged, isNew: false }
    }
    // Also check aliases against cache (skip invalid aliases to prevent false cache hits)
    for (const alias of aliases) {
      if (!isValidAlias(alias)) continue
      const cachedByAlias = this.nameCache.get(normalizeForComparison(alias))
      if (cachedByAlias && typesCompatible(entityType, cachedByAlias.entityType)) {
        const merged = await this.merge(cachedByAlias, { name, entityType, aliases, description })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }
    }

    // Phase 1: Alias matching (cheap — uses ILIKE + ANY index)
    if (this.store.findEntities) {
      const candidates = await this.store.findEntities(name, scope, 10)
      const aliasMatch = this.findByAlias(name, aliases, entityType, candidates)
      if (aliasMatch) {
        const merged = await this.merge(aliasMatch, { name, entityType, aliases, description })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }

      // Phase 2: Normalized string matching (catches case/punctuation variants)
      for (const candidate of candidates) {
        if (!typesCompatible(entityType, candidate.entityType)) continue
        if (normalizeForComparison(candidate.name) === normalizedName) {
          const merged = await this.merge(candidate, { name, entityType, aliases, description })
          this.cacheEntity(merged)
          return { entity: merged, isNew: false }
        }
        for (const alias of candidate.aliases) {
          if (normalizeForComparison(alias) === normalizedName) {
            const merged = await this.merge(candidate, { name, entityType, aliases, description })
            this.cacheEntity(merged)
            return { entity: merged, isNew: false }
          }
        }
      }

      // Phase 2.5: Fuzzy matching via trigram Jaccard (catches abbreviations/reorderings)
      // e.g., "NY Times" vs "New York Times", "J.K. Rowling" vs "JK Rowling"
      const fuzzyMatch = this.findByFuzzy(name, aliases, entityType, candidates)
      if (fuzzyMatch) {
        const merged = await this.merge(fuzzyMatch, { name, entityType, aliases, description })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }
    }

    // Phase 3 + 3.5: Vector similarity with optional description confirmation
    let nameEmbedding: number[] | undefined
    if (this.store.searchEntities) {
      nameEmbedding = await this.embedding.embed(name)
      const similar = await this.store.searchEntities(nameEmbedding, scope, 5)

      // Phase 3: Direct name-embedding match
      for (const candidate of similar) {
        if (!typesCompatible(entityType, candidate.entityType)) continue
        if (entityType === 'person' && candidate.entityType === 'person') {
          if (!hasMatchingLastToken(name, candidate.name)) continue
        }
        if (hasConflictingDistinguishers(name, candidate.name)) continue
        if (!hasSharedNameToken(name, candidate.name)) continue

        const similarity = (candidate.properties._similarity as number | undefined)
          ?? this.cosineSimilarity(nameEmbedding, candidate.embedding ?? [])
        if (similarity >= this.threshold) {
          const merged = await this.merge(candidate, { name, entityType, aliases, description })
          this.cacheEntity(merged)
          return { entity: merged, isNew: false }
        }
      }

      // Phase 3.5: Description-confirmed near-miss matching
      // Catches entities with different name forms but similar descriptions
      // (e.g., "Chris Mullin" vs "Christopher Paul Mullin" — both NBA players)
      if (description) {
        const descMatch = await this.resolveByDescription(
          name, entityType, description, similar, nameEmbedding,
        )
        if (descMatch) {
          const merged = await this.merge(descMatch, { name, entityType, aliases, description })
          this.cacheEntity(merged)
          return { entity: merged, isNew: false }
        }
      }
    }

    // No match found - create new entity (reuse embedding from Phase 3 if available)
    if (!nameEmbedding) {
      nameEmbedding = await this.embedding.embed(name)
    }
    const descriptionEmbedding = description
      ? await this.embedding.embed(description)
      : undefined
    const entity: SemanticEntity = {
      id: generateId('ent'),
      name,
      entityType,
      aliases,
      properties: description ? { description } : {},
      embedding: nameEmbedding,
      descriptionEmbedding,
      scope,
      temporal: createTemporal(),
    }

    this.cacheEntity(entity)
    return { entity, isNew: true }
  }

  /**
   * Check if a name or any of its aliases match an existing entity.
   */
  private findByAlias(
    name: string,
    aliases: string[],
    entityType: string,
    candidates: SemanticEntity[],
  ): SemanticEntity | undefined {
    const nameLower = name.toLowerCase()
    const aliasesLower = aliases.map(a => a.toLowerCase())

    for (const candidate of candidates) {
      if (!typesCompatible(entityType, candidate.entityType)) continue
      const candidateNames = [
        candidate.name.toLowerCase(),
        ...candidate.aliases.map(a => a.toLowerCase()),
      ]

      if (candidateNames.includes(nameLower)) return candidate
      for (const alias of aliasesLower) {
        if (candidateNames.includes(alias)) return candidate
      }
    }

    return undefined
  }

  /**
   * Merge incoming data into an existing entity.
   * Adds new aliases, updates type if more specific.
   */
  async merge(
    existing: SemanticEntity,
    incoming: { name: string; entityType: string; aliases: string[]; description?: string | undefined },
  ): Promise<SemanticEntity> {
    const existingAliases = new Set(existing.aliases.map(a => a.toLowerCase()))
    const newAliases = [...existing.aliases]

    // Add the incoming name as an alias if different from canonical (validate first)
    if (incoming.name.toLowerCase() !== existing.name.toLowerCase()) {
      if (!existingAliases.has(incoming.name.toLowerCase()) && isValidAlias(incoming.name)) {
        newAliases.push(incoming.name)
      }
    }

    // Add new aliases (filter out garbage)
    for (const alias of incoming.aliases) {
      if (!isValidAlias(alias)) continue
      if (!existingAliases.has(alias.toLowerCase()) && alias.toLowerCase() !== existing.name.toLowerCase()) {
        newAliases.push(alias)
      }
    }

    // Merge descriptions: keep best description, capped at 500 chars to prevent runaway growth
    const MAX_DESCRIPTION_LENGTH = 500
    const properties = { ...existing.properties }
    if (incoming.description) {
      const existingDesc = (properties.description as string | undefined) ?? ''
      if (!existingDesc) {
        properties.description = incoming.description.slice(0, MAX_DESCRIPTION_LENGTH)
      } else if (existingDesc.length < MAX_DESCRIPTION_LENGTH && !existingDesc.includes(incoming.description)) {
        properties.description = `${existingDesc} ${incoming.description}`.slice(0, MAX_DESCRIPTION_LENGTH)
      }
    }

    // Re-embed description if it changed (so stored description_embedding stays fresh)
    const descriptionChanged = incoming.description
      && (properties.description as string | undefined) !== (existing.properties.description as string | undefined)
    const descriptionEmbedding = descriptionChanged
      ? await this.embedding.embed(properties.description as string)
      : existing.descriptionEmbedding

    return {
      ...existing,
      aliases: newAliases,
      properties,
      descriptionEmbedding,
      // Keep existing type unless it's generic and incoming is more specific
      entityType: (existing.entityType === 'entity' || existing.entityType === 'other')
        ? incoming.entityType
        : existing.entityType,
    }
  }

  /**
   * Find a fuzzy match using trigram Jaccard similarity.
   * Checks incoming name + aliases against candidate name + aliases.
   * Requires type compatibility to prevent cross-type merges.
   */
  private findByFuzzy(
    name: string,
    aliases: string[],
    entityType: string,
    candidates: SemanticEntity[],
  ): SemanticEntity | undefined {
    const FUZZY_THRESHOLD = 0.85
    const incomingNames = [name, ...aliases]

    for (const candidate of candidates) {
      if (!typesCompatible(entityType, candidate.entityType)) continue
      if (entityType === 'person' && candidate.entityType === 'person') {
        if (!hasMatchingLastToken(name, candidate.name)) continue
      }
      const candidateNames = [candidate.name, ...candidate.aliases]

      for (const a of incomingNames) {
        for (const b of candidateNames) {
          if (hasConflictingDistinguishers(a, b)) continue
          if (trigramJaccard(a, b) >= FUZZY_THRESHOLD) {
            return candidate
          }
        }
      }
    }

    return undefined
  }

  /**
   * Phase 3.5: Find a match among near-miss candidates by comparing description embeddings.
   * Only considers candidates with name similarity in [NEAR_MISS_NAME_THRESHOLD, this.threshold).
   */
  private async resolveByDescription(
    name: string,
    entityType: string,
    description: string,
    candidates: SemanticEntity[],
    nameEmbedding: number[],
  ): Promise<SemanticEntity | undefined> {
    // Filter to near-miss candidates that have descriptions and stored description embeddings
    const nearMisses = candidates.filter(c => {
      if (!typesCompatible(entityType, c.entityType)) return false
      if (entityType === 'person' && c.entityType === 'person') {
        if (!hasMatchingLastToken(name, c.name)) return false
      }
      if (hasConflictingDistinguishers(name, c.name)) return false
      if (!hasSharedNameToken(name, c.name)) return false
      const nameSim = (c.properties._similarity as number | undefined)
        ?? this.cosineSimilarity(nameEmbedding, c.embedding ?? [])
      if (nameSim < NEAR_MISS_NAME_THRESHOLD || nameSim >= this.threshold) return false
      const desc = c.properties.description as string | undefined
      if (!desc || !c.descriptionEmbedding) return false
      return true
    })

    if (nearMisses.length === 0) return undefined

    // Embed the incoming description once, then compare against each candidate's stored embedding
    const incomingDescEmbedding = await this.embedding.embed(description)

    for (const candidate of nearMisses) {
      const descSim = this.cosineSimilarity(incomingDescEmbedding, candidate.descriptionEmbedding!)
      if (descSim >= DESC_SIMILARITY_THRESHOLD) {
        return candidate
      }
    }

    return undefined
  }

  /**
   * Cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0

    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!
      normA += a[i]! * a[i]!
      normB += b[i]! * b[i]!
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB)
    if (denominator === 0) return 0
    return dotProduct / denominator
  }
}

/**
 * Normalize a string for comparison: lowercase, strip non-alphanumeric.
 * Catches: "OpenAI" vs "openai", "New York" vs "NewYork", "X" vs "x"
 */
function normalizeForComparison(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Trigram Jaccard similarity between two strings.
 * Catches abbreviations ("NY Times" / "New York Times") and minor reorderings
 * that normalized string matching misses but vector similarity is too coarse for.
 */
function trigramJaccard(a: string, b: string): number {
  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const trigrams = (s: string): Set<string> => {
    const t = new Set<string>()
    const n = normalized(s)
    for (let i = 0; i <= n.length - 3; i++) t.add(n.slice(i, i + 3))
    return t
  }
  const ta = trigrams(a)
  const tb = trigrams(b)
  // Need at least 1 trigram in each to compare (strings must be 3+ chars after normalization)
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  for (const t of ta) {
    if (tb.has(t)) intersection++
  }
  const union = ta.size + tb.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Check if two entity types are compatible for merging.
 * Prevents merging a person with a location, etc.
 * Generic types ("entity", "other", "") are compatible with anything.
 */
function typesCompatible(a: string, b: string): boolean {
  const GENERIC_TYPES = new Set(['entity', 'other', ''])
  return a === b || GENERIC_TYPES.has(a) || GENERIC_TYPES.has(b)
}

/**
 * Check if two entity names have conflicting distinguishing attributes.
 * Returns true if both strings contain tokens in the same category (years, versions,
 * ordinals) with zero intersection — meaning they refer to different instances of
 * the same type of thing (e.g., "1992 team" vs "1988 team").
 *
 * Returns false if either string has no distinguishing tokens in a category,
 * or if their token sets overlap (e.g., "1992 Dream Team" vs "1992 US team").
 */
/**
 * Stop-words excluded from token overlap check.
 * Includes common English function words plus frequently occurring but non-identifying
 * tokens in entity names (e.g., "United", "National", "American").
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
  'is', 'was', 'are', 'were', 'be', 'been',
  'new', 'old', 'united', 'national', 'international', 'american',
  'st', 'mr', 'mrs', 'dr', 'jr', 'sr',
])

/**
 * Check if two entity names share at least one meaningful (non-stop-word) token.
 * Primary deterministic defense against same-type-but-different-entity merges.
 *
 * Examples:
 *   "Toronto Raptors" vs "Oklahoma City Thunder" → false (no shared tokens)
 *   "Chris Mullin" vs "Christopher Paul Mullin" → true ("mullin" shared)
 *   "United States" vs "United Kingdom" → false ("united" is stop-word)
 */
export function hasSharedNameToken(a: string, b: string): boolean {
  const tokenize = (s: string): Set<string> => {
    const tokens = new Set<string>()
    for (const word of s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)) {
      if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.add(word)
    }
    return tokens
  }
  const ta = tokenize(a)
  const tb = tokenize(b)
  for (const t of ta) {
    if (tb.has(t)) return true
  }
  return false
}

/**
 * Check if two person names share a matching last token (surname guard).
 * Only applies when both names have 2+ tokens (first + last structure).
 * Single-word names bypass the check (e.g., "Madonna", "Chris").
 *
 * No suffix stripping: Jr./Sr./III are genuinely distinguishing tokens
 * that identify different people (father vs son, generational namesakes).
 *
 * Examples:
 *   ("Kevin Durant", "Kevin Love") → false (durant ≠ love)
 *   ("LeBron James", "James Harden") → false (james ≠ harden)
 *   ("LeBron James", "LeBron James Jr.") → false (james ≠ jr)
 *   ("Chris Mullin", "Christopher Paul Mullin") → true (mullin = mullin)
 *   ("Madonna", "Madonna Louise Ciccone") → true (1 token → bypass)
 */
export function hasMatchingLastToken(a: string, b: string): boolean {
  const tokenize = (s: string): string[] =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 2)
  const tokensA = tokenize(a)
  const tokensB = tokenize(b)
  // Only apply when both names have 2+ tokens (first + last structure)
  if (tokensA.length < 2 || tokensB.length < 2) return true
  return tokensA[tokensA.length - 1] === tokensB[tokensB.length - 1]
}

/**
 * Domain-agnostic opposing qualifier pairs. If name A contains a token from one
 * side and name B contains a token from the opposite side, they refer to distinct entities
 * (e.g., "Western Conference" vs "Eastern Conference").
 */
const OPPOSING_PAIRS: [Set<string>, Set<string>][] = [
  // Spatial / directional
  [new Set(['eastern', 'east']), new Set(['western', 'west'])],
  [new Set(['northern', 'north']), new Set(['southern', 'south'])],
  [new Set(['upper']), new Set(['lower'])],
  [new Set(['left']), new Set(['right'])],
  [new Set(['inner', 'interior']), new Set(['outer', 'exterior'])],
  [new Set(['front']), new Set(['back', 'rear'])],
  [new Set(['central']), new Set(['peripheral'])],
  [new Set(['inland']), new Set(['coastal'])],
  [new Set(['urban']), new Set(['rural'])],
  [new Set(['domestic']), new Set(['foreign', 'international'])],
  // Magnitude / ranking
  [new Set(['major']), new Set(['minor'])],
  [new Set(['greater', 'grand']), new Set(['lesser'])],
  [new Set(['senior', 'sr']), new Set(['junior', 'jr'])],
  [new Set(['primary']), new Set(['secondary'])],
  [new Set(['maximum', 'max']), new Set(['minimum', 'min'])],
  // Temporal
  [new Set(['ancient']), new Set(['modern'])],
  [new Set(['early']), new Set(['late'])],
  [new Set(['preceding', 'previous']), new Set(['following', 'subsequent'])],
  // Relational / categorical
  [new Set(['internal']), new Set(['external'])],
  [new Set(['public']), new Set(['private'])],
  [new Set(['formal']), new Set(['informal'])],
  [new Set(['active']), new Set(['passive'])],
  [new Set(['positive']), new Set(['negative'])],
  [new Set(['offensive', 'offense']), new Set(['defensive', 'defense'])],
  [new Set(['liberal']), new Set(['conservative'])],
  [new Set(['progressive']), new Set(['traditional'])],
  // Gender / demographic
  [new Set(['male', 'men', 'mens', 'boys']), new Set(['female', 'women', 'womens', 'girls'])],
  // Science / medical
  [new Set(['organic']), new Set(['inorganic'])],
  [new Set(['acute']), new Set(['chronic'])],
  [new Set(['benign']), new Set(['malignant'])],
]

export function hasConflictingDistinguishers(a: string, b: string): boolean {
  const yearPattern = /\b(1[89]\d{2}|20\d{2})\b/g
  const versionPattern = /\b(?:v|version)\s*(\d+(?:\.\d+)*)\b/gi
  const ordinalPattern = /\b(\d+(?:st|nd|rd|th))\b/gi

  const extract = (s: string, pattern: RegExp): Set<string> => {
    const matches = new Set<string>()
    for (const m of s.matchAll(pattern)) matches.add(m[1]!)
    return matches
  }

  const categories: [RegExp, RegExp][] = [
    [yearPattern, yearPattern],
    [versionPattern, versionPattern],
    [ordinalPattern, ordinalPattern],
  ]

  for (const [patA, patB] of categories) {
    const setA = extract(a, patA)
    const setB = extract(b, patB)
    // Both must have tokens in this category for a conflict to exist
    if (setA.size === 0 || setB.size === 0) continue
    // Conflict if zero intersection (completely disjoint sets)
    let hasOverlap = false
    for (const token of setA) {
      if (setB.has(token)) { hasOverlap = true; break }
    }
    if (!hasOverlap) return true
  }

  // Opposing qualifier pairs — tokenize both names and check cross-side matches
  const tokenizeForOpposing = (s: string): Set<string> => {
    const tokens = new Set<string>()
    for (const word of s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)) {
      if (word.length >= 2) tokens.add(word)
    }
    return tokens
  }
  const tokensA = tokenizeForOpposing(a)
  const tokensB = tokenizeForOpposing(b)

  for (const [sideOne, sideTwo] of OPPOSING_PAIRS) {
    const aHasSideOne = [...sideOne].some(t => tokensA.has(t))
    const aHasSideTwo = [...sideTwo].some(t => tokensA.has(t))
    const bHasSideOne = [...sideOne].some(t => tokensB.has(t))
    const bHasSideTwo = [...sideTwo].some(t => tokensB.has(t))

    // Conflict: A has one side and B has the other
    if ((aHasSideOne && bHasSideTwo) || (aHasSideTwo && bHasSideOne)) return true
  }

  return false
}
