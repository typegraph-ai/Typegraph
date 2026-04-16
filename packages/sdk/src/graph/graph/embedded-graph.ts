import type { typegraphIdentity } from '../../types/identity.js'
import type { SemanticEntity, SemanticEdge, MemoryStoreAdapter } from '../../memory/types/index.js'
import { isActiveAt } from '../../memory/index.js'

// ── Graph Types ──

export interface GraphNode {
  entity: SemanticEntity
  depth: number
}

export interface GraphPath {
  nodes: SemanticEntity[]
  edges: SemanticEdge[]
}

export interface Subgraph {
  entities: SemanticEntity[]
  edges: SemanticEdge[]
}

// ── Embedded Graph ──
// Stores entities and edges using the MemoryStoreAdapter.
// Graph traversal via in-memory adjacency built from edge queries.
// No external graph database required.

export class EmbeddedGraph {
  private readonly store: MemoryStoreAdapter

  constructor(store: MemoryStoreAdapter) {
    this.store = store
  }

  /**
   * Add an entity to the graph. Upserts into the store.
   */
  async addEntity(entity: SemanticEntity): Promise<void> {
    if (!this.store.upsertEntity) {
      throw new Error('MemoryStoreAdapter does not support entity storage')
    }
    await this.store.upsertEntity(entity)
  }

  /**
   * Add an edge (relationship) to the graph.
   */
  async addEdge(edge: SemanticEdge): Promise<void> {
    if (!this.store.upsertEdge) {
      throw new Error('MemoryStoreAdapter does not support edge storage')
    }
    await this.store.upsertEdge(edge)
  }

  /**
   * Get an entity by ID.
   */
  async getEntity(id: string): Promise<SemanticEntity | null> {
    if (!this.store.getEntity) return null
    return this.store.getEntity(id)
  }

  /**
   * Get edges connected to an entity.
   */
  async getEdges(
    entityId: string,
    direction: 'in' | 'out' | 'both' = 'both',
  ): Promise<SemanticEdge[]> {
    if (!this.store.getEdges) return []
    return this.store.getEdges(entityId, direction)
  }

  /**
   * Get edges for multiple entities in a single batch query.
   * Falls back to sequential getEdges() if batch not supported.
   */
  async getEdgesBatch(
    entityIds: string[],
    direction: 'in' | 'out' | 'both' = 'both',
  ): Promise<SemanticEdge[]> {
    if (this.store.getEdgesBatch) {
      return this.store.getEdgesBatch(entityIds, direction)
    }
    // Fallback to sequential
    if (!this.store.getEdges) return []
    const results: SemanticEdge[] = []
    for (const id of entityIds) {
      const edges = await this.store.getEdges(id, direction)
      results.push(...edges)
    }
    return results
  }

  /**
   * Get multiple entities by ID in a single batch query.
   * Falls back to sequential getEntity() if batch not supported.
   */
  async getEntitiesBatch(ids: string[]): Promise<SemanticEntity[]> {
    if (this.store.getEntitiesBatch) {
      return this.store.getEntitiesBatch(ids)
    }
    // Fallback to sequential
    if (!this.store.getEntity) return []
    const results: SemanticEntity[] = []
    for (const id of ids) {
      const entity = await this.store.getEntity(id)
      if (entity) results.push(entity)
    }
    return results
  }

