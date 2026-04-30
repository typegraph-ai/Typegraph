import { z } from 'zod/v4-mini'
import type { LLMProvider } from '../types/llm-provider.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { Visibility } from '../types/typegraph-document.js'
import { getPredicatesForPrompt } from './ontology.js'

export interface TripleExtractorConfig {
  /** LLM for entity extraction (Pass 1 in two-pass mode) or the single combined call. */
  llm: LLMProvider
  /** LLM for relationship extraction (Pass 2 in two-pass mode). Falls back to llm. */
  relationshipLlm?: LLMProvider | undefined
  graph: KnowledgeGraphBridge
  /** Use two separate LLM calls (entities then relationships) instead of one combined call. Default: true. */
  twoPass?: boolean | undefined
}

// ── Types ──

interface ExtractedEntity {
  name: string
  type: string
  description: string
  aliases: string[]
}

interface ExtractedRelationship {
  subject: string
  predicate: string
  object: string
  confidence: number
  description?: string | undefined
  evidenceText?: string | undefined
}

interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
}

/** Lightweight entity context passed between chunks for cross-chunk resolution. */
export interface EntityContext {
  name: string
  type: string
}

// ── Entity types ──

const ENTITY_TYPES = [
  'person', 'organization', 'location', 'product', 'concept', 'event',
  'work_of_art', 'technology', 'law_regulation', 'time_period',
] as const

const VALID_ENTITY_TYPES = new Set<string>(ENTITY_TYPES)

const ENTITY_TYPES_LIST = ENTITY_TYPES.join(', ')

// ── Zod schemas for structured output ──

const entitySchema = z.array(z.object({
  name: z.string(),
  type: z.enum(ENTITY_TYPES),
  description: z.string(),
  aliases: z.array(z.string()),
}))

const relationshipSchema = z.array(z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number(),
  description: z.optional(z.string()),
  evidenceText: z.optional(z.string()),
}))

const singlePassSchema = z.object({
  entities: entitySchema,
  relationships: relationshipSchema,
})

function sanitizeText(value: string): string {
  return sanitizeInvalidSurrogates(value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' '))
}

function sanitizeInvalidSurrogates(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += value.charAt(i) + value.charAt(i + 1)
        i++
      } else {
        out += '\uFFFD'
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      out += '\uFFFD'
    } else {
      out += value[i]
    }
  }
  return out
}

function sanitizeField(value: string): string {
  return sanitizeText(value).replace(/\s+/g, ' ').trim()
}

function normalizeName(value: string): string {
  return sanitizeField(value)
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function nameTokens(value: string): string[] {
  return normalizeName(value).split(/\s+/).filter(Boolean)
}

function wordCount(value: string): number {
  const normalized = normalizeName(value)
  return normalized ? normalized.split(/\s+/).length : 0
}

function lastToken(value: string): string {
  const tokens = normalizeName(value).split(/\s+/).filter(Boolean)
  return tokens[tokens.length - 1] ?? ''
}

const COMMON_FIRST_NAMES = new Set([
  'alice', 'anne', 'anna', 'bertha', 'bill', 'bob', 'charles', 'david', 'edmund',
  'elizabeth', 'frank', 'george', 'harry', 'henry', 'jack', 'james', 'john',
  'mary', 'michael', 'nancy', 'paul', 'peter', 'rose', 'sam', 'sarah', 'steve',
  'thomas', 'william',
])

const MONONYM_ALLOWLIST = new Set([
  'aristotle', 'caesar', 'cicero', 'homer', 'madonna', 'napoleon', 'plato',
  'socrates', 'voltaire',
])

const ALIAS_LEADING_FRAGMENT_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'because', 'before', 'but', 'by', 'for',
  'from', 'if', 'in', 'now', 'of', 'on', 'or', 'since', 'so', 'that', 'then',
  'there', 'therefore', 'these', 'this', 'those', 'though', 'to', 'when',
  'where', 'while', 'with',
])

const ALIAS_GREETING_WORDS = new Set(['hi', 'hello', 'hey', 'dear'])
const ALIAS_IMPERATIVE_WORDS = new Set(['inform', 'ask', 'tell', 'cc', 'tag', 'notify', 'ping'])
const ALIAS_QUANTIFIER_WORDS = new Set(['both', 'all', 'either', 'neither'])
const PERSON_TITLE_TOKENS = new Set([
  'captain', 'cousin', 'doctor', 'dr', 'judge', 'lady', 'lord', 'miss',
  'mr', 'mrs', 'ms', 'queen', 'saint', 'sir', 'st',
])

function isBadAliasFragment(value: string): boolean {
  const tokens = normalizeName(value).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  if (ALIAS_GREETING_WORDS.has(tokens[0]!)) return true
  if (ALIAS_IMPERATIVE_WORDS.has(tokens[0]!)) return true
  if (ALIAS_QUANTIFIER_WORDS.has(tokens[0]!)) return true
  if (/['’]s\b/i.test(value)) return true
  if (/https?:\/\/|www\.|@.+\..+/.test(value)) return true
  return false
}

function hasSentenceBoundaryInsideAlias(value: string): boolean {
  const withoutInitials = value.replace(/\b[A-Z]\.\s*/g, '')
  return /[.!?]|--|—|–/.test(withoutInitials)
}

function isModeratePersonAlias(alias: string): boolean {
  const cleaned = sanitizeField(alias)
  if (!cleaned || cleaned.length > 80) return false
  if (isBadAliasFragment(cleaned)) return false
  if (hasSentenceBoundaryInsideAlias(cleaned)) return false

  const tokens = normalizeName(cleaned).split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > 5) return false
  if (ALIAS_LEADING_FRAGMENT_WORDS.has(tokens[0]!)) return false
  return true
}

function extractLocationSurfaceForms(content: string): string[] {
  const forms = new Set<string>()
  const re = /\b([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2},\s+[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2})\b/gu
  for (const match of content.matchAll(re)) {
    const value = sanitizeField(match[1]!)
    if (value.length > 2 && value.length <= 80) forms.add(value)
  }
  return [...forms]
}

function addUniqueAlias(aliases: string[], alias: string, canonicalName: string): void {
  const cleaned = sanitizeField(alias)
  if (!cleaned || cleaned.length > 80) return
  if (normalizeName(cleaned) === normalizeName(canonicalName)) return
  if (aliases.some(a => normalizeName(a) === normalizeName(cleaned))) return
  aliases.push(cleaned)
}

function initialsForName(value: string): string[] {
  return nameTokens(value)
    .filter(token => !PERSON_TITLE_TOKENS.has(token))
    .map(token => token[0]!)
    .filter(Boolean)
}

function looksLikeInitialism(value: string): boolean {
  const matches = [...value.matchAll(/\b([A-Z])\.?/g)]
  return matches.length >= 2
}

function aliasInitialsMatchOwner(alias: string, ownerName: string): boolean {
  if (!looksLikeInitialism(alias)) return false
  const aliasInitials = [...alias.matchAll(/\b([A-Z])\.?/g)].map(match => match[1]!.toLowerCase())
  const ownerInitials = initialsForName(ownerName)
  return aliasInitials.length > 0
    && aliasInitials.length <= ownerInitials.length
    && aliasInitials.every((initial, index) => ownerInitials[index] === initial)
}

function isHeadingLikeAlias(alias: string): boolean {
  const cleaned = sanitizeField(alias)
  if (!cleaned) return true
  if (/^(?:chapter|book|part|section)\b/i.test(cleaned)) return true
  const letters = cleaned.replace(/[^A-Za-z]/g, '')
  return letters.length >= 6 && cleaned === cleaned.toUpperCase()
}

function aliasSentenceCandidates(content: string): string[] {
  return content
    .split(/(?<=[.!?;])\s+/)
    .map(part => sanitizeField(part))
    .filter(Boolean)
}

function extractExplicitPersonAliases(entity: ExtractedEntity, content: string): string[] {
  const cuePattern = /\b(?:known as|called|calling himself|calling herself|calling themselves|aka|alias|under the name|went by|styled himself|styled herself)\b/i
  const aliasPattern = /\b(?:known as|called|calling himself|calling herself|calling themselves|aka|alias|under the name|went by|styled himself|styled herself)\s+((?:[A-Z][\p{L}'’.-]*\.?)(?:\s+(?:[A-Z][\p{L}'’.-]*\.?)){0,4})/gu
  const references = [
    normalizeName(entity.name),
    ...entity.aliases.map(normalizeName),
    normalizeName(lastToken(entity.name)),
  ].filter(Boolean)

  const aliases: string[] = []
  for (const sentence of aliasSentenceCandidates(content)) {
    const normalizedSentence = normalizeName(sentence)
    if (!cuePattern.test(sentence)) continue
    if (!references.some(reference => normalizedSentence.includes(reference))) continue
    for (const match of sentence.matchAll(aliasPattern)) {
      addUniqueAlias(aliases, match[1]!, entity.name)
    }
  }
  return aliases
}

