import { describe, it, expect, vi } from 'vitest'
import { EmbeddedGraph } from '../graph/embedded-graph.js'
import type { typegraphIdentity } from '@typegraph-ai/core'
import type { MemoryStoreAdapter, SemanticEntity, SemanticEdge } from '../index.js'
import { buildScope } from '../index.js'

const testScope = buildScope({ userId: 'alice' })

function makeEntity(id: string, name: string, type: string = 'person'): SemanticEntity {
  return {
    id,
    name,
    entityType: type,
    aliases: [],
    properties: {},
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
  }
}

function makeEdge(id: string, sourceId: string, targetId: string, relation: string): SemanticEdge {
  return {
    id,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    relation,
    weight: 1.0,
    properties: {},
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
    evidence: [],
  }
}

function mockStore(
  entities: Map<string, SemanticEntity>,
  edges: SemanticEdge[],
): MemoryStoreAdapter {
  return {
    initialize: vi.fn(),
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    upsertEntity: vi.fn().mockImplementation(async (e: SemanticEntity) => { entities.set(e.id, e); return e }),
    getEntity: vi.fn().mockImplementation(async (id: string) => entities.get(id) ?? null),
    findEntities: vi.fn().mockImplementation(async (query: string, _scope: typegraphIdentity) => {
      return [...entities.values()].filter(e => e.name.toLowerCase().includes(query.toLowerCase()))
    }),
    searchEntities: vi.fn().mockResolvedValue([]),
    upsertEdge: vi.fn().mockImplementation(async (e: SemanticEdge) => { edges.push(e); return e }),
    getEntitiesBatch: vi.fn().mockImplementation(async (ids: string[]) => {
      return ids.map(id => entities.get(id)).filter(Boolean) as SemanticEntity[]
    }),
    getEdges: vi.fn().mockImplementation(async (entityId: string, direction: string = 'both') => {
      return edges.filter(e => {
        if (direction === 'out') return e.sourceEntityId === entityId
        if (direction === 'in') return e.targetEntityId === entityId
        return e.sourceEntityId === entityId || e.targetEntityId === entityId
      })
    }),
    getEdgesBatch: vi.fn().mockImplementation(async (entityIds: string[], direction: string = 'both') => {
      return edges.filter(e => {
        const matchSource = entityIds.includes(e.sourceEntityId)
        const matchTarget = entityIds.includes(e.targetEntityId)
        if (direction === 'out') return matchSource
        if (direction === 'in') return matchTarget
        return matchSource || matchTarget
      })
    }),
    findEdges: vi.fn().mockResolvedValue([]),
    invalidateEdge: vi.fn(),
  }
}

