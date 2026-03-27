import { describe, it, expect, vi } from 'vitest'
import { createGraphBridge } from '../graph-bridge.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { SemanticEntity, SemanticEdge } from '../types/memory.js'
import { buildScope } from '../types/scope.js'

const testScope = buildScope({ userId: 'test-user' })

function makeEntity(id: string, name: string, type: string = 'entity'): SemanticEntity {
  return {
    id,
    name,
    entityType: type,
    aliases: [],
    properties: {},
    embedding: [0.1, 0.2, 0.3],
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
  }
}

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  relation: string,
  properties: Record<string, unknown> = {},
): SemanticEdge {
  return {
    id,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    relation,
    weight: 1.0,
    properties,
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
    evidence: [],
  }
}

function mockStore(
  entities: Map<string, SemanticEntity> = new Map(),
  edges: SemanticEdge[] = [],
) {
  const store: MemoryStoreAdapter = {
    initialize: vi.fn(),
    upsert: vi.fn().mockImplementation(async (r) => r),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    upsertEntity: vi.fn().mockImplementation(async (e: SemanticEntity) => {
      entities.set(e.id, e)
      return e
    }),
    getEntity: vi.fn().mockImplementation(async (id: string) => entities.get(id) ?? null),
    findEntities: vi.fn().mockImplementation(async (query: string) => {
      return [...entities.values()].filter(e =>
        e.name.toLowerCase().includes(query.toLowerCase()),
      )
    }),
    searchEntities: vi.fn().mockImplementation(async () => [...entities.values()]),
    upsertEdge: vi.fn().mockImplementation(async (e: SemanticEdge) => {
      edges.push(e)
      return e
    }),
    getEdges: vi.fn().mockImplementation(async (entityId: string, direction: string = 'both') => {
      return edges.filter(e => {
        if (direction === 'out') return e.sourceEntityId === entityId
        if (direction === 'in') return e.targetEntityId === entityId
        return e.sourceEntityId === entityId || e.targetEntityId === entityId
      })
    }),
    findEdges: vi.fn().mockResolvedValue([]),
    invalidateEdge: vi.fn(),
  }
  return store
}

function mockEmbedding() {
  let counter = 0
  // Produce orthogonal-ish embeddings so cosine similarity is low between different entities
  return {
    embed: vi.fn().mockImplementation(async () => {
      counter++
      const vec = new Array(10).fill(0)
      vec[counter % 10] = 1.0
      return vec
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      return texts.map(() => {
        counter++
        const vec = new Array(10).fill(0)
        vec[counter % 10] = 1.0
        return vec
      })
    }),
  }
}

function mockLLM() {
  return {
    generateText: vi.fn().mockResolvedValue('mock text'),
    generateJSON: vi.fn().mockResolvedValue({}),
  }
}