interface PersonAliasContext {
  name: string
  normalizedName: string
  tokens: string[]
  givenTokens: string[]
  surname: string
}

function buildPersonAliasContexts(entities: ExtractedEntity[]): PersonAliasContext[] {
  return entities
    .filter(entity => entity.type === 'person')
    .map(entity => {
      const tokens = nameTokens(entity.name)
      return {
        name: entity.name,
        normalizedName: normalizeName(entity.name),
        tokens,
        givenTokens: tokens.slice(0, -1).filter(token => !PERSON_TITLE_TOKENS.has(token)),
        surname: tokens[tokens.length - 1] ?? '',
      }
    })
}

function hasCompatibleGivenNameEvidence(aliasTokens: string[], ownerTokens: string[]): boolean {
  const filteredAliasTokens = aliasTokens.filter(token => !PERSON_TITLE_TOKENS.has(token))
  const filteredOwnerTokens = ownerTokens.filter(token => !PERSON_TITLE_TOKENS.has(token))
  if (filteredAliasTokens.length === 0 || filteredOwnerTokens.length === 0) return false

  return filteredAliasTokens.every((token, index) => {
    const ownerToken = filteredOwnerTokens[index]
    if (!ownerToken) return false
    if (token === ownerToken) return true
    return token.length === 1 ? ownerToken.startsWith(token) : token.startsWith(ownerToken) || ownerToken.startsWith(token)
  })
}

function titleCompatibleWithOwner(aliasTokens: string[], owner: PersonAliasContext): boolean {
  const aliasTitle = aliasTokens.find(token => PERSON_TITLE_TOKENS.has(token))
  if (!aliasTitle) return false
  const ownerTitle = owner.tokens.find(token => PERSON_TITLE_TOKENS.has(token))
  if (!ownerTitle) return aliasTitle === 'cousin' || aliasTitle === 'doctor' || aliasTitle === 'dr'
  return aliasTitle === ownerTitle
}

function isEntityAwarePersonAlias(
  alias: string,
  owner: PersonAliasContext,
  people: PersonAliasContext[],
  explicitAliasKeys: Set<string>,
  candidateAliases: string[],
): boolean {
  if (!isModeratePersonAlias(alias)) return false
  if (isHeadingLikeAlias(alias)) return false

  const aliasKey = normalizeName(alias)
  if (!aliasKey || aliasKey === owner.normalizedName) return false

  const aliasTokens = nameTokens(alias)
  if (aliasTokens.length === 0) return false

  const explicitCue = explicitAliasKeys.has(aliasKey)

  if (!explicitCue) {
    const collidesWithOtherPerson = people.some(person =>
      person.normalizedName === aliasKey && person.normalizedName !== owner.normalizedName
    )
    if (collidesWithOtherPerson) return false
  }

  if (aliasInitialsMatchOwner(alias, owner.name)) return true

  const surnameCounts = new Map<string, number>()
  for (const person of people) {
    if (!person.surname) continue
    surnameCounts.set(person.surname, (surnameCounts.get(person.surname) ?? 0) + 1)
  }

  if (aliasTokens.length === 1) {
    const aliasToken = aliasTokens[0]!
    if (aliasToken === owner.surname) {
      return (surnameCounts.get(owner.surname) ?? 0) === 1
    }

    const bridgesFullAlias = candidateAliases.some(otherAlias => {
      if (normalizeName(otherAlias) === aliasKey) return false
      const otherTokens = nameTokens(otherAlias)
      return otherTokens.length >= 2 && otherTokens[otherTokens.length - 1] === aliasToken
    })
    if (bridgesFullAlias) return true

    const collidesWithOtherGivenName = people.some(person =>
      person.normalizedName !== owner.normalizedName
      && hasCompatibleGivenNameEvidence([aliasToken], person.givenTokens)
    )
    if (collidesWithOtherGivenName) return false

    return !COMMON_FIRST_NAMES.has(aliasToken) && hasCompatibleGivenNameEvidence([aliasToken], owner.givenTokens)
  }

  const aliasSurname = aliasTokens[aliasTokens.length - 1]!
  const aliasGivenTokens = aliasTokens.slice(0, -1)

  if (aliasSurname === owner.surname) {
    if (aliasGivenTokens.length === 0) {
      return (surnameCounts.get(owner.surname) ?? 0) === 1
    }
    if (aliasGivenTokens.length === 1 && PERSON_TITLE_TOKENS.has(aliasGivenTokens[0]!)) {
      return titleCompatibleWithOwner(aliasTokens, owner) && (surnameCounts.get(owner.surname) ?? 0) === 1
    }
    return hasCompatibleGivenNameEvidence(aliasGivenTokens, owner.givenTokens)
  }

  if (
    aliasTokens.length === 2
    && PERSON_TITLE_TOKENS.has(aliasTokens[0]!)
    && hasCompatibleGivenNameEvidence([aliasTokens[1]!], owner.givenTokens)
  ) {
    return titleCompatibleWithOwner(aliasTokens, owner)
  }

  return explicitCue
}

function refinePersonAliases(
  entity: ExtractedEntity,
  people: PersonAliasContext[],
  content: string,
): string[] {
  const owner = people.find(person => person.normalizedName === normalizeName(entity.name))
  if (!owner) return []

  const aliases = [...entity.aliases]
  for (const explicitAlias of extractExplicitPersonAliases(entity, content)) {
    addUniqueAlias(aliases, explicitAlias, entity.name)
  }
  const explicitAliasKeys = new Set(extractExplicitPersonAliases(entity, content).map(alias => normalizeName(alias)))

  return [...new Map(aliases
    .filter(alias => isEntityAwarePersonAlias(alias, owner, people, explicitAliasKeys, aliases))
    .map(alias => [normalizeName(alias), alias])).values()]
}

function augmentLocationAliases(entity: ExtractedEntity, content: string): void {
  if (wordCount(entity.name) !== 1) return
  const entityKey = normalizeName(entity.name)
  for (const form of extractLocationSurfaceForms(content)) {
    if (normalizeName(form).startsWith(`${entityKey} `)) {
      addUniqueAlias(entity.aliases, form, entity.name)
    }
  }
}

