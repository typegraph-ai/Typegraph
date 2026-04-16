import type { typegraphIdentity } from '../../types/identity.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { MemoryStoreAdapter, SemanticEntity, SemanticEdge } from '../../memory/types/index.js'
import { generateId } from '../../utils/id.js'

export interface EntityLinkerConfig {
  embedding: EmbeddingProvider
  store: MemoryStoreAdapter
  /** Cosine similarity threshold for creating synonym edges. Default: 0.85 */
  similarityThreshold?: number
}

export interface EntityLinkResult {
  synonymEdgesCreated: number
  entitiesScanned: number
}

/**
 * Detects and links equivalent entities across different buckets using embedding similarity.
 * When two entities from different buckets have high cosine similarity, a SYNONYM edge is created.
 * PPR traverses synonym edges, enabling cross-bucket associative retrieval.
 */
export class EntityLinker {
  private embedding: EmbeddingProvider
  private store: MemoryStoreAdapter
  private threshold: number

  constructor(config: EntityLinkerConfig) {
    this.embedding = config.embedding
    this.store = config.store
    this.threshold = config.similarityThreshold ?? 0.85
  }

  /**
   * Scan entities across buckets and create SYNONYM edges where similarity exceeds threshold.
   */
  async linkAcrossBuckets(identity: typegraphIdentity): Promise<EntityLinkResult> {
    if (!this.store.searchEntities || !this.store.upsertEdge) {
      return { synonymEdgesCreated: 0, entitiesScanned: 0 }
    }

    // Get all entities in scope
    const entities = await this.store.findEntities?.('', identity, 1000) ?? []
    if (entities.length < 2) return { synonymEdgesCreated: 0, entitiesScanned: entities.length }

    let synonymEdgesCreated = 0

    // For each entity, find similar entities via embedding
    for (const entity of entities) {
      if (!entity.embedding || entity.embedding.length === 0) continue

      const similar = await this.store.searchEntities(entity.embedding, identity, 10)

      for (const candidate of similar) {
        if (candidate.id === entity.id) continue

        // Calculate similarity
        const similarity = this.cosineSimilarity(entity.embedding, candidate.embedding ?? [])
        if (similarity < this.threshold) continue

        // Check if synonym edge already exists
        const existingEdges = await this.store.findEdges?.(entity.id, candidate.id, 'SYNONYM') ?? []
        if (existingEdges.length > 0) continue

        // Create synonym edge
        const edge: SemanticEdge = {
          id: generateId('edge'),
          sourceEntityId: entity.id,
          targetEntityId: candidate.id,
          relation: 'SYNONYM',
          weight: similarity,
          properties: { detectedBy: 'entity-linker', threshold: this.threshold },
          scope: identity,
          temporal: { validAt: new Date(), createdAt: new Date() },
          evidence: [],
        }

        await this.store.upsertEdge(edge)
        synonymEdgesCreated++
      }
    }

    return { synonymEdgesCreated, entitiesScanned: entities.length }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!
      normA += a[i]! * a[i]!
      normB += b[i]! * b[i]!
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }
}
