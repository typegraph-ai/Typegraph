import type { EmbeddingProvider, d8umIdentity, LLMProvider } from '@d8um/core'
import type { GraphBridge } from '@d8um/core'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { SemanticEdge } from './types/memory.js'
import type { ConversationMessage } from './extraction/extractor.js'
import { d8umMemory } from './d8um-memory.js'
import { EmbeddedGraph } from './graph/embedded-graph.js'
import { EntityResolver } from './extraction/entity-resolver.js'
import { PredicateNormalizer } from './extraction/predicate-normalizer.js'
import { createTemporal } from './temporal.js'
import { scopeKey } from './types/scope.js'
import { randomUUID } from 'crypto'

// ── Config ──

export interface CreateGraphBridgeConfig {
  memoryStore: MemoryStoreAdapter
  embedding: EmbeddingProvider
  llm: LLMProvider
  /** Default scope for addTriple (which has no per-call identity) */
  scope?: d8umIdentity
}

// ── Factory ──

/**
 * Create a unified GraphBridge that composes d8umMemory + EmbeddedGraph + EntityResolver.
 * Implements all required AND optional GraphBridge methods so that neural query mode
 * (PPR graph traversal via GraphRunner) works without silent fallback to hybrid.
 */
export function createGraphBridge(config: CreateGraphBridgeConfig): GraphBridge {
  const { memoryStore, embedding, llm } = config
  const defaultScope: d8umIdentity = config.scope ?? { agentId: 'd8um-graph' }

  const graph = new EmbeddedGraph(memoryStore)
  const resolver = new EntityResolver({ store: memoryStore, embedding })
  const predicateNormalizer = new PredicateNormalizer(embedding)

  // Cache d8umMemory instances per identity scope
  const memoryCache = new Map<string, d8umMemory>()

  function getMemory(identity: d8umIdentity): d8umMemory {
    const key = scopeKey(identity)
    let mem = memoryCache.get(key)
    if (!mem) {
      mem = new d8umMemory({ memoryStore, embedding, llm, scope: identity })
      memoryCache.set(key, mem)
    }
    return mem
  }

  // ── Required methods (delegate to d8umMemory) ──

  async function remember(content: string, identity: d8umIdentity, category?: string): Promise<unknown> {
    const mem = getMemory(identity)
    return mem.remember(content, (category as 'episodic' | 'semantic' | 'procedural') ?? 'semantic')
  }

  async function forget(id: string): Promise<void> {
    await memoryStore.invalidate(id)
  }

  async function correct(correction: string, identity: d8umIdentity) {
    const mem = getMemory(identity)
    return mem.correct(correction)
  }

  async function addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: d8umIdentity,
    sessionId?: string,
  ): Promise<unknown> {
    const mem = getMemory(identity)
    return mem.addConversationTurn(messages as ConversationMessage[], sessionId)
  }

  async function recall(query: string, identity: d8umIdentity, opts?: { limit?: number; types?: string[] }): Promise<unknown[]> {
    const mem = getMemory(identity)
    return mem.recall(query, {
      limit: opts?.limit,
      types: opts?.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
    })
  }

  // ── Memory check (cached) ──

  let memoriesChecked = false
  let memoriesExist = false

  async function hasMemories(): Promise<boolean> {
    if (memoriesChecked) return memoriesExist
    try {
      const results = await memoryStore.list({ status: 'active' }, 1)
      memoriesExist = results.length > 0
    } catch {
      memoriesExist = false
    }
    memoriesChecked = true
    return memoriesExist
  }

  // ── Optional methods (graph-augmented retrieval) ──

  /**
   * Store an extracted triple in the entity graph.
   * Called by TripleExtractor during document indexing.
   * Resolves entities via EntityResolver, creates edge with chunk provenance.
   */
  // Generic predicates that add noise without information — filter these out
  const GENERIC_PREDICATES = new Set([
    'IS', 'IS_A', 'IS_AN', 'HAS', 'HAS_A', 'RELATED_TO',
    'ASSOCIATED_WITH', 'INVOLVES', 'INCLUDES', 'CONTAINS',
  ])

  // Track entities per chunk for co-occurrence edge creation (Improvement 8)
  // Key: chunk content hash, Value: set of entity IDs seen in that chunk
  const chunkEntityMap = new Map<string, Set<string>>()
  // Track direct edges to avoid redundant CO_OCCURS edges
  const directEdgePairs = new Set<string>()

  async function addTriple(triple: {
    subject: string
    subjectType?: string
    subjectAliases?: string[]
    predicate: string
    object: string
    objectType?: string
    objectAliases?: string[]
    confidence?: number
    content: string
    bucketId: string
    chunkIndex?: number
  }): Promise<void> {
    const scope = defaultScope

    // Normalize predicate to SCREAMING_SNAKE_CASE
    let relation = triple.predicate
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^A-Z0-9_]/g, '')

    // Filter out generic predicates that add noise
    if (GENERIC_PREDICATES.has(relation)) return

    // Cluster semantically equivalent predicates (e.g., PLAYS_FOR ≈ IS_A_PLAYER_FOR)
    relation = await predicateNormalizer.normalize(relation)

    // Resolve subject and object entities (dedup via alias + vector similarity)
    const [subjectResult, objectResult] = await Promise.all([
      resolver.resolve(triple.subject, triple.subjectType ?? 'entity', triple.subjectAliases ?? [], scope),
      resolver.resolve(triple.object, triple.objectType ?? 'entity', triple.objectAliases ?? [], scope),
    ])

    // Persist entities
    await Promise.all([
      graph.addEntity(subjectResult.entity),
      graph.addEntity(objectResult.entity),
    ])

    // Use LLM confidence as edge weight (default 1.0 for backward compat)
    const weight = triple.confidence ?? 1.0

    // Create edge with chunk provenance stored in properties
    const edge: SemanticEdge = {
      id: randomUUID(),
      sourceEntityId: subjectResult.entity.id,
      targetEntityId: objectResult.entity.id,
      relation,
      weight,
      properties: {
        content: triple.content,
        bucketId: triple.bucketId,
        ...(triple.chunkIndex !== undefined ? { chunkIndex: triple.chunkIndex } : {}),
      },
      scope,
      temporal: createTemporal(),
      evidence: [],
    }

    await graph.addEdge(edge)

    // Track direct edge pair to avoid redundant CO_OCCURS
    const pairKey = [subjectResult.entity.id, objectResult.entity.id].sort().join(':')
    directEdgePairs.add(pairKey)

    // Track entities per chunk for co-occurrence edges
    const chunkKey = `${triple.bucketId}:${triple.chunkIndex ?? 0}`
    let chunkEntities = chunkEntityMap.get(chunkKey)
    if (!chunkEntities) {
      chunkEntities = new Set()
      chunkEntityMap.set(chunkKey, chunkEntities)
    }
    const newEntityIds = [subjectResult.entity.id, objectResult.entity.id]
    const existingIds = [...chunkEntities]

    for (const newId of newEntityIds) {
      if (chunkEntities.has(newId)) continue
      // Create CO_OCCURS edges with existing entities in this chunk
      for (const existingId of existingIds) {
        const coKey = [newId, existingId].sort().join(':')
        if (directEdgePairs.has(coKey)) continue // skip if direct edge exists

        const coEdge: SemanticEdge = {
          id: randomUUID(),
          sourceEntityId: newId,
          targetEntityId: existingId,
          relation: 'CO_OCCURS',
          weight: 0.3, // Lower weight than explicit triples
          properties: { bucketId: triple.bucketId },
          scope,
          temporal: createTemporal(),
          evidence: [],
        }
        await graph.addEdge(coEdge)
      }
      chunkEntities.add(newId)
    }
  }

  /**
   * Search entities by embedding similarity.
   * Used by GraphRunner to seed PPR with entities matching the query.
   */
  async function searchEntities(
    query: string,
    identity: d8umIdentity,
    limit: number = 10,
  ): Promise<Array<{ id: string; name: string; entityType: string }>> {
    if (!memoryStore.searchEntities) return []

    const queryEmbedding = await embedding.embed(query)
    const entities = await memoryStore.searchEntities(queryEmbedding, identity, limit)

    return entities.map(e => ({
      id: e.id,
      name: e.name,
      entityType: e.entityType,
    }))
  }

  /**
   * Build adjacency list for PPR from entity edges.
   * Adds bidirectional edges since the PPR in graph-runner.ts only follows outgoing edges.
   * Expands 1 hop beyond seed entities to give PPR a richer subgraph.
   */
  async function getAdjacencyList(
    entityIds: string[],
  ): Promise<Map<string, Array<{ target: string; weight: number }>>> {
    const adjacency = new Map<string, Array<{ target: string; weight: number }>>()

    function addEdgeToAdjacency(from: string, to: string, weight: number) {
      let list = adjacency.get(from)
      if (!list) {
        list = []
        adjacency.set(from, list)
      }
      // Accumulate weights: more edges between same entities = stronger connection
      const existing = list.find(e => e.target === to)
      if (existing) {
        existing.weight += weight
      } else {
        list.push({ target: to, weight })
      }
    }

    // Collect all entity IDs including 1-hop neighbors
    const allEntityIds = new Set(entityIds)
    const neighborEdges: SemanticEdge[] = []

    // First pass: batch-load edges for seed entities, collect neighbor IDs
    const seedEdges = await graph.getEdgesBatch(entityIds, 'both')
    for (const edge of seedEdges) {
      neighborEdges.push(edge)
      allEntityIds.add(edge.sourceEntityId)
      allEntityIds.add(edge.targetEntityId)
    }

    // Second pass: batch-load edges for 1-hop neighbors (2-hop expansion)
    const newNeighborIds = [...allEntityIds].filter(id => !entityIds.includes(id))
    if (newNeighborIds.length > 0) {
      const hopEdges = await graph.getEdgesBatch(newNeighborIds, 'both')
      neighborEdges.push(...hopEdges)
    }

    // Deduplicate edges by ID and build bidirectional adjacency
    const seenEdges = new Set<string>()
    for (const edge of neighborEdges) {
      if (seenEdges.has(edge.id)) continue
      seenEdges.add(edge.id)

      addEdgeToAdjacency(edge.sourceEntityId, edge.targetEntityId, edge.weight)
      addEdgeToAdjacency(edge.targetEntityId, edge.sourceEntityId, edge.weight)
    }

    // Log-scale accumulated weights to prevent extreme PPR concentration.
    // Without this, an entity pair with 50 parallel edges (weight 50) dominates
    // transition probabilities (50/52 = 96%), making PPR too narrow.
    // Log2: 1→1.0, 2→1.58, 10→3.46, 50→5.67 — preserves ranking, reduces dominance.
    for (const [, edges] of adjacency) {
      for (const edge of edges) {
        edge.weight = Math.log2(1 + edge.weight)
      }
    }

    return adjacency
  }

  /**
   * Get chunk content associated with entities by reading edge properties.
   * Chunk provenance (content + bucketId) is stored during addTriple.
   */
  async function getChunksForEntities(
    entityIds: string[],
    limit: number = 20,
    pprScores?: Map<string, number>,
  ): Promise<Array<{ content: string; bucketId: string; score: number }>> {
    const seen = new Set<string>()
    const chunks: Array<{ content: string; bucketId: string; score: number }> = []

    // Batch-load all edges for the entity list
    const allEdges = await graph.getEdgesBatch(entityIds, 'both')

    // Build entity→edge mapping for PPR score lookup
    const entityIdSet = new Set(entityIds)
    for (const edge of allEdges) {
      const content = edge.properties.content as string | undefined
      const bucketId = edge.properties.bucketId as string | undefined

      if (content && bucketId) {
        // Deduplicate by content hash (bucketId + content prefix)
        const key = `${bucketId}:${content.slice(0, 100)}`
        if (!seen.has(key)) {
          seen.add(key)
          // Use PPR score of the entity that led us to this chunk, fall back to edge weight
          const linkedEntityId = entityIdSet.has(edge.sourceEntityId) ? edge.sourceEntityId : edge.targetEntityId
          const score = pprScores?.get(linkedEntityId) ?? edge.weight
          chunks.push({ content, bucketId, score })
        }
      }
    }

    // Sort by score descending, limit
    chunks.sort((a, b) => b.score - a.score)
    return chunks.slice(0, limit)
  }

  // ── Compose bridge ──

  return {
    remember,
    forget,
    correct,
    addConversationTurn,
    recall,
    hasMemories,
    addTriple,
    searchEntities,
    getAdjacencyList,
    getChunksForEntities,
  }
}