function promoteOrRejectEntity(entity: ExtractedEntity): ExtractedEntity | undefined {
  if (entity.type === 'person' && wordCount(entity.name) === 1) {
    const key = normalizeName(entity.name)
    const betterAlias = entity.aliases
      .filter(a => wordCount(a) >= 2 && normalizeName(a).split(/\s+/).includes(key))
      .sort((a, b) => b.length - a.length)[0]
    if (betterAlias) {
      const oldName = entity.name
      entity.name = betterAlias
      entity.aliases = entity.aliases.filter(a => normalizeName(a) !== normalizeName(betterAlias))
      addUniqueAlias(entity.aliases, oldName, entity.name)
    } else if (COMMON_FIRST_NAMES.has(key) && !MONONYM_ALLOWLIST.has(key)) {
      return undefined
    }
  }

  if (entity.type === 'location' && wordCount(entity.name) === 1) {
    const key = normalizeName(entity.name)
    const betterAlias = entity.aliases
      .filter(a => normalizeName(a).startsWith(`${key} `) && /,/.test(a))
      .sort((a, b) => b.length - a.length)[0]
    if (betterAlias) {
      const oldName = entity.name
      entity.name = betterAlias
      entity.aliases = entity.aliases.filter(a => normalizeName(a) !== normalizeName(betterAlias))
      addUniqueAlias(entity.aliases, oldName, entity.name)
    }
  }

  return entity
}

function postProcessExtraction(
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[],
  content: string,
): ExtractionResult {
  const processed: ExtractedEntity[] = []
  const rawNameToCanonical = new Map<string, string>()

  for (const raw of entities) {
    const entity: ExtractedEntity = {
      name: sanitizeField(raw.name ?? ''),
      type: sanitizeField(raw.type ?? ''),
      description: sanitizeField(raw.description ?? ''),
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(sanitizeField).filter(Boolean) : [],
    }
    if (!entity.name || !VALID_ENTITY_TYPES.has(entity.type)) continue

    if (entity.type === 'person') {
      entity.aliases = entity.aliases.filter(isModeratePersonAlias)
    } else {
      entity.aliases = entity.aliases.filter(alias => !isBadAliasFragment(alias))
    }

    if (entity.type === 'location') augmentLocationAliases(entity, content)

    const promoted = promoteOrRejectEntity(entity)
    if (!promoted) continue

    promoted.aliases = [...new Map(promoted.aliases.map(a => [normalizeName(a), a])).values()]
      .filter(alias => normalizeName(alias) !== normalizeName(promoted.name))

    processed.push(promoted)
    const rawName = normalizeName(raw.name ?? '')
    if (rawName) rawNameToCanonical.set(rawName, promoted.name)
  }

  const personContexts = buildPersonAliasContexts(processed)
  for (const entity of processed) {
    if (entity.type !== 'person') continue
    entity.aliases = refinePersonAliases(entity, personContexts, content)
      .filter(alias => normalizeName(alias) !== normalizeName(entity.name))
  }

  const nameMap = new Map<string, string>()
  for (const entity of processed) {
    nameMap.set(normalizeName(entity.name), entity.name)
    for (const alias of entity.aliases) nameMap.set(normalizeName(alias), entity.name)
  }
  for (const [rawName, canonicalName] of rawNameToCanonical) {
    if (!nameMap.has(rawName)) nameMap.set(rawName, canonicalName)
  }

  const sanitizedRelationships: ExtractedRelationship[] = []
  for (const rel of relationships) {
    const subject = nameMap.get(normalizeName(rel.subject ?? ''))
    const object = nameMap.get(normalizeName(rel.object ?? ''))
    const predicate = sanitizeField(rel.predicate ?? '')
      .replace(/[\s-]+/g, '_')
      .toUpperCase()
    if (!subject || !object || !predicate) continue
    sanitizedRelationships.push({
      subject,
      predicate,
      object,
      confidence: typeof rel.confidence === 'number' ? rel.confidence : 1,
      description: sanitizeField(rel.description ?? ''),
      evidenceText: sanitizeField(rel.evidenceText ?? ''),
    })
  }

  return { entities: processed, relationships: sanitizedRelationships }
}

// ── Single-pass prompt (default) ──