describe('EmbeddedGraph', () => {
  it('adds and retrieves entities', async () => {
    const entities = new Map<string, SemanticEntity>()
    const store = mockStore(entities, [])
    const graph = new EmbeddedGraph(store)

    const alice = makeEntity('alice', 'Alice')
    await graph.addEntity(alice)

    const result = await graph.getEntity('alice')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Alice')
  })

  it('adds edges and retrieves them', async () => {
    const entities = new Map<string, SemanticEntity>()
    const edgeList: SemanticEdge[] = []
    const store = mockStore(entities, edgeList)
    const graph = new EmbeddedGraph(store)

    const edge = makeEdge('e1', 'alice', 'acme', 'WORKS_AT')
    await graph.addEdge(edge)

    const edges = await graph.getEdges('alice')
    expect(edges).toHaveLength(1)
    expect(edges[0]!.relation).toBe('WORKS_AT')
  })

  describe('getNeighbors', () => {
    it('finds direct neighbors (depth=1)', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const acme = makeEntity('acme', 'Acme Corp', 'organization')
      const entities = new Map([['alice', alice], ['bob', bob], ['acme', acme]])

      const edgeList = [
        makeEdge('e1', 'alice', 'bob', 'KNOWS'),
        makeEdge('e2', 'alice', 'acme', 'WORKS_AT'),
      ]

      const graph = new EmbeddedGraph(mockStore(entities, edgeList))
      const neighbors = await graph.getNeighbors('alice', 1)

      expect(neighbors).toHaveLength(2)
      const names = neighbors.map(n => n.entity.name).sort()
      expect(names).toEqual(['Acme Corp', 'Bob'])
    })

    it('finds 2-hop neighbors (depth=2)', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const charlie = makeEntity('charlie', 'Charlie')
      const entities = new Map([['alice', alice], ['bob', bob], ['charlie', charlie]])

      const edgeList = [
        makeEdge('e1', 'alice', 'bob', 'KNOWS'),
        makeEdge('e2', 'bob', 'charlie', 'KNOWS'),
      ]

      const graph = new EmbeddedGraph(mockStore(entities, edgeList))

      // Depth 1: only Bob
      const depth1 = await graph.getNeighbors('alice', 1)
      expect(depth1).toHaveLength(1)
      expect(depth1[0]!.entity.name).toBe('Bob')

      // Depth 2: Bob + Charlie
      const depth2 = await graph.getNeighbors('alice', 2)
      expect(depth2).toHaveLength(2)
    })
  })

  describe('getSubgraph', () => {
    it('extracts a subgraph with edges between entities', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const entities = new Map([['alice', alice], ['bob', bob]])

      const edgeList = [makeEdge('e1', 'alice', 'bob', 'KNOWS')]
      const graph = new EmbeddedGraph(mockStore(entities, edgeList))

      const subgraph = await graph.getSubgraph(['alice', 'bob'])
      expect(subgraph.entities).toHaveLength(2)
      expect(subgraph.edges).toHaveLength(1)
    })

    it('uses batch operations instead of sequential calls', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const entities = new Map([['alice', alice], ['bob', bob]])

      const edgeList = [makeEdge('e1', 'alice', 'bob', 'KNOWS')]
      const store = mockStore(entities, edgeList)
      const graph = new EmbeddedGraph(store)

      await graph.getSubgraph(['alice', 'bob'])

      // Should use batch operations, not sequential getEntity calls
      expect(store.getEntitiesBatch).toHaveBeenCalled()
      expect(store.getEdgesBatch).toHaveBeenCalled()
    })

    it('expands neighbors at depth=1 using batch operations', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const charlie = makeEntity('charlie', 'Charlie')
      const entities = new Map([['alice', alice], ['bob', bob], ['charlie', charlie]])

      const edgeList = [
        makeEdge('e1', 'alice', 'bob', 'KNOWS'),
        makeEdge('e2', 'bob', 'charlie', 'KNOWS'),
      ]
      const store = mockStore(entities, edgeList)
      const graph = new EmbeddedGraph(store)

      const subgraph = await graph.getSubgraph(['alice'], 1)

      // Alice + Bob (discovered via edge)
      expect(subgraph.entities).toHaveLength(2)
      expect(subgraph.entities.map(e => e.name).sort()).toEqual(['Alice', 'Bob'])
      // Only e1 (alice->bob), not e2 (bob->charlie) since charlie is not in the set at depth=1
      expect(subgraph.edges).toHaveLength(1)
    })

    it('deduplicates edges across BFS and final collection', async () => {
      const a = makeEntity('a', 'A')
      const b = makeEntity('b', 'B')
      const c = makeEntity('c', 'C')
      const entities = new Map([['a', a], ['b', b], ['c', c]])

      const edgeList = [
        makeEdge('e1', 'a', 'b', 'R1'),
        makeEdge('e2', 'b', 'c', 'R2'),
        makeEdge('e3', 'a', 'c', 'R3'),
      ]
      const graph = new EmbeddedGraph(mockStore(entities, edgeList))

      const subgraph = await graph.getSubgraph(['a'], 2)

      // All 3 entities reachable within depth=2
      expect(subgraph.entities).toHaveLength(3)
      // All 3 edges should appear exactly once (no duplicates)
      expect(subgraph.edges).toHaveLength(3)
      const edgeIds = subgraph.edges.map(e => e.id).sort()
      expect(edgeIds).toEqual(['e1', 'e2', 'e3'])
    })
  })

  describe('findPath', () => {
    it('finds a direct path', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const entities = new Map([['alice', alice], ['bob', bob]])

      const edgeList = [makeEdge('e1', 'alice', 'bob', 'KNOWS')]
      const graph = new EmbeddedGraph(mockStore(entities, edgeList))

      const path = await graph.findPath('alice', 'bob')
      expect(path).not.toBeNull()
      expect(path!.nodes).toHaveLength(2)
      expect(path!.edges).toHaveLength(1)
    })

    it('returns null when no path exists', async () => {
      const alice = makeEntity('alice', 'Alice')
      const bob = makeEntity('bob', 'Bob')
      const entities = new Map([['alice', alice], ['bob', bob]])

      const graph = new EmbeddedGraph(mockStore(entities, []))
      const path = await graph.findPath('alice', 'bob')
      expect(path).toBeNull()
    })

    it('finds a path to itself', async () => {
      const alice = makeEntity('alice', 'Alice')
      const entities = new Map([['alice', alice]])

      const graph = new EmbeddedGraph(mockStore(entities, []))
      const path = await graph.findPath('alice', 'alice')
      expect(path).not.toBeNull()
      expect(path!.nodes).toHaveLength(1)
      expect(path!.edges).toHaveLength(0)
    })
  })

  describe('subgraphToContext', () => {
    it('serializes a subgraph into a readable string', () => {
      const graph = new EmbeddedGraph({} as MemoryStoreAdapter)

      const alice = makeEntity('alice', 'Alice')
      const acme = makeEntity('acme', 'Acme Corp', 'organization')
      const edge = makeEdge('e1', 'alice', 'acme', 'WORKS_AT')

      const context = graph.subgraphToContext({
        entities: [alice, acme],
        edges: [edge],
      })

      expect(context).toContain('Alice (person)')
      expect(context).toContain('Acme Corp (organization)')
      expect(context).toContain('Alice --[WORKS_AT]--> Acme Corp')
    })

    it('returns empty string for empty subgraph', () => {
      const graph = new EmbeddedGraph({} as MemoryStoreAdapter)
      expect(graph.subgraphToContext({ entities: [], edges: [] })).toBe('')
    })
  })
})
