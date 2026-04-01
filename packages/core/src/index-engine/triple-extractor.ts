import type { LLMProvider } from '../types/llm-provider.js'
import type { GraphBridge } from '../types/graph-bridge.js'
import { getPredicatesForPrompt } from './ontology.js'

export interface TripleExtractorConfig {
  /** LLM for entity extraction (Pass 1 in two-pass mode) or the single combined call. */
  llm: LLMProvider
  /** LLM for relationship extraction (Pass 2 in two-pass mode). Falls back to llm. */
  relationshipLlm?: LLMProvider | undefined
  graph: GraphBridge
  /** Use two separate LLM calls instead of one combined call. Default: false. */
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

const VALID_ENTITY_TYPES = new Set([
  'person', 'organization', 'location', 'product', 'concept', 'event',
  'work_of_art', 'technology', 'law_regulation', 'time_period',
])

const ENTITY_TYPES_LIST = [...VALID_ENTITY_TYPES].join(', ')

// ── Single-pass prompt (default) ──

function buildSinglePassPrompt(content: string, entityContext?: EntityContext[]): string {
  const contextSection = entityContext?.length
    ? `\nPreviously identified entities in this document:\n${entityContext.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nUse these names when the text refers to these entities by pronoun, abbreviation, or epithet.\n`
    : ''

  return `Extract all named entities and relationships from the following text.
${contextSection}
## Step 1: Entity Extraction

For each entity, provide:
- "name": The canonical name of the entity
- "type": One of: ${ENTITY_TYPES_LIST}
- "description": A one-sentence description of this entity based on the text
- "aliases": Other names or abbreviations used for THIS entity in the text (array of strings)

Entity rules:
- Only extract specific named entities — NOT dates, dollar amounts, percentages, or generic descriptions
- If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list all as aliases
- Aliases must be alternative names for THIS entity only — do NOT include unrelated names, titles of works containing the entity name, or descriptions
- Include entities even if they only appear once

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
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN" — use DESCRIBED instead)
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

// ── Two-pass prompts (legacy) ──

const ENTITY_EXTRACTION_PROMPT = `Extract all named entities from the following text.

For each entity, provide:
- "name": The canonical name of the entity as it appears in the text
- "type": One of: ${ENTITY_TYPES_LIST}
- "description": A one-sentence description of this entity based on the text
- "aliases": Other names or abbreviations used for THIS entity in the text (array of strings)

Rules:
- Only extract specific named entities — NOT dates, dollar amounts, percentages, or generic descriptions
- If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list all as aliases
- Aliases must be alternative names for THIS entity only — do NOT include unrelated names, titles of works containing the entity name, or descriptions
- Include entities even if they only appear once
- Return an empty array if no named entities exist

Return a JSON array: [{"name": "...", "type": "...", "description": "...", "aliases": ["..."]}, ...]

Text:
`

function buildRelationshipPrompt(entitiesJson: string): string {
  return `Given the following text and a list of known entities, extract all relationships between these entities.

Entities found in this text:
${entitiesJson}

For each relationship, provide:
- "subject": Must be one of the entity names listed above
- "predicate": A canonical relationship verb from the vocabulary below
- "object": Must be one of the entity names listed above
- "confidence": How confident you are this relationship is stated or strongly implied (0.0 to 1.0)

${getPredicatesForPrompt()}

Rules:
- Subject and object MUST be from the entity list above — do not introduce new entities
- ALWAYS prefer a predicate from the vocabulary above. Only invent a new predicate if NONE fit.
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN" — use DESCRIBED instead)
- Use the most specific predicate that accurately captures the relationship
- Extract relationships that are explicitly stated or strongly implied in the text
- Return an empty array if no clear relationships exist between the listed entities

Example:

Entities: [{"name": "Margaret Ashworth", "type": "person"}, {"name": "Edmund Ashworth", "type": "person"}, {"name": "The Geographical Society", "type": "organization"}, {"name": "Cairo", "type": "location"}, {"name": "Oxford", "type": "location"}, {"name": "Helena Voss", "type": "person"}, {"name": "Principles of Navigation", "type": "work_of_art"}]

Text: "Margaret Ashworth had lived in Oxford since her marriage to Edmund, who served as president of The Geographical Society. It was through Edmund's influence that she first traveled to Cairo, where she met the renowned cartographer Helena Voss. The two women corresponded for years, and Helena's bold methods deeply influenced Margaret's own work. Margaret eventually wrote Principles of Navigation, which many regarded as a challenge to Edmund's more traditional views on the subject. Helena, who had once taught at Oxford before the Society forced her departure, remained Margaret's closest intellectual ally."

Relationships:
[{"subject": "Margaret Ashworth", "predicate": "LIVED_IN", "object": "Oxford", "confidence": 0.95},
{"subject": "Margaret Ashworth", "predicate": "MARRIED", "object": "Edmund Ashworth", "confidence": 0.95},
{"subject": "Edmund Ashworth", "predicate": "LEADS", "object": "The Geographical Society", "confidence": 0.9},
{"subject": "Margaret Ashworth", "predicate": "TRAVELED_TO", "object": "Cairo", "confidence": 0.9},
{"subject": "Edmund Ashworth", "predicate": "INFLUENCED", "object": "Margaret Ashworth", "confidence": 0.85},
{"subject": "Helena Voss", "predicate": "CORRESPONDS_WITH", "object": "Margaret Ashworth", "confidence": 0.9},
{"subject": "Helena Voss", "predicate": "INFLUENCED", "object": "Margaret Ashworth", "confidence": 0.9},
{"subject": "Margaret Ashworth", "predicate": "WROTE", "object": "Principles of Navigation", "confidence": 0.95},
{"subject": "Margaret Ashworth", "predicate": "OPPOSED", "object": "Edmund Ashworth", "confidence": 0.75},
{"subject": "Helena Voss", "predicate": "TAUGHT", "object": "Oxford", "confidence": 0.85},
{"subject": "Helena Voss", "predicate": "COLLABORATED_WITH", "object": "Margaret Ashworth", "confidence": 0.9}]

Return a JSON array: [{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.9}, ...]

Now extract relationships from the following text:
`
}

// ── Extractor ──

export class TripleExtractor {
  private llm: LLMProvider
  private relationshipLlm: LLMProvider
  private graph: GraphBridge
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
  ): Promise<{ entities: EntityContext[] } | undefined> {
    if (!this.graph.addTriple) return undefined

    try {
      const { entities, relationships } = this.twoPass
        ? await this.extractTwoPass(content, entityContext)
        : await this.extractSinglePass(content, entityContext)

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
    } catch {
      // Triple extraction failures should not block indexing
      return undefined
    }
  }

  /** Single combined LLM call for entities + relationships (default). */
  private async extractSinglePass(
    content: string,
    entityContext?: EntityContext[],
  ): Promise<ExtractionResult> {
    const prompt = buildSinglePassPrompt(content, entityContext)
    const result = await this.llm.generateJSON<ExtractionResult>(
      prompt,
      'You are a precise knowledge graph extractor. Extract entities and relationships from text. Return only valid JSON.',
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

  /** Two separate LLM calls: entities first, then relationships (legacy). */
  private async extractTwoPass(
    content: string,
    entityContext?: EntityContext[],
  ): Promise<ExtractionResult> {
    // Build entity context prefix for the prompt
    const contextPrefix = entityContext?.length
      ? `Previously identified entities in this document:\n${entityContext.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nUse these names when the text refers to these entities by pronoun or abbreviation.\n\n`
      : ''

    // Pass 1: Extract entities
    const rawEntities = await this.llm.generateJSON<ExtractedEntity[]>(
      contextPrefix + ENTITY_EXTRACTION_PROMPT + content,
      'You are a precise named entity extractor. Return only valid JSON arrays.',
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
    const prompt = buildRelationshipPrompt(entitiesJson) + content

    const rawRelationships = await this.relationshipLlm.generateJSON<ExtractedRelationship[]>(
      prompt,
      'You are a precise relationship extractor. Return only valid JSON arrays.',
    )

    const relationships = Array.isArray(rawRelationships) ? rawRelationships : []

    return { entities, relationships }
  }
}
