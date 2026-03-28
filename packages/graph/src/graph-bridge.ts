import type { EmbeddingProvider, d8umIdentity, LLMProvider } from '@d8um/core'
import type { GraphBridge } from '@d8um/core'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { SemanticEdge } from './types/memory.js'
import type { ConversationMessage } from './extraction/extractor.js'
import { d8umMemory } from './d8um-memory.js'
import { EmbeddedGraph } from './graph/embedded-graph.js'
import { EntityResolver } from './extraction/entity-resolver.js'
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

  // ── Optional methods (graph-augmented retrieval) ──

  /**
   * Store an extracted triple in the entity graph.
   * Called by TripleExtractor during document indexing.
   * Resolves entities via EntityResolver, creates edge with chunk provenance.
   */
  async function addTriple(triple: {
    subject: string
    predicate: string
    object: string
    content: string
    bucketId: string
    chunkIndex?: number
  }): Promise<void> {
    const scope = defaultScope

    // Resolve subject and object entities (dedup via alias + vector similarity)
    const [subjectResult, objectResult] = await Promise.all([
      resolver.resolve(triple.subject, 'entity', [], scope),
      resolver.resolve(triple.object, 'entity', [], scope),
    ])

    // Persist entities
    await Promise.all([
      graph.addEntity(subjectResult.entity),
      graph.addEntity(objectResult.entity),
    ])

    // Normalize predicate to SCREAMING_SNAKE_CASE
    const relation = triple.predicate
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^A-Z0-9_]/g, '')

    // Create edge with chunk provenance stored in properties
    const edge: SemanticEdge = {
      id: randomUUID(),
      sourceEntityId: subjectResult.entity.id,
      targetEntityId: objectResult.entity.id,
      relation,
      weight: 1.0,
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

    // First pass: get edges for seed entities, collect neighbor IDs
    for (const entityId of entityIds) {
      const edges = await graph.getEdges(entityId, 'both')
      for (const edge of edges) {
        neighborEdges.push(edge)
        allEntityIds.add(edge.sourceEntityId)
        allEntityIds.add(edge.targetEntityId)
      }
    }

    // Second pass: get edges for 1-hop neighbors (2-hop expansion)
    const newNeighborIds = [...allEntityIds].filter(id => !entityIds.includes(id))
    for (const entityId of newNeighborIds) {
      const edges = await graph.getEdges(entityId, 'both')
      neighborEdges.push(...edges)
    }

    // Deduplicate edges by ID and build bidirectional adjacency
    const seenEdges = new Set<string>()
    for (const edge of neighborEdges) {
      if (seenEdges.has(edge.id)) continue
      seenEdges.add(edge.id)

      addEdgeToAdjacency(edge.sourceEntityId, edge.targetEntityId, edge.weight)
      addEdgeToAdjacency(edge.targetEntityId, edge.sourceEntityId, edge.weight)
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

    for (const entityId of entityIds) {
      const edges = await graph.getEdges(entityId, 'both')
      for (const edge of edges) {
        const content = edge.properties.content as string | undefined
        const bucketId = edge.properties.bucketId as string | undefined

        if (content && bucketId) {
          // Deduplicate by content hash (bucketId + content prefix)
          const key = `${bucketId}:${content.slice(0, 100)}`
          if (!seen.has(key)) {
            seen.add(key)
            // Use PPR score of the entity that led us to this chunk, fall back to edge weight
            const score = pprScores?.get(entityId) ?? edge.weight
            chunks.push({ content, bucketId, score })
          }
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
    addTriple,
    searchEntities,
    getAdjacencyList,
    getChunksForEntities,
  }
}
