import type { EmbeddingProvider } from '@d8um/core'
import type { d8umIdentity } from '@d8um/core'
import type { SemanticEntity } from '../types/memory.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import { createTemporal } from '../temporal.js'
import { randomUUID } from 'crypto'

// ── Entity Resolver ──
// Deduplicates entities using a 5-phase cascade:
//   Phase 0: In-memory session cache (instant)
//   Phase 1: Exact alias matching via DB ILIKE (cheapest DB call)
//   Phase 2: Normalized string matching (catches case/punctuation variants)
//   Phase 2.5: Fuzzy matching via trigram Jaccard (catches abbreviations/reorderings)
//   Phase 3: Vector similarity on name embeddings (catches semantic equivalents)

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
    this.threshold = config.similarityThreshold ?? 0.68
  }

  private cacheEntity(entity: SemanticEntity): void {
    this.nameCache.set(normalizeForComparison(entity.name), entity)
    for (const alias of entity.aliases) {
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
    scope: d8umIdentity,
    description?: string,
  ): Promise<{ entity: SemanticEntity; isNew: boolean }> {
    // Phase 0: In-memory cache (instant — catches all prior entities in this session)
    const normalizedName = normalizeForComparison(name)
    const cached = this.nameCache.get(normalizedName)
    if (cached) {
      const merged = this.merge(cached, { name, entityType, aliases, description })
      this.cacheEntity(merged)
      return { entity: merged, isNew: false }
    }
    // Also check aliases against cache
    for (const alias of aliases) {
      const cachedByAlias = this.nameCache.get(normalizeForComparison(alias))
      if (cachedByAlias) {
        const merged = this.merge(cachedByAlias, { name, entityType, aliases, description })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }
    }

    // Phase 1: Alias matching (cheap — uses ILIKE + ANY index)
    if (this.store.findEntities) {
      const candidates = await this.store.findEntities(name, scope, 10)
      const aliasMatch = this.findByAlias(name, aliases, candidates)
      if (aliasMatch) {
        const merged = this.merge(aliasMatch, { name, entityType, aliases, description })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }

      // Phase 2: Normalized string matching (catches case/punctuation variants)
      for (const candidate of candidates) {
        if (normalizeForComparison(candidate.name) === normalizedName) {
          const merged = this.merge(candidate, { name, entityType, aliases, description })
          this.cacheEntity(merged)
          return { entity: merged, isNew: false }
        }
        for (const alias of candidate.aliases) {
          if (normalizeForComparison(alias) === normalizedName) {
            const merged = this.merge(candidate, { name, entityType, aliases, description })
            this.cacheEntity(merged)
            return { entity: merged, isNew: false }
          }
        }
      }

      // Phase 2.5: Fuzzy matching via trigram Jaccard (catches abbreviations/reorderings)
      // e.g., "NY Times" vs "New York Times", "J.K. Rowling" vs "JK Rowling"
      const fuzzyMatch = this.findByFuzzy(name, aliases, entityType, candidates)
      if (fuzzyMatch) {
        const merged = this.merge(fuzzyMatch, { name, entityType, aliases, description })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }
    }

    // Phase 3: Vector similarity (uses pgvector similarity score directly — no re-embedding)
    let nameEmbedding: number[] | undefined
    if (this.store.searchEntities) {
      nameEmbedding = await this.embedding.embed(name)
      const similar = await this.store.searchEntities(nameEmbedding, scope, 5)

      for (const candidate of similar) {
        // Type guard: don't merge entities with conflicting specific types
        if (!typesCompatible(entityType, candidate.entityType)) continue

        // Use pgvector's cosine similarity score (stashed by adapter) instead of re-embedding
        const similarity = (candidate.properties._similarity as number | undefined)
          ?? this.cosineSimilarity(nameEmbedding, candidate.embedding ?? [])
        if (similarity >= this.threshold) {
          const merged = this.merge(candidate, { name, entityType, aliases, description })
          this.cacheEntity(merged)
          return { entity: merged, isNew: false }
        }
      }
    }

    // No match found - create new entity (reuse embedding from Phase 3 if available)
    if (!nameEmbedding) {
      nameEmbedding = await this.embedding.embed(name)
    }
    const entity: SemanticEntity = {
      id: randomUUID(),
      name,
      entityType,
      aliases,
      properties: description ? { description } : {},
      embedding: nameEmbedding,
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
    candidates: SemanticEntity[],
  ): SemanticEntity | undefined {
    const nameLower = name.toLowerCase()
    const aliasesLower = aliases.map(a => a.toLowerCase())

    for (const candidate of candidates) {
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
  merge(
    existing: SemanticEntity,
    incoming: { name: string; entityType: string; aliases: string[]; description?: string | undefined },
  ): SemanticEntity {
    const existingAliases = new Set(existing.aliases.map(a => a.toLowerCase()))
    const newAliases = [...existing.aliases]

    // Add the incoming name as an alias if different from canonical
    if (incoming.name.toLowerCase() !== existing.name.toLowerCase()) {
      if (!existingAliases.has(incoming.name.toLowerCase())) {
        newAliases.push(incoming.name)
      }
    }

    // Add new aliases
    for (const alias of incoming.aliases) {
      if (!existingAliases.has(alias.toLowerCase()) && alias.toLowerCase() !== existing.name.toLowerCase()) {
        newAliases.push(alias)
      }
    }

    // Merge descriptions: accumulate unique descriptions from different chunks
    const properties = { ...existing.properties }
    if (incoming.description) {
      const existingDesc = properties.description as string | undefined
      if (!existingDesc) {
        properties.description = incoming.description
      } else if (!existingDesc.includes(incoming.description)) {
        // Append new description if it's not already contained
        properties.description = `${existingDesc} ${incoming.description}`
      }
    }

    return {
      ...existing,
      aliases: newAliases,
      properties,
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
    const FUZZY_THRESHOLD = 0.7
    const incomingNames = [name, ...aliases]

    for (const candidate of candidates) {
      if (!typesCompatible(entityType, candidate.entityType)) continue
      const candidateNames = [candidate.name, ...candidate.aliases]

      for (const a of incomingNames) {
        for (const b of candidateNames) {
          if (trigramJaccard(a, b) >= FUZZY_THRESHOLD) {
            return candidate
          }
        }
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
