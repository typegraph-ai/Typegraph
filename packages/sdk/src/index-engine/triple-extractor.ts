import { z } from 'zod'
import type { LLMProvider } from '../types/llm-provider.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'
import { getPredicatesForPrompt } from './ontology.js'

export interface TripleExtractorConfig {
  /** LLM for entity extraction (Pass 1 in two-pass mode) or the single combined call. */
  llm: LLMProvider
  /** LLM for relationship extraction (Pass 2 in two-pass mode). Falls back to llm. */
  relationshipLlm?: LLMProvider | undefined
  graph: KnowledgeGraphBridge
  /** Use two separate LLM calls (entities then relationships) instead of one combined call. Default: false. */
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
}))

const singlePassSchema = z.object({
  entities: entitySchema,
  relationships: relationshipSchema,
})

// ── Single-pass prompt (default) ──

function buildSinglePassPrompt(content: string, entityContext?: EntityContext[], documentTitle?: string): string {
  const contextSection = entityContext?.length
    ? `\nPreviously identified entities in this document:\n${entityContext.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nUse these names when the text refers to these entities by pronoun, abbreviation, or epithet.\n`
    : ''
  const titleSection = documentTitle
    ? `\nThe text string is from a document titled: "${documentTitle}". Entities referenced in the title should be extracted as primary entities using their full formal names.\n`
    : ''

  return `Your task is to extract all named entities, and relationships between them, from a text string.

${contextSection}${titleSection}

## Step 1: Entity Extraction

For each entity, provide:
- "name": The most complete, formal name of the entity. Always use full proper names — NOT surnames, nicknames, shortened forms, or abbreviations alone. Examples across domains:
  People: "Stephen Curry" not "Curry"; "Barack Obama" not "Obama"; "Marie Curie" not "Curie"; "Ada Lovelace" not "Lovelace"
  Organizations: "Goldman Sachs Group" not "Goldman"; "European Central Bank" not "ECB"; "Massachusetts Institute of Technology" not "MIT"; "World Health Organization" not "WHO"
  Technology: "Amazon Web Services" not "AWS"; "React Native" not "React"; "PostgreSQL" not "Postgres"; "Large Language Model" not "LLM" (when first introduced)
  Locations: "San Francisco Bay Area" not "Bay Area"; "United Kingdom" not "UK"; "Silicon Valley" not "the Valley"; "Cape Town" not "the Cape"
  Events: "2024 United States presidential election" not "the election"; "1984 Summer Olympics" not "1984 games"; "CES 2025" not "CES"; "World War II" not "the war"
  Legal/Science: "General Data Protection Regulation" not "GDPR"; "Clean Air Act of 1970" not "Clean Air Act"; "Hubble Space Telescope" not "Hubble"; "CRISPR-Cas9" not "CRISPR"
  Products: "iPhone 16 Pro Max" not "iPhone"; "Tesla Model 3" not "Model 3"; "GPT-4" not "GPT"
  Culture: "Naismith Memorial Basketball Hall of Fame" not "Hall of Fame"; "Academy Award for Best Picture" not "Best Picture"; "The Great Gatsby" not "Gatsby"
- "type": One of: ${ENTITY_TYPES_LIST}
- "description": A one-sentence description of what this entity IS — its defining attributes, NOT its relationships to other entities
- "aliases": Other proper names, abbreviations, or widely-recognized nicknames for THIS SAME entity in the text (array of strings).
  Valid aliases: "NYC" for "New York City", "WHO" for "World Health Organization", "The Iron Lady" for "Margaret Thatcher", "Python" for "Python programming language"
  NEVER include as aliases:
  - Pronouns or pronoun phrases (he, she, it, they, them, we, his, her, its)
  - Generic references (the team, the roster, the company, the city, the league, the organization, the event, the protocol, the framework, the ingredient)
  - Surnames or first names alone (Curry, Obama, Kevin, Marie) — these are ambiguous, not aliases
  - Names of DIFFERENT entities — "FIBA Hall of Fame" and "Naismith Hall of Fame" are SEPARATE entities; "React" and "React Native" are SEPARATE; "Python 2" and "Python 3" are SEPARATE
  - Descriptive phrases (the American team, the defending champions, the former president, the lead researcher, the main ingredient)
  - Country/city names for their teams — "France" is NOT an alias of "France men's national basketball team"; "Brazil" is NOT an alias of "Brazil national football team"
  - Shortened generic forms — "Finals" is NOT an alias of "NBA Finals"; "MVP" is NOT an alias of any specific MVP award; "Olympics" is NOT an alias of "2024 Summer Olympics"

Entity rules:
- Extract a MAXIMUM of 12 entities. When the text contains more potential entities, prioritize:
  1. Primary subjects — entities the text is primarily ABOUT, not merely mentioned
  2. Entities with explicit relationships — entities that have stated connections to other entities in the text
  3. Specific over generic — prefer "2006 FIBA World Championship" over "basketball"
  4. Actors over settings — prefer entities that DO things over entities that are merely locations or backdrops
- Omit entities that appear only in lists, parenthetical asides, or as minor supporting context with no described relationships.
- Only extract specific named entities — NOT dates, dollar amounts, percentages, or generic descriptions
- If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list the proper name variants as aliases — NOT the generic reference
- Include important entities even if they only appear once
- For events, awards, seasons, software versions, product generations, or any time/version-specific entities, ALWAYS include the year, version, or edition in the name. Each distinct occurrence is a SEPARATE entity — e.g., "2023 NBA Finals" and "2024 NBA Finals" are different, "Python 2" and "Python 3" are different, "iPhone 15" and "iPhone 16" are different, "HTTP/1.1" and "HTTP/2" are different, "Michelin Guide 2024" and "Michelin Guide 2025" are different.
- Different awards are ALWAYS separate entities even when they share words — "NBA Finals MVP" and "NBA MVP" are SEPARATE; "Academy Award for Best Picture" and "Academy Award for Best Director" are SEPARATE; "Nobel Peace Prize" and "Nobel Prize in Physics" are SEPARATE
- Entities with opposing directional or categorical qualifiers are ALWAYS separate — "Western Conference" and "Eastern Conference" are SEPARATE; "North Atlantic Treaty Organization" and "South Asian Association" are SEPARATE; "Upper Egypt" and "Lower Egypt" are SEPARATE

CRITICAL — Aliases vs. Relationships:
- An ALIAS is a different name for THE SAME entity (e.g., "NYC" is an alias for "New York City")
- A RELATIONSHIP connects TWO DIFFERENT entities (e.g., "NBA" and "Los Angeles Lakers" are connected by MEMBER_OF — "Lakers" is NOT an alias of "NBA")
- NEVER list a related entity as an alias. If "Kevin Durant" appears in text about "Brooklyn Nets", they are SEPARATE entities connected by a relationship
- Test: Could you replace one name with the other in any sentence and preserve meaning? If yes → alias. If no → separate entities with a relationship

## Step 2: Relationship Extraction

For each relationship between the entities you identified, provide:
- "subject": Must be one of the entity names from Step 1
- "predicate": A canonical relationship verb from the vocabulary below
- "object": Must be one of the entity names from Step 1
- "confidence": How confident you are (0.0 to 1.0)

${getPredicatesForPrompt()}

Relationship rules:
- Subject and object MUST be entities from Step 1 — do not introduce new entities
- ALWAYS prefer a predicate from the vocabulary above. Only invent a new predicate if NONE fit.
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN")
- Use the most specific predicate that accurately captures the relationship
- Extract relationships that are explicitly stated or strongly implied in the text

## Example

Text: "Margaret Ashworth had lived in Oxford since her marriage to Edmund, who served as president of The Geographical Society. It was through Edmund's influence that she first traveled to Cairo, where she met the renowned cartographer Helena Voss. The two women corresponded for years, and Helena's bold methods deeply influenced Margaret's own work. Margaret eventually wrote Principles of Navigation, which many regarded as a challenge to Edmund's more traditional views on the subject. Helena, who had once taught at Oxford before the Society forced her departure, remained Margaret's closest intellectual ally."

Output:
{"entities": [
  {"name": "Margaret Ashworth", "type": "person", "description": "Author of Principles of Navigation, influenced by Helena Voss", "aliases": []},
  {"name": "Edmund Ashworth", "type": "person", "description": "President of The Geographical Society, married to Margaret", "aliases": ["Edmund"]},
  {"name": "The Geographical Society", "type": "organization", "description": "Academic society led by Edmund Ashworth", "aliases": ["the Society"]},
  {"name": "Cairo", "type": "location", "description": "City where Margaret met Helena Voss", "aliases": []},
  {"name": "Oxford", "type": "location", "description": "City where Margaret lived and Helena once taught", "aliases": []},
  {"name": "Helena Voss", "type": "person", "description": "Renowned cartographer and Margaret's intellectual ally", "aliases": ["Helena"]},
  {"name": "Principles of Navigation", "type": "work_of_art", "description": "Book written by Margaret Ashworth", "aliases": []}
], "relationships": [
  {"subject": "Margaret Ashworth", "predicate": "LIVED_IN", "object": "Oxford", "confidence": 0.95},
  {"subject": "Margaret Ashworth", "predicate": "MARRIED", "object": "Edmund Ashworth", "confidence": 0.95},
  {"subject": "Edmund Ashworth", "predicate": "LEADS", "object": "The Geographical Society", "confidence": 0.9},
  {"subject": "Margaret Ashworth", "predicate": "TRAVELED_TO", "object": "Cairo", "confidence": 0.9},
  {"subject": "Edmund Ashworth", "predicate": "INFLUENCED", "object": "Margaret Ashworth", "confidence": 0.85},
  {"subject": "Helena Voss", "predicate": "CORRESPONDS_WITH", "object": "Margaret Ashworth", "confidence": 0.9},
  {"subject": "Helena Voss", "predicate": "INFLUENCED", "object": "Margaret Ashworth", "confidence": 0.9},
  {"subject": "Margaret Ashworth", "predicate": "WROTE", "object": "Principles of Navigation", "confidence": 0.95},
  {"subject": "Margaret Ashworth", "predicate": "OPPOSED", "object": "Edmund Ashworth", "confidence": 0.75},
  {"subject": "Helena Voss", "predicate": "TAUGHT", "object": "Oxford", "confidence": 0.85},
  {"subject": "Helena Voss", "predicate": "COLLABORATED_WITH", "object": "Margaret Ashworth", "confidence": 0.9}
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
    ? `\nPreviously identified entities in the text string:\n${entityContext.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nUse these names when the text refers to these entities by pronoun, abbreviation, or epithet.\n`
    : ''
  const titleSection = documentTitle
    ? `\nThe text string is from a document titled: "${documentTitle}". Entities referenced in the title should be extracted as primary entities using their full formal names.\n`
    : ''

  return `Your task is to extract all named entities from a text string.

<TASK_INSTRUCTIONS>

For each entity, provide:

- "name": The most complete, formal and canonical name of the entity. Always use full proper names — NOT surnames, nicknames, shortened forms, or abbreviations alone. Examples across domains:
-- People: "Stephen Curry" not "Curry"; "Barack Obama" not "Obama"; "Marie Curie" not "Curie"; "Ada Lovelace" not "Lovelace"
-- Organizations: "Goldman Sachs Group" not "Goldman"; "European Central Bank" not "ECB"; "Massachusetts Institute of Technology" not "MIT"; "World Health Organization" not "WHO"; "Apple Inc." not "Apple"
-- Technology: "Amazon Web Services" not "AWS"; "React Native" not "React"; "PostgreSQL" not "Postgres"; "Large Language Model" not "LLM" (when first introduced)
-- Locations: "San Francisco Bay Area" not "Bay Area"; "United Kingdom" not "UK"; "Silicon Valley" not "the Valley"; "Cape Town, South Africa" not "the Cape"
-- Events: "2024 United States presidential election" not "the election"; "1984 Summer Olympics" not "1984 games"; "CES 2025" not "CES"; "World War II" not "the war"
-- Legal/Science: "General Data Protection Regulation" not "GDPR"; "Clean Air Act of 1970" not "Clean Air Act"; "Hubble Space Telescope" not "Hubble"; "CRISPR-Cas9" not "CRISPR"
-- Products: "iPhone 16 Pro Max" not "iPhone"; "Tesla Model 3" not "Model 3"; "GPT-4" not "GPT"
-- Culture: "Naismith Memorial Basketball Hall of Fame" not "Hall of Fame"; "Academy Award for Best Picture" not "Best Picture"; "The Great Gatsby" not "Gatsby"
- "type": One of: ${ENTITY_TYPES_LIST}
- "description": A one-sentence description of what this entity IS — its defining attributes, NOT its relationships to other entities
- "aliases": Other proper names, abbreviations, or widely-recognized nicknames for THIS SAME entity in the text (array of strings).
-- Valid aliases: "NYC" for "New York City", "WHO" for "World Health Organization", "The Iron Lady" for "Margaret Thatcher", "Python" for "Python programming language"
-- NEVER include as aliases:
--- Pronouns or pronoun phrases (he, she, it, they, them, we, his, her, its)
--- Generic references (the team, the roster, the company, the city, the league, the organization, the event, the protocol, the framework, the ingredient)
--- Surnames or first names alone (Curry, Obama, Kevin, Marie) — these are ambiguous, not aliases
--- Names of DIFFERENT entities — "FIBA Hall of Fame" and "Naismith Hall of Fame" are SEPARATE entities; "React" and "React Native" are SEPARATE; "Python 2" and "Python 3" are SEPARATE
--- Descriptive phrases (the American team, the defending champions, the former president, the lead researcher, the main ingredient)
--- Country/city names for their teams — "France" is NOT an alias of "France men's national basketball team"; "Brazil" is NOT an alias of "Brazil national football team"
--- Shortened generic forms — "Finals" is NOT an alias of "NBA Finals"; "MVP" is NOT an alias of any specific MVP award; "Olympics" is NOT an alias of "2024 Summer Olympics"

</TASK_INSTRUCTIONS>

<TASK_RULES>

- Extract a MAXIMUM of 12 entities. When the text contains more potential entities, prioritize:
-- 1. Primary subjects — entities the text is primarily ABOUT, not merely mentioned
-- 2. Entities with explicit relationships — entities that have stated connections to other entities in the text
-- 3. Specific over generic — prefer "2006 FIBA World Championship" over "basketball"
-- 4. Actors over settings — prefer entities that DO things over entities that are merely locations or backdrops
-- Omit entities that appear only in lists, parenthetical asides, or as minor supporting context with no described relationships.
- Only extract specific named entities — NOT dates, dollar amounts, percentages, or generic descriptions
- If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list the proper name variants as aliases — NOT the generic reference
- Include important entities even if they only appear once
- Return an empty array if no named entities exist
- For events, awards, seasons, software versions, product generations, or any time/version-specific entities, ALWAYS include the year, version, or edition in the name. Each distinct occurrence is a SEPARATE entity — e.g., "2023 NBA Finals" and "2024 NBA Finals" are different, "Python 2" and "Python 3" are different, "iPhone 15" and "iPhone 16" are different, "HTTP/1.1" and "HTTP/2" are different, "Michelin Guide 2024" and "Michelin Guide 2025" are different.
- Different awards are ALWAYS separate entities even when they share words — "NBA Finals MVP" and "NBA MVP" are SEPARATE; "Academy Award for Best Picture" and "Academy Award for Best Director" are SEPARATE; "Nobel Peace Prize" and "Nobel Prize in Physics" are SEPARATE
- Entities with opposing directional or categorical qualifiers are ALWAYS separate — "Western Conference" and "Eastern Conference" are SEPARATE; "North Atlantic Treaty Organization" and "South Asian Association" are SEPARATE; "Upper Egypt" and "Lower Egypt" are SEPARATE

</TASK_RULES>

<CRITICAL_RULES>

CRITICAL — Aliases vs. Relationships:
- An ALIAS is a different name for THE SAME entity (e.g., "NYC" is an alias for "New York City")
- A RELATIONSHIP connects TWO DIFFERENT entities (e.g., "NBA" and "Los Angeles Lakers" are connected by MEMBER_OF — "Lakers" is NOT an alias of "NBA")
- NEVER list a related entity as an alias. If "Kevin Durant" appears in text about "Brooklyn Nets", they are SEPARATE entities connected by a relationship
- Test: Could you replace one name with the other in any sentence and preserve meaning? If yes → alias. If no → separate entities with a relationship

</CRITICAL_RULES>

<EXAMPLE_TASK>

  This is an example, purely for illustrative purposes, to help you understand the task.

  <EXAMPLE_TEXT_STRING>

  "Margaret Ashworth had lived in Oxford since her marriage to Edmund, who served as president of The Geographical Society. It was through Edmund's influence that she first traveled to Cairo, where she met the renowned cartographer Helena Voss. The two women corresponded for years, and Helena's bold methods deeply influenced Margaret's own work. Margaret eventually wrote Principles of Navigation, which many regarded as a challenge to Edmund's more traditional views on the subject. Helena, who had once taught at Oxford before the Society forced her departure, remained Margaret's closest intellectual ally."

  </EXAMPLE_TEXT_STRING>

  <EXAMPLE_OUTPUT>

  [{"name": "Margaret Ashworth", "type": "person", "description": "Author of Principles of Navigation, influenced by Helena Voss", "aliases": []},
  {"name": "Edmund Ashworth", "type": "person", "description": "President of The Geographical Society, married to Margaret", "aliases": ["Edmund"]},
  {"name": "The Geographical Society", "type": "organization", "description": "Academic society led by Edmund Ashworth", "aliases": ["the Society"]},
  {"name": "Cairo", "type": "location", "description": "City where Margaret met Helena Voss", "aliases": []},
  {"name": "Oxford", "type": "location", "description": "City where Margaret lived and Helena once taught", "aliases": []},
  {"name": "Helena Voss", "type": "person", "description": "Renowned cartographer and Margaret's intellectual ally", "aliases": ["Helena"]},
  {"name": "Principles of Navigation", "type": "work_of_art", "description": "Book written by Margaret Ashworth", "aliases": []}]

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

</TASK_INSTRUCTIONS>

<TASK_RULES>

- Subject and object MUST be from the entity list listed below — do not introduce new entities
- ALWAYS prefer a predicate from the vocabulary listed below. Only invent a new predicate if NONE fit.
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN")
- Use the most specific predicate that accurately captures the relationship
- Extract relationships that are explicitly stated or strongly implied in the text
- Return an empty array if no clear relationships exist between the entities listed below

</TASK_RULES>

<EXAMPLE_TASK>

  This is an example, purely for illustrative purposes, to help you understand the task:

  <EXAMPLE_ENTITIES_FOUND_IN_THE_EXAMPLE_TEXT_STRING>

    Entities: [{"name": "Margaret Ashworth", "type": "person"}, {"name": "Edmund Ashworth", "type": "person"}, {"name": "The Geographical Society", "type": "organization"}, {"name": "Cairo, Egypt", "type": "location"}, {"name": "Oxford, United Kingdom", "type": "location"}, {"name": "Helena Voss", "type": "person"}, {"name": "Principles of Navigation", "type": "work_of_art"}]

  </EXAMPLE_ENTITIES_FOUND_IN_THE_EXAMPLE_TEXT_STRING>

  <EXAMPLE_TEXT_STRING>

    "Margaret Ashworth had lived in Oxford since her marriage to Edmund, who served as president of The Geographical Society. It was through Edmund's influence that she first traveled to Cairo, where she met the renowned cartographer Helena Voss. The two women corresponded for years, and Helena's bold methods deeply influenced Margaret's own work. Margaret eventually wrote Principles of Navigation, which many regarded as a challenge to Edmund's more traditional views on the subject. Helena, who had once taught at Oxford before the Society forced her departure, remained Margaret's closest intellectual ally."

  </EXAMPLE_TEXT_STRING>

  <EXAMPLE_OUTPUT>

    [{"subject": "Margaret Ashworth", "predicate": "LIVED_IN", "object": "Oxford, United Kingdom", "confidence": 0.95},
    {"subject": "Margaret Ashworth", "predicate": "MARRIED", "object": "Edmund Ashworth", "confidence": 0.95},
    {"subject": "Edmund Ashworth", "predicate": "LEADS", "object": "The Geographical Society", "confidence": 0.9},
    {"subject": "Margaret Ashworth", "predicate": "TRAVELED_TO", "object": "Cairo, Egypt", "confidence": 0.9},
    {"subject": "Edmund Ashworth", "predicate": "INFLUENCED", "object": "Margaret Ashworth", "confidence": 0.85},
    {"subject": "Helena Voss", "predicate": "CORRESPONDS_WITH", "object": "Margaret Ashworth", "confidence": 0.9},
    {"subject": "Helena Voss", "predicate": "INFLUENCED", "object": "Margaret Ashworth", "confidence": 0.9},
    {"subject": "Margaret Ashworth", "predicate": "WROTE", "object": "Principles of Navigation", "confidence": 0.95},
    {"subject": "Margaret Ashworth", "predicate": "OPPOSED", "object": "Edmund Ashworth", "confidence": 0.75},
    {"subject": "Helena Voss", "predicate": "TAUGHT", "object": "Oxford, United Kingdom", "confidence": 0.85},
    {"subject": "Helena Voss", "predicate": "COLLABORATED_WITH", "object": "Margaret Ashworth", "confidence": 0.9}]

  </EXAMPLE_OUTPUT>

</EXAMPLE_TASK>

Now, below we are getting into the meat of the current task you are performing.

<TASK_OUTPUT_REQUIREMENTS>

- Return a JSON array: [{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.9}, ...]
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
    this.twoPass = config.twoPass ?? false
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
  ): Promise<{ entities: EntityContext[] } | undefined> {
    if (!this.graph.addTriple) return undefined

    try {
      const { entities, relationships } = this.twoPass
        ? await this.extractTwoPass(content, entityContext, documentTitle)
        : await this.extractSinglePass(content, entityContext, documentTitle)

      if (entities.length < 2) return { entities: entities.map(e => ({ name: e.name, type: e.type })) }

      // Build entity lookup for validation
      const entityByName = new Map<string, ExtractedEntity>()
      for (const e of entities) {
        entityByName.set(e.name.toLowerCase(), e)
      }

      // Validate and emit triples
      for (const rel of relationships) {
        if (!rel.subject || !rel.predicate || !rel.object) continue

        const subjectEntity = entityByName.get(rel.subject.toLowerCase())
        const objectEntity = entityByName.get(rel.object.toLowerCase())
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
          confidence: typeof rel.confidence === 'number' ? Math.max(0, Math.min(1, rel.confidence)) : 1.0,
          content,
          bucketId,
          ...(chunkIndex !== undefined ? { chunkIndex } : {}),
          ...(documentId ? { documentId } : {}),
          ...(metadata ? { metadata } : {}),
        })
      }

      return { entities: entities.map(e => ({ name: e.name, type: e.type })) }
    } catch (err) {
      // Triple extraction failures should not block indexing, but log for observability
      console.error('[typegraph] Triple extraction failed', {
        bucketId,
        documentId,
        chunkIndex,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /** Single combined LLM call for entities + relationships (default). */
  private async extractSinglePass(
    content: string,
    entityContext?: EntityContext[],
    documentTitle?: string,
  ): Promise<ExtractionResult> {
    const prompt = buildSinglePassPrompt(content, entityContext, documentTitle)
    const result = await this.llm.generateJSON<ExtractionResult>(
      prompt,
      'You are a precise knowledge graph extractor. Extract entities and relationships from text. Return only valid JSON.',
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
      'You are a precise named entity extractor. Return only valid JSON arrays.',
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
      'You are a precise relationship extractor. Return only valid JSON arrays.',
      { schema: relationshipSchema },
    )

    const relationships = Array.isArray(rawRelationships) ? rawRelationships : []

    return { entities, relationships }
  }
}
