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
  // In-memory cache: normalized name → entity. Eliminates duplicates from
  // DB LIMIT misses and timing races between addTriple calls.
  private readonly nameCache = new Map<string, SemanticEntity>()

  constructor(config: EntityResolverConfig) {
    this.store = config.store
    this.embedding = config.embedding
    this.threshold = config.similarityThreshold ?? 0.78
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
  ): Promise<{ entity: SemanticEntity; isNew: boolean }> {
    // Phase 0: In-memory cache (instant — catches all prior entities in this session)
    const normalizedName = normalizeForComparison(name)
    const cached = this.nameCache.get(normalizedName)
    if (cached) {
      const merged = this.merge(cached, { name, entityType, aliases })
      this.cacheEntity(merged)
      return { entity: merged, isNew: false }
    }
    // Also check aliases against cache
    for (const alias of aliases) {
      const cachedByAlias = this.nameCache.get(normalizeForComparison(alias))
      if (cachedByAlias) {
        const merged = this.merge(cachedByAlias, { name, entityType, aliases })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }
    }

    // Phase 1: Alias matching (cheap — uses ILIKE + ANY index)
    if (this.store.findEntities) {
      const candidates = await this.store.findEntities(name, scope, 10)
      const aliasMatch = this.findByAlias(name, aliases, candidates)
      if (aliasMatch) {
        const merged = this.merge(aliasMatch, { name, entityType, aliases })
        this.cacheEntity(merged)
        return { entity: merged, isNew: false }
      }

      // Phase 2: Normalized string matching (catches case/punctuation variants)
      for (const candidate of candidates) {
        if (normalizeForComparison(candidate.name) === normalizedName) {
          const merged = this.merge(candidate, { name, entityType, aliases })
          this.cacheEntity(merged)
          return { entity: merged, isNew: false }
        }
        for (const alias of candidate.aliases) {
          if (normalizeForComparison(alias) === normalizedName) {
            const merged = this.merge(candidate, { name, entityType, aliases })
            this.cacheEntity(merged)
            return { entity: merged, isNew: false }
          }
        }
      }
    }

    // Phase 3: Vector similarity (uses pgvector similarity score directly — no re-embedding)
    let nameEmbedding: number[] | undefined
    if (this.store.searchEntities) {
      nameEmbedding = await this.embedding.embed(name)
      const similar = await this.store.searchEntities(nameEmbedding, scope, 5)

      for (const candidate of similar) {
        // Use pgvector's cosine similarity score (stashed by adapter) instead of re-embedding
        const similarity = (candidate.properties._similarity as number | undefined)
          ?? this.cosineSimilarity(nameEmbedding, candidate.embedding ?? [])
        if (similarity >= this.threshold) {
          const merged = this.merge(candidate, { name, entityType, aliases })
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
      properties: {},
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
