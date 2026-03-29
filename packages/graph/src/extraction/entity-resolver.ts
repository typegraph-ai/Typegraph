import type { EmbeddingProvider } from '@d8um/core'
import type { d8umIdentity } from '@d8um/core'
import type { SemanticEntity } from '../types/memory.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import { createTemporal } from '../temporal.js'
import { randomUUID } from 'crypto'

// ── Entity Resolver ──
// Deduplicates entities using a 3-phase cascade:
//   Phase 1: Exact alias matching (cheapest)
//   Phase 2: Normalized string matching (catches case/punctuation variants)
//   Phase 3: Vector similarity on name embeddings (catches semantic equivalents)

export interface EntityResolverConfig {
  store: MemoryStoreAdapter
  embedding: EmbeddingProvider
  /** Cosine similarity threshold for considering entities as duplicates. Default: 0.78 */
  similarityThreshold?: number | undefined
}

export class EntityResolver {
  private readonly store: MemoryStoreAdapter
  private readonly embedding: EmbeddingProvider
  private readonly threshold: number

  constructor(config: EntityResolverConfig) {
    this.store = config.store
    this.embedding = config.embedding
    this.threshold = config.similarityThreshold ?? 0.78
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
  ): Promise<{ entity: SemanticEntity; isNew: boolean }> {
    // Phase 1: Alias matching (cheap — uses ILIKE + ANY index)
    if (this.store.findEntities) {
      const candidates = await this.store.findEntities(name, scope, 10)
      const aliasMatch = this.findByAlias(name, aliases, candidates)
      if (aliasMatch) {
        const merged = this.merge(aliasMatch, { name, entityType, aliases })
        return { entity: merged, isNew: false }
      }

      // Phase 2: Normalized string matching (catches case/punctuation variants)
      const normalizedName = normalizeForComparison(name)
      for (const candidate of candidates) {
        if (normalizeForComparison(candidate.name) === normalizedName) {
          const merged = this.merge(candidate, { name, entityType, aliases })
          return { entity: merged, isNew: false }
        }
        for (const alias of candidate.aliases) {
          if (normalizeForComparison(alias) === normalizedName) {
            const merged = this.merge(candidate, { name, entityType, aliases })
            return { entity: merged, isNew: false }
          }
        }
      }
    }

    // Phase 3: Vector similarity (most expensive — embedding + cosine)
    if (this.store.searchEntities) {
      const nameEmbedding = await this.embedding.embed(name)
      const similar = await this.store.searchEntities(nameEmbedding, scope, 5)

      for (const candidate of similar) {
        // searchEntities returns results ordered by DB cosine similarity,
        // but the entity's embedding is not returned (set to undefined in mapRowToEntity).
        // Re-embed and compare if the candidate has no embedding, or use DB ordering.
        // Since DB already orders by cosine distance, the top result is the best match.
        // We need to check if the DB-computed similarity meets our threshold.
        // The candidate.embedding is undefined (optimization in mapRowToEntity),
        // so we trust the DB ordering and check via re-embedding.
        const candidateEmbedding = await this.embedding.embed(candidate.name)
        const similarity = this.cosineSimilarity(nameEmbedding, candidateEmbedding)
        if (similarity >= this.threshold) {
          const merged = this.merge(candidate, { name, entityType, aliases })
          return { entity: merged, isNew: false }
        }
      }
    }

    // No match found - create new entity with embedding
    const nameEmbedding = await this.embedding.embed(name)
    const entity: SemanticEntity = {
      id: randomUUID(),
      name,
      entityType,
      aliases,
      properties: {},
      embedding: nameEmbedding,
      scope,
      temporal: createTemporal(),
    }

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
    incoming: { name: string; entityType: string; aliases: string[] },
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

    return {
      ...existing,
      aliases: newAliases,
      // Keep existing type unless it's generic and incoming is more specific
      entityType: (existing.entityType === 'entity' || existing.entityType === 'other')
        ? incoming.entityType
        : existing.entityType,
    }
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
