import type { LLMProvider } from '../types/llm-provider.js'
import type { GraphBridge } from '../types/graph-bridge.js'

export interface TripleExtractorConfig {
  llm: LLMProvider
  graph: GraphBridge
}

// ── Pass 1: Entity Extraction ──

interface ExtractedEntity {
  name: string
  type: string
  description: string
  aliases: string[]
}

const ENTITY_EXTRACTION_PROMPT = `Extract all named entities from the following text.

For each entity, provide:
- "name": The canonical name of the entity as it appears in the text
- "type": One of: person, organization, location, product, concept, event
- "description": A one-sentence description of this entity based on the text
- "aliases": Other names or abbreviations used for this entity in the text (array of strings)

Rules:
- Only extract specific named entities — NOT dates, dollar amounts, percentages, or generic descriptions
- If an entity is referred to by multiple names (e.g., "OpenAI" and "the company"), list all as aliases
- Include entities even if they only appear once
- Return an empty array if no named entities exist

Return a JSON array: [{"name": "...", "type": "...", "description": "...", "aliases": ["..."]}, ...]

Text:
`

// ── Pass 2: Relationship Extraction ──

interface ExtractedRelationship {
  subject: string
  predicate: string
  object: string
  confidence: number
}

const RELATIONSHIP_EXTRACTION_PROMPT = `Given the following text and a list of known entities, extract all relationships between these entities.

Entities found in this text:
{entities_json}

For each relationship, provide:
- "subject": Must be one of the entity names listed above
- "predicate": A canonical relationship verb from the list below
- "object": Must be one of the entity names listed above
- "confidence": How confident you are this relationship is stated or strongly implied (0.0 to 1.0)

Predicate MUST be chosen from this controlled vocabulary when applicable:
WROTE, VISITED, LOCATED_IN, MEMBER_OF, FOUNDED, ACQUIRED, PUBLISHED, WORKS_FOR,
MARRIED, BORN_IN, DIED_IN, CREATED, DESCRIBED, COMPARED_WITH,
INFLUENCED, TRANSLATED, EDITED, REVIEWED, STUDIED, TRAVELED_TO, LIVED_IN,
RULED, FOUGHT_IN, PARTICIPATED_IN, OWNS, PRODUCED, PERFORMED_IN,
COLLABORATED_WITH, CORRESPONDS_WITH, PART_OF, CONTAINS,
CAUSED, LED_TO, PRECEDED, FOLLOWED, OPPOSED, SUPPORTED, EMPLOYED,
INVESTED_IN, PARTNERED_WITH, DEVELOPED, DISCOVERED, TAUGHT, ATTENDED,
SPOKE_AT, REPORTED, ANNOUNCED, AWARDED, NOMINATED, TREATED, DIAGNOSED

Rules:
- Subject and object MUST be from the entity list above — do not introduce new entities
- ALWAYS prefer a predicate from the list above. Only invent a new predicate if NONE of the above fit.
- Never create compound predicates (e.g., "MENTIONED_COOKING_IN" — use DESCRIBED instead)
- Use the most specific predicate that accurately captures the relationship — avoid vague predicates
- Extract relationships that are explicitly stated or strongly implied in the text. Include implied relationships only when the inference is clear from context.
- Return an empty array if no clear relationships exist between the listed entities

Example:

Entities: [{"name": "Margaret Ashworth", "type": "person"}, {"name": "Edmund Ashworth", "type": "person"}, {"name": "The Geographical Society", "type": "organization"}, {"name": "Cairo", "type": "location"}, {"name": "Oxford", "type": "location"}, {"name": "Helena Voss", "type": "person"}, {"name": "Principles of Navigation", "type": "product"}]

Text: "Margaret Ashworth had lived in Oxford since her marriage to Edmund, who served as president of The Geographical Society. It was through Edmund's influence that she first traveled to Cairo, where she met the renowned cartographer Helena Voss. The two women corresponded for years, and Helena's bold methods deeply influenced Margaret's own work. Margaret eventually wrote Principles of Navigation, which many regarded as a challenge to Edmund's more traditional views on the subject. Helena, who had once taught at Oxford before the Society forced her departure, remained Margaret's closest intellectual ally."

Relationships:
[{"subject": "Margaret Ashworth", "predicate": "LIVED_IN", "object": "Oxford", "confidence": 0.95},
{"subject": "Margaret Ashworth", "predicate": "MARRIED", "object": "Edmund Ashworth", "confidence": 0.95},
{"subject": "Edmund Ashworth", "predicate": "MEMBER_OF", "object": "The Geographical Society", "confidence": 0.9},
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

const VALID_ENTITY_TYPES = new Set(['person', 'organization', 'location', 'product', 'concept', 'event'])

export class TripleExtractor {
  private llm: LLMProvider
  private graph: GraphBridge

  constructor(config: TripleExtractorConfig) {
    this.llm = config.llm
    this.graph = config.graph
  }

  async extractFromChunk(content: string, bucketId: string, chunkIndex?: number, documentId?: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.graph.addTriple) return

    try {
      // Pass 1: Extract entities
      const rawEntities = await this.llm.generateJSON<ExtractedEntity[]>(
        ENTITY_EXTRACTION_PROMPT + content,
        'You are a precise named entity extractor. Return only valid JSON arrays.'
      )

      if (!Array.isArray(rawEntities)) return

      // Filter to valid entity types
      const entities = rawEntities.filter(e =>
        e.name && e.type && VALID_ENTITY_TYPES.has(e.type)
      )

      // Need at least 2 entities to extract relationships
      if (entities.length < 2) return

      // Pass 2: Extract relationships using known entities
      const entitiesJson = JSON.stringify(entities.map(e => ({ name: e.name, type: e.type })))
      const prompt = RELATIONSHIP_EXTRACTION_PROMPT.replace('{entities_json}', entitiesJson) + content

      const rawRelationships = await this.llm.generateJSON<ExtractedRelationship[]>(
        prompt,
        'You are a precise relationship extractor. Return only valid JSON arrays.'
      )

      if (!Array.isArray(rawRelationships)) return

      // Build entity lookup for validation and metadata
      const entityByName = new Map<string, ExtractedEntity>()
      for (const e of entities) {
        entityByName.set(e.name.toLowerCase(), e)
      }

      // Validate and emit triples
      for (const rel of rawRelationships) {
        if (!rel.subject || !rel.predicate || !rel.object) continue

        const subjectEntity = entityByName.get(rel.subject.toLowerCase())
        const objectEntity = entityByName.get(rel.object.toLowerCase())

        // Both subject and object must be from the known entity list
        if (!subjectEntity || !objectEntity) continue

        const tripleData: {
          subject: string
          subjectType: string
          subjectAliases: string[]
          predicate: string
          object: string
          objectType: string
          objectAliases: string[]
          confidence: number
          content: string
          bucketId: string
          chunkIndex?: number
          documentId?: string
          metadata?: Record<string, unknown>
        } = {
          subject: subjectEntity.name,
          subjectType: subjectEntity.type,
          subjectAliases: subjectEntity.aliases ?? [],
          predicate: rel.predicate,
          object: objectEntity.name,
          objectType: objectEntity.type,
          objectAliases: objectEntity.aliases ?? [],
          confidence: typeof rel.confidence === 'number' ? Math.max(0, Math.min(1, rel.confidence)) : 1.0,
          content,
          bucketId,
          ...(documentId ? { documentId } : {}),
          ...(metadata ? { metadata } : {}),
        }
        if (chunkIndex !== undefined) tripleData.chunkIndex = chunkIndex
        await this.graph.addTriple(tripleData)
      }
    } catch {
      // Triple extraction failures should not block indexing
    }
  }
}
