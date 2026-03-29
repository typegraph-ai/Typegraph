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
- "predicate": A specific relationship verb/phrase (e.g., "founded", "acquired", "located_in", "announced")
- "object": Must be one of the entity names listed above
- "confidence": How confident you are this relationship is explicitly stated (0.0 to 1.0)

Rules:
- Subject and object MUST be from the entity list above — do not introduce new entities
- Predicate should be a specific verb, not generic (avoid "is", "has", "related_to")
- Only extract relationships explicitly stated or strongly implied in the text
- Return an empty array if no clear relationships exist between the listed entities

Return a JSON array: [{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.9}, ...]

Text:
`

const VALID_ENTITY_TYPES = new Set(['person', 'organization', 'location', 'product', 'concept', 'event'])

export class TripleExtractor {
  private llm: LLMProvider
  private graph: GraphBridge

  constructor(config: TripleExtractorConfig) {
    this.llm = config.llm
    this.graph = config.graph
  }

  async extractFromChunk(content: string, bucketId: string, chunkIndex?: number): Promise<void> {
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
        }
        if (chunkIndex !== undefined) tripleData.chunkIndex = chunkIndex
        await this.graph.addTriple(tripleData)
      }
    } catch {
      // Triple extraction failures should not block indexing
    }
  }
}