function buildSinglePassPrompt(content: string, entityContext?: EntityContext[], documentTitle?: string): string {
  const contextSection = entityContext?.length
    ? `\nPreviously identified entities in this document:\n${entityContext.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nUse these names as canonical entities when the text refers to them by pronoun, abbreviation, surname, title, epithet, or pseudonym. Preserve any newly observed surface form as an alias instead of creating a duplicate entity.\n`
    : ''
  const titleSection = documentTitle
    ? `\nThe text string is from a document titled: "${documentTitle}". Entities referenced in the title should be extracted as primary entities using their full formal names.\n`
    : ''

  return `Your task is to extract all named entities, and relationships between them, from a text string.

${contextSection}${titleSection}

## Step 1: Entity Extraction

For each entity, provide:
- "name": The most complete, formal name of the entity that is supported by the text or prior entity context. Always use full proper names — NOT surnames, first names, nicknames, shortened forms, or abbreviations alone. Examples across domains:
  People: "Stephen Curry" not "Curry"; "Barack Obama" not "Obama"; "Marie Curie" not "Curie"; "Ada Lovelace" not "Lovelace"; "Cole Conway" not "Conway" when the full form appears
  Organizations: "Goldman Sachs Group" not "Goldman"; "European Central Bank" not "ECB"; "Massachusetts Institute of Technology" not "MIT"; "World Health Organization" not "WHO"
  Technology: "Amazon Web Services" not "AWS"; "React Native" not "React"; "PostgreSQL" not "Postgres"; "Large Language Model" not "LLM" (when first introduced)
  Locations: "San Francisco Bay Area" not "Bay Area"; "United Kingdom" not "UK"; "Silicon Valley" not "the Valley"; "Paducah, Kentucky" not "Paducah" when the full form appears; do not invent a state/country if the text does not provide one
  Events: "2024 United States presidential election" not "the election"; "1984 Summer Olympics" not "1984 games"; "CES 2025" not "CES"; "World War II" not "the war"
  Legal/Science: "General Data Protection Regulation" not "GDPR"; "Clean Air Act of 1970" not "Clean Air Act"; "Hubble Space Telescope" not "Hubble"; "CRISPR-Cas9" not "CRISPR"
  Products: "iPhone 16 Pro Max" not "iPhone"; "Tesla Model 3" not "Model 3"; "GPT-4" not "GPT"
  Culture: "Naismith Memorial Basketball Hall of Fame" not "Hall of Fame"; "Academy Award for Best Picture" not "Best Picture"; "The Great Gatsby" not "Gatsby"
- "type": One of: ${ENTITY_TYPES_LIST}
- "description": A one-sentence description of what this entity IS — its defining attributes, NOT its relationships to other entities
- "aliases": Other proper names, abbreviations, pseudonyms, titles, or stable short references for THIS SAME entity in the text (array of strings). Preserve the exact surface forms that appear in the source text.
  Valid aliases: "NYC" for "New York City", "WHO" for "World Health Organization", "The Iron Lady" for "Margaret Thatcher", "Python" for "Python programming language", "Cole Conway" and "Conway" for "Cousin Cæsar" when the text says he is calling himself Cole Conway and later refers to him as Conway
  NEVER include as aliases:
  - Pronouns or pronoun phrases (he, she, it, they, them, we, his, her, its)
  - Generic references (the team, the roster, the company, the city, the league, the organization, the event, the protocol, the framework, the ingredient)
  - Surnames or first names alone as canonical entity names (Curry, Obama, Kevin, Marie). A bare surname may be an alias only when the same passage or prior context clearly ties it to a full person entity, e.g. "Conway" after "Cole Conway"
  - Names of DIFFERENT entities — "FIBA Hall of Fame" and "Naismith Hall of Fame" are SEPARATE entities; "React" and "React Native" are SEPARATE; "Python 2" and "Python 3" are SEPARATE
  - Descriptive phrases (the American team, the defending champions, the former president, the lead researcher, the main ingredient)
  - Country/city names for their teams — "France" is NOT an alias of "France men's national basketball team"; "Brazil" is NOT an alias of "Brazil national football team"
  - Shortened generic forms — "Finals" is NOT an alias of "NBA Finals"; "MVP" is NOT an alias of any specific MVP award; "Olympics" is NOT an alias of "2024 Summer Olympics"

Entity rules:
- Extract a MAXIMUM of 15 entities. When the text contains more potential entities, prioritize:
  1. Primary subjects — entities the text is primarily ABOUT, not merely mentioned
  2. Entities with explicit relationships — entities that have stated connections to other entities in the text
  3. Specific over generic — prefer "2006 FIBA World Championship" over "basketball"
  4. Actors over settings — prefer entities that DO things over entities that are merely locations or backdrops
- Omit entities that appear only in lists, parenthetical asides, or as minor supporting context with no described relationships.
- Only extract specific named entities — NOT dates, dollar amounts, percentages, or generic descriptions
- Exception: when the text directly states a named person's or organization's profession, office, or role, extract that role label as a "concept" entity so it can participate in a structured relationship. Examples: "doctor", "pilot", "house surgeon"
- If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list the proper name variants as aliases — NOT the generic reference
- Include important entities even if they only appear once
- Preserve complete person surface forms exactly when present. If the text says a person is "calling himself Cole Conway" or "known as Cole Conway", include "Cole Conway" as the entity name or alias — not only "Conway".
- For people, prefer complete first+last names, titled names, and pseudonyms over bare first names or surnames.
- Never create a standalone PERSON entity from a bare first name or surname when a fuller person name appears in the text or prior context. Promote it to the fuller entity and store the bare form as an alias only if it is clearly used as a reference.
- Treat "called", "calling himself", "known as", "alias", "under the name", "styled himself", and "went by" constructions as alias evidence for the same entity unless the text clearly describes two different people.
- Do not add a shared family surname as an alias when several related people use that surname. For example, "Simon" alone is not a safe alias for "Cæsar Simon" when "S. S. Simon" or "Young Simon" may also appear.
- For locations, use the fullest location span stated in the text. If the source says "Paducah, Kentucky" or "Cairo, Egypt", the entity name should include the qualifier; the bare city may be an alias. Do not invent missing qualifiers.
- Reject generic, low-information entities such as "Bill", "Bertha", "Coffee", "College Avenue", "the Queen", "the city", or "the old man" unless the text clearly establishes that exact phrase as a specific named entity.
- For events, awards, seasons, software versions, product generations, or any time/version-specific entities, ALWAYS include the year, version, or edition in the name. Each distinct occurrence is a SEPARATE entity — e.g., "2023 NBA Finals" and "2024 NBA Finals" are different, "Python 2" and "Python 3" are different, "iPhone 15" and "iPhone 16" are different, "HTTP/1.1" and "HTTP/2" are different, "Michelin Guide 2024" and "Michelin Guide 2025" are different.
- Different awards are ALWAYS separate entities even when they share words — "NBA Finals MVP" and "NBA MVP" are SEPARATE; "Academy Award for Best Picture" and "Academy Award for Best Director" are SEPARATE; "Nobel Peace Prize" and "Nobel Prize in Physics" are SEPARATE
- Entities with opposing directional or categorical qualifiers are ALWAYS separate — "Western Conference" and "Eastern Conference" are SEPARATE; "North Atlantic Treaty Organization" and "South Asian Association" are SEPARATE; "Upper Egypt" and "Lower Egypt" are SEPARATE
- Profession and role statements should become structured edges when supported by the text. Examples: "Steve Sharp, a pilot by profession" → Steve Sharp WORKS_AS pilot; "Elsie Inglis was a doctor" → Elsie Inglis WORKS_AS doctor; "She served as a house surgeon" → person HELD_ROLE house surgeon

CRITICAL — Aliases vs. Relationships:
- An ALIAS is a different name for THE SAME entity (e.g., "NYC" is an alias for "New York City")
- A RELATIONSHIP connects TWO DIFFERENT entities (e.g., "NBA" and "Los Angeles Lakers" are connected by MEMBER_OF — "Lakers" is NOT an alias of "NBA")
- NEVER list a related entity as an alias. If "Kevin Durant" appears in text about "Brooklyn Nets", they are SEPARATE entities connected by a relationship
- NEVER create a relationship between an entity and its own alias. If "Cousin Cæsar" is "calling himself Cole Conway", put "Cole Conway" in aliases; do not emit "Cousin Cæsar KNOWN_AS Cole Conway" as a relationship between two entity nodes.
- Test: Could you replace one name with the other in any sentence and preserve meaning? If yes → alias. If no → separate entities with a relationship

## Step 2: Relationship Extraction

For each relationship between the entities you identified, provide:
- "subject": Must be one of the entity names from Step 1
- "predicate": A canonical relationship verb from the vocabulary below
- "object": Must be one of the entity names from Step 1
- "confidence": How confident you are (0.0 to 1.0)
- "description": One standalone sentence describing the relationship as a complete fact. It must be understandable without the source text.
- "evidenceText": A concise source-backed excerpt or paraphrase that justifies the relationship. Keep it short; do not include full paragraphs.

${getPredicatesForPrompt()}

Relationship rules:
- Subject and object MUST be entities from Step 1 — do not introduce new entities
- Use ONLY predicates from the vocabulary above. Do not invent relation names; omit the relationship if no predicate fits.
- Preserve logical direction. Passive voice must be converted to the active graph direction: "X was killed by Y" becomes Y KILLED X; "X was founded by Y" becomes Y FOUNDED X.
- Use MARRIED for spouse, husband, wife, wed, or married relationships. Do not emit HUSBAND_OF, WIFE_OF, SPOUSE_OF, or MARRIED_TO.
- Use PARENT_OF for father/mother/parent relationships, CHILD_OF for son/daughter/child relationships, and SIBLING_OF for brother/sister/sibling relationships.
- Do not emit inverse predicates that are not in the vocabulary, such as KILLED_BY, FOUNDED_BY, WRITTEN_BY, OWNED_BY, or DESIGNED_BY. Swap subject and object instead.
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN")
- Use the most specific predicate that accurately captures the relationship
- Extract relationships that are explicitly stated or strongly implied in the text
- Do not emit self-relationships or alias relationships. Relationships are only for two different entities after alias resolution.
- Prefer relationship descriptions that preserve the source's important names, dates, places, objects, and negation.

## Example

Text: "Cousin Cæsar was born to Nancy Wade in West Tennessee and grew up under the care of Big-sis. At twenty years of age we find Cousin Cæsar in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp; they were partners in the game, as they called it. Sharp, a pilot by profession, had purchased the cards, while Conway dealt in the back room of a saloon. Earlier, Rob Roy cut wood for Old Smith on a farm near the Tennessee River."

Output:
{"entities": [
  {"name": "Cousin Cæsar", "type": "person", "description": "A man born to Nancy Wade in West Tennessee who later uses the name Cole Conway in Paducah, Kentucky", "aliases": ["Cole Conway", "Conway"]},
  {"name": "Nancy Wade", "type": "person", "description": "Mother of Cousin Cæsar", "aliases": []},
  {"name": "Big-sis", "type": "person", "description": "Caretaker of Cousin Cæsar during childhood", "aliases": []},
  {"name": "Steve Sharp", "type": "person", "description": "Pilot and partner of Cousin Cæsar in the card game", "aliases": ["Sharp"]},
  {"name": "pilot", "type": "concept", "description": "A profession practiced by Steve Sharp", "aliases": []},
  {"name": "Paducah, Kentucky", "type": "location", "description": "City in Kentucky where Cousin Cæsar uses the name Cole Conway", "aliases": ["Paducah"]},
  {"name": "West Tennessee", "type": "location", "description": "Region where Cousin Cæsar was born", "aliases": []},
  {"name": "Rob Roy", "type": "person", "description": "Wood cutter who worked for Old Smith", "aliases": ["Roy"]},
  {"name": "Old Smith", "type": "person", "description": "Farm owner near the Tennessee River who employed Rob Roy", "aliases": ["Smith"]},
  {"name": "Tennessee River", "type": "location", "description": "River near Old Smith's farm", "aliases": []}
], "relationships": [
  {"subject": "Cousin Cæsar", "predicate": "CHILD_OF", "object": "Nancy Wade", "confidence": 0.95, "description": "Cousin Cæsar was born to Nancy Wade.", "evidenceText": "Cousin Cæsar was born to Nancy Wade"},
  {"subject": "Cousin Cæsar", "predicate": "BORN_IN", "object": "West Tennessee", "confidence": 0.95, "description": "Cousin Cæsar was born in West Tennessee.", "evidenceText": "born to Nancy Wade in West Tennessee"},
  {"subject": "Cousin Cæsar", "predicate": "TRAVELED_TO", "object": "Paducah, Kentucky", "confidence": 0.85, "description": "Cousin Cæsar later went to Paducah, Kentucky.", "evidenceText": "we find Cousin Cæsar in Paducah, Kentucky"},
  {"subject": "Cousin Cæsar", "predicate": "COLLABORATED_WITH", "object": "Steve Sharp", "confidence": 0.95, "description": "Cousin Cæsar and Steve Sharp were partners in a card game.", "evidenceText": "in company with one Steve Sharp; they were partners"},
  {"subject": "Steve Sharp", "predicate": "WORKS_AS", "object": "pilot", "confidence": 0.9, "description": "Steve Sharp worked as a pilot.", "evidenceText": "Sharp, a pilot by profession"},
  {"subject": "Old Smith", "predicate": "EMPLOYED", "object": "Rob Roy", "confidence": 0.9, "description": "Old Smith employed Rob Roy to cut wood.", "evidenceText": "Rob Roy cut wood for Old Smith"}
]}

## Self-review

After your initial extraction, review: did you miss any entities or relationships that are explicitly stated or strongly implied? Include them.

Return a JSON object: {"entities": [...], "relationships": [...]}

Text:
${content}`
}