  /**
   * Breadth-first traversal from a starting entity.
   * Returns all entities reachable within the given depth.
   */
  async getNeighbors(
    entityId: string,
    depth: number = 1,
    direction: 'in' | 'out' | 'both' = 'both',
  ): Promise<GraphNode[]> {
    if (!this.store.getEdges || !this.store.getEntity) return []

    const visited = new Set<string>()
    const result: GraphNode[] = []
    const queue: { id: string; depth: number }[] = [{ id: entityId, depth: 0 }]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current.id)) continue
      visited.add(current.id)

      if (current.id !== entityId) {
        const entity = await this.store.getEntity(current.id)
        if (entity) {
          result.push({ entity, depth: current.depth })
        }
      }

      if (current.depth < depth) {
        const edges = await this.store.getEdges(current.id, direction)
        for (const edge of edges) {
          const neighborId = edge.sourceEntityId === current.id
            ? edge.targetEntityId
            : edge.sourceEntityId
          if (!visited.has(neighborId)) {
            queue.push({ id: neighborId, depth: current.depth + 1 })
          }
        }
      }
    }

    return result
  }

  /**
   * Get neighbors that are valid at a specific point in time.
   */
  async getNeighborsAt(
    entityId: string,
    at: Date,
    depth: number = 1,
  ): Promise<GraphNode[]> {
    const allNeighbors = await this.getNeighbors(entityId, depth)
    return allNeighbors.filter(n => isActiveAt(n.entity.temporal, at))
  }

  /**
   * Extract a subgraph containing the given entities and all edges between them.
   * Uses batch operations to minimise DB roundtrips (4 instead of ~N*depth).
   */
  async getSubgraph(
    entityIds: string[],
    depth: number = 0,
  ): Promise<Subgraph> {
    // Step 1: Batch-load seed entities (1 roundtrip)
    const seedEntities = await this.getEntitiesBatch(entityIds)
    const entityMap = new Map<string, SemanticEntity>()
    for (const e of seedEntities) entityMap.set(e.id, e)

    // Track which entity IDs have had their edges loaded
    const edgeLoadedIds = new Set<string>()
    const allEdges: SemanticEdge[] = []

    // Step 2: BFS expansion using batch operations
    if (depth > 0) {
      let frontier = entityIds.filter(id => entityMap.has(id))

      for (let d = 0; d < depth && frontier.length > 0; d++) {
        // Batch-load edges for current frontier (1 roundtrip per depth level)
        const frontierEdges = await this.getEdgesBatch(frontier, 'both')
        allEdges.push(...frontierEdges)
        for (const id of frontier) edgeLoadedIds.add(id)

        // Collect newly discovered neighbor IDs
        const newIds: string[] = []
        for (const edge of frontierEdges) {
          if (!entityMap.has(edge.sourceEntityId)) newIds.push(edge.sourceEntityId)
          if (!entityMap.has(edge.targetEntityId)) newIds.push(edge.targetEntityId)
        }
        const uniqueNewIds = [...new Set(newIds)]

        if (uniqueNewIds.length > 0) {
          // Batch-load neighbor entities (1 roundtrip per depth level)
          const neighbors = await this.getEntitiesBatch(uniqueNewIds)
          for (const n of neighbors) entityMap.set(n.id, n)
        }

        // Next frontier = newly discovered entities
        frontier = uniqueNewIds.filter(id => entityMap.has(id))
      }
    }

    // Step 3: Load edges for entities that haven't had edges loaded yet
    const needEdgeIds = [...entityMap.keys()].filter(id => !edgeLoadedIds.has(id))
    if (needEdgeIds.length > 0) {
      const remaining = await this.getEdgesBatch(needEdgeIds, 'both')
      allEdges.push(...remaining)
    }

    // Deduplicate edges and filter to those with both endpoints in the entity set
    const edgeSet = new Set<string>()
    const edges: SemanticEdge[] = []
    for (const edge of allEdges) {
      if (
        !edgeSet.has(edge.id) &&
        entityMap.has(edge.sourceEntityId) &&
        entityMap.has(edge.targetEntityId)
      ) {
        edgeSet.add(edge.id)
        edges.push(edge)
      }
    }

    return { entities: [...entityMap.values()], edges }
  }

  /**
   * Find a path between two entities using BFS.
   * Returns null if no path exists within maxDepth.
   */
  async findPath(
    fromId: string,
    toId: string,
    maxDepth: number = 5,
  ): Promise<GraphPath | null> {
    if (!this.store.getEdges || !this.store.getEntity) return null
    if (fromId === toId) {
      const entity = await this.store.getEntity(fromId)
      return entity ? { nodes: [entity], edges: [] } : null
    }

    const visited = new Set<string>()
    const parentMap = new Map<string, { entityId: string; edge: SemanticEdge }>()
    const queue: { id: string; depth: number }[] = [{ id: fromId, depth: 0 }]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current.id)) continue
      visited.add(current.id)

      if (current.id === toId) {
        // Reconstruct path
        return this.reconstructPath(fromId, toId, parentMap)
      }

      if (current.depth < maxDepth) {
        const edges = await this.store.getEdges(current.id, 'both')
        for (const edge of edges) {
          const neighborId = edge.sourceEntityId === current.id
            ? edge.targetEntityId
            : edge.sourceEntityId
          if (!visited.has(neighborId)) {
            parentMap.set(neighborId, { entityId: current.id, edge })
            queue.push({ id: neighborId, depth: current.depth + 1 })
          }
        }
      }
    }

    return null
  }

  /**
   * Serialize a subgraph into a string for LLM context injection.
   */
  subgraphToContext(subgraph: Subgraph): string {
    if (subgraph.entities.length === 0) return ''

    const entityLines = subgraph.entities.map(e =>
      `- ${e.name} (${e.entityType}): ${Object.entries(e.properties).map(([k, v]) => `${k}=${v}`).join(', ') || 'no properties'}`
    )

    const edgeLines = subgraph.edges.map(e => {
      const source = subgraph.entities.find(n => n.id === e.sourceEntityId)
      const target = subgraph.entities.find(n => n.id === e.targetEntityId)
      return `- ${source?.name ?? e.sourceEntityId} --[${e.relation}]--> ${target?.name ?? e.targetEntityId}`
    })

    const parts = ['Entities:', ...entityLines]
    if (edgeLines.length > 0) {
      parts.push('', 'Relationships:', ...edgeLines)
    }

    return parts.join('\n')
  }

  /**
   * Search for entities by name.
   */
  async findEntities(
    query: string,
    scope: typegraphIdentity,
    limit: number = 10,
  ): Promise<SemanticEntity[]> {
    if (!this.store.findEntities) return []
    return this.store.findEntities(query, scope, limit)
  }

  private async reconstructPath(
    fromId: string,
    toId: string,
    parentMap: Map<string, { entityId: string; edge: SemanticEdge }>,
  ): Promise<GraphPath> {
    const nodes: SemanticEntity[] = []
    const edges: SemanticEdge[] = []
    let currentId = toId

    while (currentId !== fromId) {
      const parent = parentMap.get(currentId)
      if (!parent) break

      if (this.store.getEntity) {
        const entity = await this.store.getEntity(currentId)
        if (entity) nodes.unshift(entity)
      }
      edges.unshift(parent.edge)
      currentId = parent.entityId
    }

    // Add the start node
    if (this.store.getEntity) {
      const startEntity = await this.store.getEntity(fromId)
      if (startEntity) nodes.unshift(startEntity)
    }

    return { nodes, edges }
  }
}