describe('createGraphBridge', () => {
  describe('addTriple', () => {
    it('creates entities and an edge from a triple', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'prevents',
        object: 'osteoporosis',
        content: 'Vitamin D prevents osteoporosis in elderly patients.',
        bucketId: 'doc-1',
        chunkIndex: 0,
      })

      // Two entities created
      expect(store.upsertEntity).toHaveBeenCalledTimes(2)
      expect(entities.size).toBe(2)

      // One edge created
      expect(store.upsertEdge).toHaveBeenCalledTimes(1)
      expect(edges).toHaveLength(1)

      const edge = edges[0]!
      expect(edge.relation).toBe('PREVENTS')
      expect(edge.properties.content).toBe('Vitamin D prevents osteoporosis in elderly patients.')
      expect(edge.properties.bucketId).toBe('doc-1')
      expect(edge.properties.chunkIndex).toBe(0)
    })

    it('normalizes predicate to SCREAMING_SNAKE_CASE', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Alice',
        predicate: 'works at',
        object: 'Acme Corp',
        content: 'Alice works at Acme Corp.',
        bucketId: 'doc-2',
      })

      expect(edges[0]!.relation).toBe('WORKS_AT')
    })

    it('resolves duplicate entities on repeated addTriple calls', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      // First triple: creates "Vitamin D" and "osteoporosis"
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'prevents',
        object: 'osteoporosis',
        content: 'Chunk 1',
        bucketId: 'doc-1',
      })

      const firstEntityCount = entities.size

      // Second triple: "Vitamin D" should be resolved to existing entity
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'supports',
        object: 'bone health',
        content: 'Chunk 2',
        bucketId: 'doc-1',
      })

      // Should have 3 entities (Vitamin D reused, + osteoporosis + bone health)
      expect(firstEntityCount).toBe(2)
      expect(entities.size).toBe(3)
      expect(edges).toHaveLength(2)
    })
  })

  describe('searchEntities', () => {
    it('embeds query and searches store', async () => {
      const entities = new Map<string, SemanticEntity>()
      entities.set('e1', makeEntity('e1', 'Vitamin D'))
      entities.set('e2', makeEntity('e2', 'Calcium'))

      const store = mockStore(entities)
      const emb = mockEmbedding()
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: emb,
        llm: mockLLM(),
        scope: testScope,
      })

      const results = await bridge.searchEntities!('vitamin supplements', testScope, 5)

      expect(emb.embed).toHaveBeenCalledWith('vitamin supplements')
      expect(store.searchEntities).toHaveBeenCalled()
      expect(results).toHaveLength(2)
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('name')
      expect(results[0]).toHaveProperty('entityType')
    })

    it('returns empty array when store does not support searchEntities', async () => {
      const store = mockStore()
      delete (store as any).searchEntities

      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const results = await bridge.searchEntities!('query', testScope, 5)
      expect(results).toEqual([])
    })
  })

  describe('getAdjacencyList', () => {
    it('builds bidirectional adjacency from edges', async () => {
      const entities = new Map<string, SemanticEntity>()
      entities.set('a', makeEntity('a', 'A'))
      entities.set('b', makeEntity('b', 'B'))
      entities.set('c', makeEntity('c', 'C'))

      const edges = [
        makeEdge('e1', 'a', 'b', 'KNOWS'),
        makeEdge('e2', 'b', 'c', 'WORKS_WITH'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const adj = await bridge.getAdjacencyList!(['a'])

      // a→b (from edge e1, forward)
      expect(adj.get('a')).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: 'b' }),
      ]))

      // b→a (from edge e1, reverse — bidirectional)
      expect(adj.get('b')).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: 'a' }),
      ]))

      // 2-hop expansion: b→c and c→b from edge e2
      expect(adj.get('b')).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: 'c' }),
      ]))
      expect(adj.get('c')).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: 'b' }),
      ]))
    })

    it('returns empty map for entities with no edges', async () => {
      const store = mockStore()
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const adj = await bridge.getAdjacencyList!(['nonexistent'])
      expect(adj.size).toBe(0)
    })
  })

  describe('getChunksForEntities', () => {
    it('extracts chunk content from edge properties', async () => {
      const edges = [
        makeEdge('e1', 'a', 'b', 'PREVENTS', {
          content: 'Vitamin D prevents osteoporosis.',
          bucketId: 'doc-1',
        }),
        makeEdge('e2', 'a', 'c', 'SUPPORTS', {
          content: 'Vitamin D supports bone health.',
          bucketId: 'doc-2',
        }),
      ]
      const store = mockStore(new Map(), edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const chunks = await bridge.getChunksForEntities!(['a'], 10)

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toEqual(expect.objectContaining({
        content: expect.any(String),
        bucketId: expect.any(String),
        score: 1.0,
      }))
    })

    it('deduplicates chunks by content', async () => {
      const edges = [
        makeEdge('e1', 'a', 'b', 'REL1', { content: 'Same content.', bucketId: 'doc-1' }),
        makeEdge('e2', 'a', 'c', 'REL2', { content: 'Same content.', bucketId: 'doc-1' }),
      ]
      const store = mockStore(new Map(), edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const chunks = await bridge.getChunksForEntities!(['a'], 10)
      expect(chunks).toHaveLength(1)
    })

    it('respects limit parameter', async () => {
      const edges = Array.from({ length: 10 }, (_, i) =>
        makeEdge(`e${i}`, 'a', `t${i}`, 'REL', {
          content: `Content ${i}`,
          bucketId: `doc-${i}`,
        }),
      )
      const store = mockStore(new Map(), edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const chunks = await bridge.getChunksForEntities!(['a'], 3)
      expect(chunks).toHaveLength(3)
    })

    it('skips edges without chunk provenance', async () => {
      const edges = [
        makeEdge('e1', 'a', 'b', 'KNOWS', {}), // no content/bucketId
        makeEdge('e2', 'a', 'c', 'WORKS_AT', { content: 'Has content.', bucketId: 'doc-1' }),
      ]
      const store = mockStore(new Map(), edges)
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const chunks = await bridge.getChunksForEntities!(['a'], 10)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.content).toBe('Has content.')
    })
  })

  describe('required methods', () => {
    it('remember delegates to d8umMemory', async () => {
      const store = mockStore()
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const result = await bridge.remember('test memory', testScope)
      expect(result).toBeDefined()
      expect(store.upsert).toHaveBeenCalled()
    })

    it('forget calls store.invalidate directly', async () => {
      const store = mockStore()
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      await bridge.forget('some-id')
      expect(store.invalidate).toHaveBeenCalledWith('some-id')
    })

    it('recall delegates to d8umMemory', async () => {
      const store = mockStore()
      const bridge = createGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        llm: mockLLM(),
        scope: testScope,
      })

      const results = await bridge.recall('query', testScope)
      expect(Array.isArray(results)).toBe(true)
      expect(store.search).toHaveBeenCalled()
    })
  })
})