// ── Two-pass prompts ──

function buildEntityExtractionPrompt(content: string, entityContext?: EntityContext[], documentTitle?: string): string {
  const contextSection = entityContext?.length
    ? `\nPreviously identified entities in the text string:\n${entityContext.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nUse these names as canonical entities when the text refers to them by pronoun, abbreviation, surname, title, epithet, or pseudonym. Preserve any newly observed surface form as an alias instead of creating a duplicate entity.\n`
    : ''
  const titleSection = documentTitle
    ? `\nThe text string is from a document titled: "${documentTitle}". Entities referenced in the title should be extracted as primary entities using their full formal and canonical names.\n`
    : ''

    return `Your task is to extract all named entities from a text string.

    <TASK_INSTRUCTIONS>
    
    For each entity, provide:
    
    - "name": The most complete, formal and canonical name of the entity that is supported by the text or prior entity context. Always use full proper names — NOT surnames, first names, nicknames, shortened forms, or abbreviations alone. Examples across domains:
    -- People: "Stephen Curry" not "Curry"; "Barack Obama" not "Obama"; "Marie Curie" not "Curie"; "Ada Lovelace" not "Lovelace"; "Cole Conway" not "Conway" when the full form appears
    -- Organizations: "Goldman Sachs Group" not "Goldman"; "European Central Bank" not "ECB"; "Massachusetts Institute of Technology" not "MIT"; "World Health Organization" not "WHO"; "Apple Inc." not "Apple"
    -- Technology: "Amazon Web Services" not "AWS"; "React Native" not "React"; "PostgreSQL" not "Postgres"; "Large Language Model" not "LLM" (when first introduced)
    -- Locations: "San Francisco Bay Area" not "Bay Area"; "United Kingdom" not "UK"; "Silicon Valley" not "the Valley"; "Paducah, Kentucky" not "Paducah" when the full form appears; do not invent a state/country if the text does not provide one
    -- Events: "2024 United States presidential election" not "the election"; "1984 Summer Olympics" not "1984 games"; "CES 2025" not "CES"; "World War II" not "the war"
    -- Legal/Science: "General Data Protection Regulation" not "GDPR"; "Clean Air Act of 1970" not "Clean Air Act"; "Hubble Space Telescope" not "Hubble"; "CRISPR-Cas9" not "CRISPR"
    -- Products: "iPhone 16 Pro Max" not "iPhone"; "Tesla Model 3" not "Model 3"; "GPT-4" not "GPT"
    -- Culture: "Naismith Memorial Basketball Hall of Fame" not "Hall of Fame"; "Academy Award for Best Picture" not "Best Picture"; "The Great Gatsby" not "Gatsby"
    - "type": One of: ${ENTITY_TYPES_LIST}
    - "description": A one-sentence description of what this entity IS — its defining attributes, NOT its relationships to other entities
    - "aliases": Other proper names, abbreviations, pseudonyms, titles, or stable short references for THIS SAME entity in the text (array of strings). Preserve the exact surface forms that appear in the source text.
    -- Valid aliases: "NYC" for "New York City", "WHO" for "World Health Organization", "The Iron Lady" for "Margaret Thatcher", "Python" for "Python programming language", "Cole Conway" and "Conway" for "Cousin Cæsar" when the text says he is calling himself Cole Conway and later refers to him as Conway
    -- NEVER include as aliases:
    --- Pronouns or pronoun phrases (he, she, it, they, them, we, his, her, its)
    --- Generic references (the team, the roster, the company, the city, the league, the organization, the event, the protocol, the framework, the ingredient)
    --- Surnames or first names alone as canonical entity names (Curry, Obama, Kevin, Marie). A bare surname may be an alias only when the same passage or prior context clearly ties it to a full person entity, e.g. "Conway" after "Cole Conway"
    --- Names of DIFFERENT entities — "FIBA Hall of Fame" and "Naismith Hall of Fame" are SEPARATE entities; "React" and "React Native" are SEPARATE; "Python 2" and "Python 3" are SEPARATE
    --- Descriptive phrases (the American team, the defending champions, the former president, the lead researcher, the main ingredient)
    --- Country/city names for their teams — "France" is NOT an alias of "France men's national basketball team"; "Brazil" is NOT an alias of "Brazil national football team"
    --- Shortened generic forms — "Finals" is NOT an alias of "NBA Finals"; "MVP" is NOT an alias of any specific MVP award; "Olympics" is NOT an alias of "2024 Summer Olympics"
    
    </TASK_INSTRUCTIONS>
    
    <TASK_RULES>
    
    - Extract the most relevant and topically-important entities. When the text contains too many potential entities, prioritize:
    -- 1. PRIMARY SUBJECTS — entities the text is primarily ABOUT, not merely mentioned
    -- 2. ENTITIES WITH EXPLICIT RELATIONSHIPS — entities that have stated or repeated connections to other entities in the text
    -- 3. SPECIFIC OVER GENERIC — prefer "2006 FIBA World Championship" over "basketball"
    -- 4. ACTORS OVER SETTINGS — prefer entities that DO things over entities that are merely locations or backdrops
    -- Omit entities that appear only in lists, parenthetical asides, or as minor supporting context with no described relationships.
    - Only extract specific named entities. NOT dates, dollar amounts, percentages, or generic descriptions
    - Exception: when the text directly states a named person's or organization's profession, office, or role, extract that role label as a "concept" entity so it can participate in a structured relationship. Examples: "doctor", "pilot", "house surgeon"
    - If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list the proper name variants as aliases — NOT the generic reference
    - Include important entities even if they only appear once
    - Preserve complete person surface forms exactly when present. If the text says a person is "calling himself Cole Conway" or "known as Cole Conway", include "Cole Conway" as the entity name or alias — not only "Conway".
    - For people, prefer complete first+last names, titled names, and pseudonyms over bare first names or surnames.
    - Never create a standalone PERSON entity from a bare first name or surname when a fuller person name appears in the text or prior context. Promote it to the fuller entity and store the bare form as an alias only if it is clearly used as a reference.
    - Treat "called", "calling himself", "known as", "alias", "under the name", "styled himself", and "went by" constructions as alias evidence for the same entity unless the text clearly describes two different people.
    - Do not add a shared family surname as an alias when several related people use that surname. For example, "Simon" alone is not a safe alias for "Cæsar Simon" when "S. S. Simon" or "Young Simon" may also appear.
    - For locations, use the fullest location span stated in the text. If the source says "Paducah, Kentucky" or "Cairo, Egypt", the entity name should include the qualifier; the bare city may be an alias. Do not invent missing qualifiers.
    - Reject generic, low-information entities such as "Bill", "Bertha", "Coffee", "College Avenue", "the Queen", "the city", or "the old man" unless the text clearly establishes that exact phrase as a specific named entity.
    - Return an empty array if no named entities exist
    - For events, awards, seasons, software versions, product generations, or any time/version-specific entities, ALWAYS include the year, version, or edition in the name. Each distinct occurrence is a SEPARATE entity — e.g., "2023 NBA Finals" and "2024 NBA Finals" are different, "Python 2" and "Python 3" are different, "iPhone 15" and "iPhone 16" are different, "HTTP/1.1" and "HTTP/2" are different, "Michelin Guide 2024" and "Michelin Guide 2025" are different.
    - Different awards are ALWAYS separate entities even when they share words — "NBA Finals MVP" and "NBA MVP" are SEPARATE; "Academy Award for Best Picture" and "Academy Award for Best Director" are SEPARATE; "Nobel Peace Prize" and "Nobel Prize in Physics" are SEPARATE
    - Entities with opposing directional or categorical qualifiers are ALWAYS separate — "Western Conference" and "Eastern Conference" are SEPARATE; "North Atlantic Treaty Organization" and "South Asian Association" are SEPARATE; "Upper Egypt" and "Lower Egypt" are SEPARATE
    - Profession and role statements should become structured edges when supported by the text. Examples: "Steve Sharp, a pilot by profession" → Steve Sharp WORKS_AS pilot; "Elsie Inglis was a doctor" → Elsie Inglis WORKS_AS doctor; "She served as a house surgeon" → person HELD_ROLE house surgeon
    
    </TASK_RULES>
    
    <CRITICAL_RULES>
    
    CRITICAL — ALIASES vs. RELATIONSHIPS:
    - An ALIAS is a different name for THE SAME entity (e.g., "NYC" is an alias for "New York City")
    - A RELATIONSHIP connects TWO DIFFERENT entities (e.g., "National Basketball Association" and "Los Angeles Lakers" are connected by MEMBER_OF — "Lakers" is NOT an alias of "National Basketball Association").
    - NEVER list a related entity as an alias. If "Kevin Durant" appears in text about "Brooklyn Nets", they are SEPARATE entities connected by a relationship.
    - NEVER create a separate entity for a pseudonym or surface form that the text says belongs to the same person. If "Cousin Cæsar" is "calling himself Cole Conway", extract one person entity and put "Cole Conway" in aliases.
    - Test: Could you replace one name with the other in any sentence and preserve meaning? If yes → alias. If no → separate entities with a relationship.
    
    ACRONYM / INITIALISM CANONICALIZATION RULES:
    - Never use an acronym, abbreviation, or initialism as the canonical "name" when a fuller proper name is available in the text, document title, prior entity context, or common domain context.
    - Use the expanded full name as "name" and put the acronym/initialism in "aliases".
    - Examples:
      - Use "Time Variance Authority" as name, aliases ["TVA"].
      - Use "Marvel Cinematic Universe" as name, aliases ["MCU"].
      - Use "National Basketball Association"as name, aliases ["NBA"].
      - Use "Professor Charles Xavier’s School for Gifted Youngsters" as name, not "Xavier’s School" if the full name is available.
    - If the text contains only an acronym and no reliable expansion is available, you may use the acronym as the name, but set aliases to [].
    - If a prior entity context contains the expanded name, reuse that expanded name as canonical for later acronym mentions.
    - Do not create separate entities for an acronym and its expansion. Merge them into one entity.
    
    </CRITICAL_RULES>
    
    <EXAMPLE_TASK>
    
      This is an example, purely for illustrative purposes, to help you understand the task.
    
      <EXAMPLE_TEXT_STRING>
    
      "Cousin Cæsar was born to Nancy Wade in West Tennessee and grew up under the care of Big-sis. At twenty years of age we find Cousin Cæsar in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp; they were partners in the game, as they called it. Sharp, a pilot by profession, had purchased the cards, while Conway dealt in the back room of a saloon. Earlier, Rob Roy cut wood for Old Smith on a farm near the Tennessee River."
    
      </EXAMPLE_TEXT_STRING>
    
      <EXAMPLE_OUTPUT>
    
      [{"name": "Cousin Cæsar", "type": "person", "description": "A man born to Nancy Wade in West Tennessee who later uses the name Cole Conway in Paducah, Kentucky", "aliases": ["Cole Conway"]},
      {"name": "Nancy Wade", "type": "person", "description": "Mother of Cousin Cæsar", "aliases": []},
      {"name": "Big-sis", "type": "person", "description": "Caretaker of Cousin Cæsar during childhood", "aliases": []},
      {"name": "Steve Sharp", "type": "person", "description": "Pilot and partner of Cousin Cæsar in the card game", "aliases": []},
      {"name": "pilot", "type": "concept", "description": "A profession practiced by Steve Sharp", "aliases": []},
      {"name": "Paducah, Kentucky", "type": "location", "description": "City in Kentucky where Cousin Cæsar uses the name Cole Conway", "aliases": []},
      {"name": "West Tennessee", "type": "location", "description": "Region where Cousin Cæsar was born", "aliases": []},
      {"name": "Rob Roy", "type": "person", "description": "Wood cutter who worked for Old Smith", "aliases": []},
      {"name": "Old Smith", "type": "person", "description": "Farm owner near the Tennessee River who employed Rob Roy", "aliases": []},
      {"name": "Tennessee River", "type": "location", "description": "River near Old Smith's farm", "aliases": []}]
    
      </EXAMPLE_OUTPUT>
    
    </EXAMPLE_TASK>

  This is an example, purely for illustrative purposes, to help you understand the task.

  <EXAMPLE_TEXT_STRING>

  "Cousin Cæsar was born to Nancy Wade in West Tennessee and grew up under the care of Big-sis. At twenty years of age we find Cousin Cæsar in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp; they were partners in the game, as they called it. Sharp, a pilot by profession, had purchased the cards, while Conway dealt in the back room of a saloon. Earlier, Rob Roy cut wood for Old Smith on a farm near the Tennessee River."

  </EXAMPLE_TEXT_STRING>

  <EXAMPLE_OUTPUT>

  [{"name": "Cousin Cæsar", "type": "person", "description": "A man born to Nancy Wade in West Tennessee who later uses the name Cole Conway in Paducah, Kentucky", "aliases": ["Cole Conway"]},
  {"name": "Nancy Wade", "type": "person", "description": "Mother of Cousin Cæsar", "aliases": []},
  {"name": "Big-sis", "type": "person", "description": "Caretaker of Cousin Cæsar during childhood", "aliases": []},
  {"name": "Steve Sharp", "type": "person", "description": "Pilot and partner of Cousin Cæsar in the card game", "aliases": []},
  {"name": "pilot", "type": "concept", "description": "A profession practiced by Steve Sharp", "aliases": []},
  {"name": "Paducah, Kentucky", "type": "location", "description": "City in Kentucky where Cousin Cæsar uses the name Cole Conway", "aliases": []},
  {"name": "West Tennessee", "type": "location", "description": "Region where Cousin Cæsar was born", "aliases": []},
  {"name": "Rob Roy", "type": "person", "description": "Wood cutter who worked for Old Smith", "aliases": []},
  {"name": "Old Smith", "type": "person", "description": "Farm owner near the Tennessee River who employed Rob Roy", "aliases": []},
  {"name": "Tennessee River", "type": "location", "description": "River near Old Smith's farm", "aliases": []}]

  </EXAMPLE_OUTPUT>

</EXAMPLE_TASK>

Now, below we are getting into the meat of the current task you are performing.

<PREVIOUSLY_IDENTIFIED_ENTITIES>

  ${contextSection}

</PREVIOUSLY_IDENTIFIED_ENTITIES>

<DOCUMENT_TITLE>

  ${titleSection}

</DOCUMENT_TITLE>

<ENTITY_TYPE_LIST>

  ${ENTITY_TYPES_LIST}

</ENTITY_TYPE_LIST>

<TASK_OUTPUT_REQUIREMENTS>

- Return a JSON array: [{"name": "...", "type": "...", "description": "...", "aliases": ["..."]}, ...]
- Return an empty array if no named entities exist

</TASK_OUTPUT_REQUIREMENTS>

Extract all named entities from the following text string:

<THE_TEXT_STRING>

  ${content}

</THE_TEXT_STRING>`
}

