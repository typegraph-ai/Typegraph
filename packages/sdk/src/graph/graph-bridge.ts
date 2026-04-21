import type { EmbeddingProvider } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { typegraphIdentity } from '../types/identity.js'
import type { EmbeddingConfig } from '../types/bucket.js'
import type { KnowledgeGraphBridge, EntityDetail, EdgeResult, SubgraphOpts, SubgraphResult, GraphStats } from '../types/graph-bridge.js'
import { resolveEmbeddingProvider } from '../typegraph.js'
import type { MemoryStoreAdapter, SemanticEdge } from '../memory/types/index.js'
import { EntityResolver, PredicateNormalizer, createTemporal } from '../memory/index.js'
import { EmbeddedGraph } from './graph/embedded-graph.js'
import { generateId } from '../utils/id.js'

// ── Config ──

export interface CreateKnowledgeGraphBridgeConfig {
  memoryStore: MemoryStoreAdapter
  /** Embedding provider — pass a resolved EmbeddingProvider or an AI SDK embedding input ({ model, dimensions }). */
  embedding: EmbeddingConfig
  /** Default scope for addTriple (which has no per-call identity). */
  scope?: typegraphIdentity
  /**
   * Resolves an embedding model key to the Postgres chunks table that holds
   * its embeddings. Required for `getChunksForEntities` — the bridge JOINs
   * the entity↔chunk junction to the per-model chunks table to retrieve
   * source text. Typically wired to `vectorAdapter.getTable(model)`.
   */
  resolveChunksTable?: (model: string) => string | Promise<string>
}

// ── Knowledge Graph Bridge Factory ──

/**
 * Create a KnowledgeGraphBridge for entity-relationship graph storage and PPR-based retrieval.
 * Independent of conversational memory — does not create TypegraphMemory instances.
 */
