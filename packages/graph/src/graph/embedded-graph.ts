import type { d8umIdentity } from '@d8um/core'
import type { SemanticEntity, SemanticEdge } from '../types/index.js'
import { isActiveAt } from '../temporal.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'

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
   */
  async getSubgraph(
    entityIds: string[],
    depth: number = 0,
  ): Promise<Subgraph> {
    const entitySet = new Set(entityIds)
    const entities: SemanticEntity[] = []
    const edges: SemanticEdge[] = []
    const edgeSet = new Set<string>()

    // Get all requested entities
    for (const id of entityIds) {
      if (this.store.getEntity) {
        const entity = await this.store.getEntity(id)
        if (entity) entities.push(entity)
      }
    }

    // If depth > 0, expand the entity set with neighbors
    if (depth > 0) {
      for (const id of entityIds) {
        const neighbors = await this.getNeighbors(id, depth)
        for (const n of neighbors) {
          if (!entitySet.has(n.entity.id)) {
            entitySet.add(n.entity.id)
            entities.push(n.entity)
          }
        }
      }
    }

    // Collect edges between entities in the set
    for (const id of entitySet) {
      if (this.store.getEdges) {
        const entityEdges = await this.store.getEdges(id, 'both')
        for (const edge of entityEdges) {
          if (
            !edgeSet.has(edge.id) &&
            entitySet.has(edge.sourceEntityId) &&
            entitySet.has(edge.targetEntityId)
          ) {
            edgeSet.add(edge.id)
            edges.push(edge)
          }
        }
      }
    }

    return { entities, edges }
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
    scope: d8umIdentity,
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