function buildRelationshipPrompt(entitiesJson: string, content: string): string {
  return `Your task is to extract all relationships between the entities listed below and the entities in the text string.

<TASK_INSTRUCTIONS>

For each relationship, provide:
- "subject": Must be one of the entity names listed below
- "predicate": A canonical relationship verb from the vocabulary listed below
- "object": Must be one of the entity names listed below
- "confidence": How confident you are this relationship is stated or strongly implied (0.0 to 1.0)
- "description": One standalone sentence describing the relationship as a complete fact.
- "evidenceText": A concise source-backed excerpt or paraphrase that justifies the relationship.

</TASK_INSTRUCTIONS>

<TASK_RULES>

- Subject and object MUST be from the entity list listed below — do not introduce new entities
- Use ONLY predicates from the vocabulary listed below. Do not invent relation names; omit the relationship if no predicate fits.
- Preserve logical direction. Passive voice must be converted to the active graph direction: "X was killed by Y" becomes Y KILLED X; "X was founded by Y" becomes Y FOUNDED X.
- Use MARRIED for spouse, husband, wife, wed, or married relationships. Do not emit HUSBAND_OF, WIFE_OF, SPOUSE_OF, or MARRIED_TO.
- Use PARENT_OF for father/mother/parent relationships, CHILD_OF for son/daughter/child relationships, and SIBLING_OF for brother/sister/sibling relationships.
- Do not emit inverse predicates that are not in the vocabulary, such as KILLED_BY, FOUNDED_BY, WRITTEN_BY, OWNED_BY, or DESIGNED_BY. Swap subject and object instead.
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN")
- Use the most specific predicate that accurately captures the relationship
- Extract relationships that are explicitly stated or strongly implied in the text
- Do not emit self-relationships or alias relationships. If two names refer to the same entity, they belong in aliases from the entity step, not in the relationships array.
- Do not connect an entity to a generic description or role unless that role was extracted as a specific named entity.
- When the text directly states a profession, office, or role for a named entity, emit a structured relationship to that role concept. Examples: person WORKS_AS doctor, person HELD_ROLE house surgeon, person PRACTICED_AS physician
- Preserve important names, dates, places, objects, and negation in relationship descriptions and evidence text.
- Return an empty array if no clear relationships exist between the entities listed below

</TASK_RULES>

<EXAMPLE_TASK>

  This is an example, purely for illustrative purposes, to help you understand the task:

  <EXAMPLE_ENTITIES_FOUND_IN_THE_EXAMPLE_TEXT_STRING>

    Entities found in the example text string:

    [{"name": "Cousin Cæsar", "type": "person", "description": "A man born to Nancy Wade in West Tennessee who later uses the name Cole Conway in Paducah, Kentucky", "aliases": ["Cole Conway"]},
    {"name": "Nancy Wade", "type": "person", "description": "Mother of Cousin Cæsar", "aliases": []},
    {"name": "Big-sis", "type": "person", "description": "Caretaker of Cousin Cæsar during childhood", "aliases": []},
    {"name": "Steve Sharp", "type": "person", "description": "Pilot and partner of Cousin Cæsar in the card game", "aliases": []},
    {"name": "pilot", "type": "concept", "description": "A profession practiced by Steve Sharp", "aliases": []},
    {"name": "Paducah, Kentucky", "type": "location", "description": "City in Kentucky where Cousin Cæsar uses the name Cole Conway", "aliases": []},
    {"name": "West Tennessee", "type": "location", "description": "Region where Cousin Cæsar was born", "aliases": []},
    {"name": "Rob Roy", "type": "person", "description": "Wood cutter who worked for Old Smith", "aliases": []},
    {"name": "Old Smith", "type": "person", "description": "Farm owner near the Tennessee River who employed Rob Roy", "aliases": []},
    {"name": "Tennessee River", "type": "location", "description": "River near Old Smith's farm", "aliases": []}]

  </EXAMPLE_ENTITIES_FOUND_IN_THE_EXAMPLE_TEXT_STRING>

  <EXAMPLE_TEXT_STRING>

    "Cousin Cæsar was born to Nancy Wade in West Tennessee and grew up under the care of Big-sis. At twenty years of age we find Cousin Cæsar in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp; they were partners in the game, as they called it. Sharp, a pilot by profession, had purchased the cards, while Conway dealt in the back room of a saloon. Earlier, Rob Roy cut wood for Old Smith on a farm near the Tennessee River."

  </EXAMPLE_TEXT_STRING>

  <EXAMPLE_OUTPUT>

    [{"subject": "Cousin Cæsar", "predicate": "CHILD_OF", "object": "Nancy Wade", "confidence": 0.95, "description": "Cousin Cæsar was born to Nancy Wade.", "evidenceText": "Cousin Cæsar was born to Nancy Wade"},
    {"subject": "Cousin Cæsar", "predicate": "BORN_IN", "object": "West Tennessee", "confidence": 0.95, "description": "Cousin Cæsar was born in West Tennessee.", "evidenceText": "born to Nancy Wade in West Tennessee"},
    {"subject": "Cousin Cæsar", "predicate": "TRAVELED_TO", "object": "Paducah, Kentucky", "confidence": 0.85, "description": "Cousin Cæsar later went to Paducah, Kentucky.", "evidenceText": "we find Cousin Cæsar in Paducah, Kentucky"},
    {"subject": "Cousin Cæsar", "predicate": "COLLABORATED_WITH", "object": "Steve Sharp", "confidence": 0.95, "description": "Cousin Cæsar and Steve Sharp were partners in a card game.", "evidenceText": "in company with one Steve Sharp; they were partners"},
    {"subject": "Steve Sharp", "predicate": "WORKS_AS", "object": "pilot", "confidence": 0.9, "description": "Steve Sharp worked as a pilot.", "evidenceText": "Sharp, a pilot by profession"},
    {"subject": "Old Smith", "predicate": "EMPLOYED", "object": "Rob Roy", "confidence": 0.9, "description": "Old Smith employed Rob Roy to cut wood.", "evidenceText": "Rob Roy cut wood for Old Smith"}]

  </EXAMPLE_OUTPUT>

</EXAMPLE_TASK>

Now, below we are getting into the meat of the current task you are performing.

<TASK_OUTPUT_REQUIREMENTS>

- Return a JSON array: [{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.9, "description": "...", "evidenceText": "..."}, ...]
- Return an empty array if no relationships exist between the listed entities

</TASK_OUTPUT_REQUIREMENTS>

<PREDICATE_VOCABULARY_TO_USE_FOR_THIS_TASK>

  ${getPredicatesForPrompt()}

</PREDICATE_VOCABULARY_TO_USE_FOR_THIS_TASK>

Below, is a list of entities found in the text string:

<ENTITIES_FOUND_IN_THE_TEXT_STRING>

  ${entitiesJson}

</ENTITIES_FOUND_IN_THE_TEXT_STRING>

Extract all relationships between the entities listed above and the entities in the text string:

<THE_TEXT_STRING>

  ${content}

</THE_TEXT_STRING>`
}