export function createKnowledgeGraphBridge(config: CreateKnowledgeGraphBridgeConfig): KnowledgeGraphBridge {
  const { memoryStore } = config
  const embedding: EmbeddingProvider = resolveEmbeddingProvider(config.embedding)
  const defaultScope: typegraphIdentity = config.scope ?? { agentId: 'typegraph-graph' }

  const graph = new EmbeddedGraph(memoryStore)
  const resolver = new EntityResolver({ store: memoryStore, embedding })
  const predicateNormalizer = new PredicateNormalizer(embedding)

  // Generic predicates that add noise without information — filter these out
  const GENERIC_PREDICATES = new Set([
    'IS', 'IS_A', 'IS_AN', 'HAS', 'HAS_A', 'RELATED_TO', 'INVOLVES',
    'MENTIONED', 'ASSOCIATED_WITH',
  ])

  // Track entities per chunk for co-occurrence edge creation
  const chunkEntityMap = new Map<string, Set<string>>()
  const directEdgePairs = new Set<string>()

  async function addTriple(triple: {
    subject: string
    subjectType?: string
    subjectAliases?: string[]
    subjectDescription?: string
    predicate: string
    object: string
    objectType?: string
    objectAliases?: string[]
    objectDescription?: string
    confidence?: number
    content: string
    bucketId: string
    chunkIndex?: number
    documentId?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const scope = defaultScope

    let relation = triple.predicate
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^A-Z0-9_]/g, '')

    if (GENERIC_PREDICATES.has(relation)) return

    relation = await predicateNormalizer.normalize(relation)

    const [subjectResult, objectResult] = await Promise.all([
      resolver.resolve(triple.subject, triple.subjectType ?? 'entity', triple.subjectAliases ?? [], scope, triple.subjectDescription),
      resolver.resolve(triple.object, triple.objectType ?? 'entity', triple.objectAliases ?? [], scope, triple.objectDescription),
    ])

    await Promise.all([
      graph.addEntity(subjectResult.entity),
      graph.addEntity(objectResult.entity),
    ])

    const weight = triple.confidence ?? 1.0

    // Edges are deduplicated on (source, target, relation) at storage; chunk text
    // and provenance move to the entity↔chunk junction. Keep triple metadata in
    // properties only if the caller supplied it (not auto-generated content).
    const edge: SemanticEdge = {
      id: generateId('edge'),
      sourceEntityId: subjectResult.entity.id,
      targetEntityId: objectResult.entity.id,
      relation,
      weight,
      properties: triple.metadata ? { metadata: triple.metadata } : {},
      scope,
      temporal: createTemporal(),
      evidence: [],
    }

    await graph.addEdge(edge)

    // Record entity↔chunk mentions in the junction (provenance).
    // Skipped if documentId/chunkIndex aren't provided — triple lacks a source anchor.
    const mentions: Array<{
      entityId: string
      documentId: string
      chunkIndex: number
      bucketId: string
      mentionType: 'subject' | 'object' | 'co_occurrence'
      confidence?: number | undefined
    }> = []
    if (triple.documentId && triple.chunkIndex !== undefined) {
      mentions.push({
        entityId: subjectResult.entity.id,
        documentId: triple.documentId,
        chunkIndex: triple.chunkIndex,
        bucketId: triple.bucketId,
        mentionType: 'subject',
        confidence: triple.confidence,
      })
      mentions.push({
        entityId: objectResult.entity.id,
        documentId: triple.documentId,
        chunkIndex: triple.chunkIndex,
        bucketId: triple.bucketId,
        mentionType: 'object',
        confidence: triple.confidence,
      })
      if (memoryStore.upsertEntityChunkMentions) {
        await memoryStore.upsertEntityChunkMentions(mentions)
      }
    }

    const pairKey = [subjectResult.entity.id, objectResult.entity.id].sort().join(':')
    directEdgePairs.add(pairKey)

    // CO_OCCURS edges for disconnected entities
    const chunkKey = `${triple.bucketId}:${triple.chunkIndex ?? 0}`
    let chunkEntities = chunkEntityMap.get(chunkKey)
    if (!chunkEntities) {
      chunkEntities = new Set()
      chunkEntityMap.set(chunkKey, chunkEntities)
    }
    const newEntityIds = [subjectResult.entity.id, objectResult.entity.id]
    for (const newId of newEntityIds) {
      if (chunkEntities.has(newId)) continue

      const hasDirectEdges = [...directEdgePairs].some(pair => pair.includes(newId))
      if (!hasDirectEdges) {
        const existingIds = [...chunkEntities]
        if (existingIds.length > 0) {
          const linkTo = existingIds[0]!
          const coKey = [newId, linkTo].sort().join(':')
          if (!directEdgePairs.has(coKey)) {
            await graph.addEdge({
              id: generateId('edge'),
              sourceEntityId: newId,
              targetEntityId: linkTo,
              relation: 'CO_OCCURS',
              weight: 0.3,
              properties: {},
              scope,
              temporal: createTemporal(),
              evidence: [],
            })
            // Record the co-occurrence mention on the newly-linked entity
            if (memoryStore.upsertEntityChunkMentions && triple.documentId && triple.chunkIndex !== undefined) {
              await memoryStore.upsertEntityChunkMentions([{
                entityId: newId,
                documentId: triple.documentId,
                chunkIndex: triple.chunkIndex,
                bucketId: triple.bucketId,
                mentionType: 'co_occurrence',
              }])
            }
          }
        }
      }
      chunkEntities.add(newId)
    }
  }

  async function searchEntities(
    query: string,
    identity: typegraphIdentity,
    limit: number = 10,
  ): Promise<Array<{ id: string; name: string; entityType: string; similarity?: number }>> {
    if (!memoryStore.searchEntities) return []

    const queryEmbedding = await embedding.embed(query)
    const entities = await memoryStore.searchEntities(queryEmbedding, identity, limit)

    return entities.map(e => ({
      id: e.id,
      name: e.name,
      entityType: e.entityType,
      similarity: (e.properties._similarity as number) ?? undefined,
    }))
  }

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
      const existing = list.find(e => e.target === to)
      if (existing) {
        existing.weight += weight
      } else {
        list.push({ target: to, weight })
      }
    }

    const allEntityIds = new Set(entityIds)
    const neighborEdges: SemanticEdge[] = []

    const seedEdges = await graph.getEdgesBatch(entityIds, 'both')
    for (const edge of seedEdges) {
      neighborEdges.push(edge)
      allEntityIds.add(edge.sourceEntityId)
      allEntityIds.add(edge.targetEntityId)
    }

    const newNeighborIds = [...allEntityIds].filter(id => !entityIds.includes(id)).slice(0, 30)
    if (newNeighborIds.length > 0) {
      const hopEdges = await graph.getEdgesBatch(newNeighborIds, 'both')
      neighborEdges.push(...hopEdges)
    }

    const seenEdges = new Set<string>()
    for (const edge of neighborEdges) {
      if (seenEdges.has(edge.id)) continue
      seenEdges.add(edge.id)

      addEdgeToAdjacency(edge.sourceEntityId, edge.targetEntityId, edge.weight)
      addEdgeToAdjacency(edge.targetEntityId, edge.sourceEntityId, edge.weight)
    }

    for (const [, edges] of adjacency) {
      for (const edge of edges) {
        edge.weight = Math.log2(1 + edge.weight)
      }
    }

    return adjacency
  }

  async function getChunksForEntities(
    entityIds: string[],
    limit: number = 20,
    pprScores?: Map<string, number>,
    bucketIds?: string[],
  ): Promise<Array<{ content: string; bucketId: string; score: number; documentId?: string; chunkIndex?: number; metadata?: Record<string, unknown> }>> {
    if (!memoryStore.getChunksForEntitiesViaJunction || !config.resolveChunksTable) {
      return []
    }

    // Degree from edges (for PPR/degree normalization — same formula as before).
    const allEdges = await graph.getEdgesBatch(entityIds, 'both')
    const entityDegree = new Map<string, number>()
    for (const edge of allEdges) {
      entityDegree.set(edge.sourceEntityId, (entityDegree.get(edge.sourceEntityId) ?? 0) + 1)
      entityDegree.set(edge.targetEntityId, (entityDegree.get(edge.targetEntityId) ?? 0) + 1)
    }

    const chunksTable = await config.resolveChunksTable(embeddingModelKey(embedding))
    const opts: {
      chunksTable: string
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } = { chunksTable, limit: limit * 2 }
    if (bucketIds && bucketIds.length > 0) opts.bucketIds = bucketIds

    const rows = await memoryStore.getChunksForEntitiesViaJunction(entityIds, opts)

    const scored = rows.map(row => {
      const rawPPR = pprScores?.get(row.entityId) ?? 1.0
      const degree = entityDegree.get(row.entityId) ?? 1
      const score = rawPPR / Math.sqrt(degree)
      const chunk: {
        content: string
        bucketId: string
        score: number
        documentId?: string
        chunkIndex?: number
        metadata?: Record<string, unknown>
      } = {
        content: row.content,
        bucketId: row.bucketId,
        score,
        documentId: row.documentId,
        chunkIndex: row.chunkIndex,
      }
      return chunk
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  // ── Graph Exploration ──

  async function getEntity(id: string): Promise<EntityDetail | null> {
    const entity = await graph.getEntity(id)
    if (!entity) return null

    const edges = await graph.getEdges(id, 'both')
    const neighborIds = new Set<string>()
    for (const e of edges) {
      neighborIds.add(e.sourceEntityId)
      neighborIds.add(e.targetEntityId)
    }
    neighborIds.delete(id)
    const nameMap = new Map<string, string>([[id, entity.name]])
    const neighbors = await graph.getEntitiesBatch([...neighborIds])
    for (const n of neighbors) nameMap.set(n.id, n.name)

    const topEdges: EdgeResult[] = edges
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 20)
      .map(e => ({
        id: e.id,
        sourceEntityId: e.sourceEntityId,
        sourceEntityName: nameMap.get(e.sourceEntityId) ?? e.sourceEntityId,
        targetEntityId: e.targetEntityId,
        targetEntityName: nameMap.get(e.targetEntityId) ?? e.targetEntityId,
        relation: e.relation,
        weight: e.weight,
        properties: e.properties,
      }))

    return {
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
      aliases: entity.aliases,
      edgeCount: edges.length,
      properties: entity.properties,
      description: entity.properties.description as string | undefined,
      createdAt: entity.temporal.createdAt,
      validAt: entity.temporal.validAt,
      invalidAt: entity.temporal.invalidAt,
      topEdges,
    }
  }

  async function getEdges(entityId: string, opts?: {
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  }): Promise<EdgeResult[]> {
    let edges = await graph.getEdges(entityId, opts?.direction ?? 'both')
    if (opts?.relation) {
      edges = edges.filter(e => e.relation === opts.relation)
    }

    const entityIds = new Set<string>()
    for (const e of edges) {
      entityIds.add(e.sourceEntityId)
      entityIds.add(e.targetEntityId)
    }
    const nameMap = new Map<string, string>()
    const ents = await graph.getEntitiesBatch([...entityIds])
    for (const ent of ents) nameMap.set(ent.id, ent.name)

    const limit = opts?.limit ?? 50
    return edges.slice(0, limit).map(e => ({
      id: e.id,
      sourceEntityId: e.sourceEntityId,
      sourceEntityName: nameMap.get(e.sourceEntityId) ?? e.sourceEntityId,
      targetEntityId: e.targetEntityId,
      targetEntityName: nameMap.get(e.targetEntityId) ?? e.targetEntityId,
      relation: e.relation,
      weight: e.weight,
      properties: e.properties,
    }))
  }

  async function getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult> {
    let seedIds = opts.entityIds ?? []
    if (opts.query && memoryStore.searchEntities) {
      const queryEmb = await embedding.embed(opts.query)
      const found = await memoryStore.searchEntities(queryEmb, opts.identity, opts.limit ?? 10)
      seedIds = [...seedIds, ...found.map(e => e.id)]
    }
    if (seedIds.length === 0) {
      return { entities: [], edges: [], stats: { entityCount: 0, edgeCount: 0, avgDegree: 0, components: 0 } }
    }

    const depth = Math.min(opts.depth ?? 1, 3)
    const sub = await graph.getSubgraph(seedIds, depth)

    let entities = sub.entities
    let edges = sub.edges
    if (opts.entityTypes?.length) {
      const types = new Set(opts.entityTypes)
      entities = entities.filter(e => types.has(e.entityType))
    }
    if (opts.relations?.length) {
      const rels = new Set(opts.relations)
      edges = edges.filter(e => rels.has(e.relation))
    }
    if (opts.minWeight) {
      edges = edges.filter(e => e.weight >= opts.minWeight!)
    }

    const entityLimit = opts.limit ?? 100
    entities = entities.slice(0, entityLimit)
    const entitySet = new Set(entities.map(e => e.id))
    edges = edges.filter(e => entitySet.has(e.sourceEntityId) && entitySet.has(e.targetEntityId))

    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.sourceEntityId, (degree.get(e.sourceEntityId) ?? 0) + 1)
      degree.set(e.targetEntityId, (degree.get(e.targetEntityId) ?? 0) + 1)
    }
    const maxDegree = Math.max(1, ...degree.values())
    const maxWeight = Math.max(1, ...edges.map(e => e.weight))

    const nameMap = new Map<string, string>()
    for (const e of entities) nameMap.set(e.id, e.name)

    const parent = new Map<string, string>()
    function find(x: string): string {
      if (!parent.has(x)) parent.set(x, x)
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
      return parent.get(x)!
    }
    function union(a: string, b: string) { parent.set(find(a), find(b)) }
    for (const e of entities) parent.set(e.id, e.id)
    for (const e of edges) union(e.sourceEntityId, e.targetEntityId)
    const components = new Set([...entitySet].map(id => find(id))).size

    return {
      entities: entities.map(e => ({
        id: e.id,
        name: e.name,
        entityType: e.entityType,
        aliases: e.aliases,
        edgeCount: degree.get(e.id) ?? 0,
        properties: e.properties,
        size: Math.max(1, Math.round(((degree.get(e.id) ?? 0) / maxDegree) * 10)),
      })),
      edges: edges.map(e => ({
        id: e.id,
        sourceEntityId: e.sourceEntityId,
        sourceEntityName: nameMap.get(e.sourceEntityId) ?? e.sourceEntityId,
        targetEntityId: e.targetEntityId,
        targetEntityName: nameMap.get(e.targetEntityId) ?? e.targetEntityId,
        relation: e.relation,
        weight: e.weight,
        properties: e.properties,
        thickness: Math.max(1, Math.round((e.weight / maxWeight) * 5)),
      })),
      stats: {
        entityCount: entities.length,
        edgeCount: edges.length,
        avgDegree: entities.length > 0 ? (edges.length * 2) / entities.length : 0,
        components,
      },
    }
  }

  async function getGraphStats(_identity: typegraphIdentity): Promise<GraphStats> {
    const totalEntities = memoryStore.countEntities ? await memoryStore.countEntities() : 0
    const totalEdges = memoryStore.countEdges ? await memoryStore.countEdges() : 0
    const topRelations = memoryStore.getRelationTypes ? await memoryStore.getRelationTypes() : []
    const topEntityTypes = memoryStore.getEntityTypes ? await memoryStore.getEntityTypes() : []
    const degreeDistribution = memoryStore.getDegreeDistribution ? await memoryStore.getDegreeDistribution() : []

    return {
      totalEntities,
      totalEdges,
      avgEdgesPerEntity: totalEntities > 0 ? totalEdges / totalEntities : 0,
      topEntityTypes,
      topRelations,
      degreeDistribution,
    }
  }

  async function getRelationTypes(_identity: typegraphIdentity): Promise<Array<{ relation: string; count: number }>> {
    return memoryStore.getRelationTypes ? memoryStore.getRelationTypes() : []
  }

  async function getEntityTypes(_identity: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>> {
    return memoryStore.getEntityTypes ? memoryStore.getEntityTypes() : []
  }

  async function deploy(): Promise<void> {
    await memoryStore.initialize()
  }

  return {
    deploy,
    addTriple,
    searchEntities,
    getAdjacencyList,
    getChunksForEntities,
    getEntity,
    getEdges,
    getSubgraph,
    getGraphStats,
    getRelationTypes,
    getEntityTypes,
  }
}