// ── Extractor ──

export class TripleExtractor {
  private llm: LLMProvider
  private relationshipLlm: LLMProvider
  private graph: KnowledgeGraphBridge
  private twoPass: boolean

  constructor(config: TripleExtractorConfig) {
    this.llm = config.llm
    this.relationshipLlm = config.relationshipLlm ?? config.llm
    this.graph = config.graph
    this.twoPass = config.twoPass ?? true
  }

  /**
   * Extract entities and relationships from a chunk and store as triples.
   * Returns extracted entities for cross-chunk context propagation.
   */
  async extractFromChunk(
    content: string,
    bucketId: string,
    chunkIndex?: number,
    documentId?: string,
    metadata?: Record<string, unknown>,
    entityContext?: EntityContext[],
    documentTitle?: string,
    identity?: {
      tenantId?: string | undefined
      groupId?: string | undefined
      userId?: string | undefined
      agentId?: string | undefined
      conversationId?: string | undefined
    },
    visibility?: Visibility,
    sourceChunkId?: string,
  ): Promise<{ entities: EntityContext[] } | undefined> {
    if (!this.graph.addTriple && !this.graph.addEntityMentions) return { entities: [] }

    const cleanContent = sanitizeText(content)
    const cleanTitle = documentTitle ? sanitizeField(documentTitle) : undefined
    const raw = this.twoPass
      ? await this.extractTwoPass(cleanContent, entityContext, cleanTitle)
      : await this.extractSinglePass(cleanContent, entityContext, cleanTitle)
    const { entities, relationships } = postProcessExtraction(raw.entities, raw.relationships, cleanContent)

    if (this.graph.addEntityMentions && entities.length > 0) {
      await this.graph.addEntityMentions(entities.map(entity => ({
        name: entity.name,
        type: entity.type,
        aliases: entity.aliases ?? [],
        description: entity.description,
        content: cleanContent,
        bucketId,
        ...(chunkIndex !== undefined ? { chunkIndex } : {}),
        ...(documentId ? { documentId } : {}),
        ...(identity?.tenantId ? { tenantId: identity.tenantId } : {}),
        ...(identity?.groupId ? { groupId: identity.groupId } : {}),
        ...(identity?.userId ? { userId: identity.userId } : {}),
        ...(identity?.agentId ? { agentId: identity.agentId } : {}),
        ...(identity?.conversationId ? { conversationId: identity.conversationId } : {}),
        ...(visibility ? { visibility } : {}),
        ...(metadata ? { metadata } : {}),
      })))
    }

    if (this.graph.addTriple && entities.length >= 2) {
      const entityByName = new Map<string, ExtractedEntity>()
      for (const e of entities) {
        entityByName.set(normalizeName(e.name), e)
        for (const alias of e.aliases) entityByName.set(normalizeName(alias), e)
      }

      for (const rel of relationships) {
        const subjectEntity = entityByName.get(normalizeName(rel.subject))
        const objectEntity = entityByName.get(normalizeName(rel.object))
        if (!subjectEntity || !objectEntity) continue

        await this.graph.addTriple({
          subject: subjectEntity.name,
          subjectType: subjectEntity.type,
          subjectAliases: subjectEntity.aliases ?? [],
          subjectDescription: subjectEntity.description,
          predicate: rel.predicate,
          object: objectEntity.name,
          objectType: objectEntity.type,
          objectAliases: objectEntity.aliases ?? [],
          objectDescription: objectEntity.description,
          relationshipDescription: rel.description,
          evidenceText: rel.evidenceText,
          sourceChunkId,
          confidence: typeof rel.confidence === 'number' ? Math.max(0, Math.min(1, rel.confidence)) : 1.0,
          content: cleanContent,
          bucketId,
          ...(chunkIndex !== undefined ? { chunkIndex } : {}),
          ...(documentId ? { documentId } : {}),
          ...(identity?.tenantId ? { tenantId: identity.tenantId } : {}),
          ...(identity?.groupId ? { groupId: identity.groupId } : {}),
          ...(identity?.userId ? { userId: identity.userId } : {}),
          ...(identity?.agentId ? { agentId: identity.agentId } : {}),
          ...(identity?.conversationId ? { conversationId: identity.conversationId } : {}),
          ...(visibility ? { visibility } : {}),
          ...(metadata ? { metadata } : {}),
        })
      }
    }

    return { entities: entities.map(e => ({ name: e.name, type: e.type })) }
  }

  async persistPassageNodes(nodes: Parameters<NonNullable<KnowledgeGraphBridge['upsertPassageNodes']>>[0]): Promise<void> {
    await this.graph.upsertPassageNodes?.(nodes)
  }

  /** Single combined LLM call for entities + relationships. Used only when twoPass is disabled. */
  private async extractSinglePass(
    content: string,
    entityContext?: EntityContext[],
    documentTitle?: string,
  ): Promise<ExtractionResult> {
    const prompt = buildSinglePassPrompt(content, entityContext, documentTitle)
    const result = await this.llm.generateJSON<ExtractionResult>(
      prompt,
      'You are a precise knowledge graph extractor. Preserve complete named surface forms, model pseudonyms as aliases, reject generic one-token entities, and return only valid JSON.',
      { schema: singlePassSchema },
    )

    if (!result || !Array.isArray(result.entities)) {
      return { entities: [], relationships: [] }
    }

    const entities = result.entities.filter(e =>
      e.name && e.type && VALID_ENTITY_TYPES.has(e.type)
    )
    const relationships = Array.isArray(result.relationships) ? result.relationships : []

    return { entities, relationships }
  }

  /** Two separate LLM calls: entities first, then relationships. */
  private async extractTwoPass(
    content: string,
    entityContext?: EntityContext[],
    documentTitle?: string,
  ): Promise<ExtractionResult> {
    // Pass 1: Extract entities
    const rawEntities = await this.llm.generateJSON<ExtractedEntity[]>(
      buildEntityExtractionPrompt(content, entityContext, documentTitle),
      'You are a precise named entity extractor. Preserve complete named surface forms, model pseudonyms as aliases, reject generic one-token entities, and return only valid JSON arrays.',
      { schema: entitySchema },
    )

    if (!Array.isArray(rawEntities)) {
      return { entities: [], relationships: [] }
    }

    const entities = rawEntities.filter(e =>
      e.name && e.type && VALID_ENTITY_TYPES.has(e.type)
    )

    if (entities.length < 2) {
      return { entities, relationships: [] }
    }

    // Pass 2: Extract relationships using known entities
    const entitiesJson = JSON.stringify(entities.map(e => ({ name: e.name, type: e.type })))
    const prompt = buildRelationshipPrompt(entitiesJson, content)

    const rawRelationships = await this.relationshipLlm.generateJSON<ExtractedRelationship[]>(
      prompt,
      'You are a precise relationship extractor. Do not emit alias/self relationships. Return only valid JSON arrays.',
      { schema: relationshipSchema },
    )

    const relationships = Array.isArray(rawRelationships) ? rawRelationships : []

    return { entities, relationships }
  }
}
