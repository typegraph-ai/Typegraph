import { describe, it, expect, vi } from 'vitest'
import { createKnowledgeGraphBridge } from '../graph-bridge.js'
import type { MemoryStoreAdapter, SemanticEntity, SemanticEdge } from '../../memory/types/index.js'
import { buildScope } from '../../memory/index.js'

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

interface MockMention {
  entityId: string
  documentId: string
  chunkIndex: number
  bucketId: string
  mentionType: 'subject' | 'object' | 'co_occurrence'
  confidence?: number | undefined
}

interface MockChunk {
  entityId: string
  documentId: string
  chunkIndex: number
  bucketId: string
  content: string
}

function mockStore(
  entities: Map<string, SemanticEntity> = new Map(),
  edges: SemanticEdge[] = [],
  mentions: MockMention[] = [],
  chunkContent: Map<string, MockChunk> = new Map(),
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
    upsertEntityChunkMentions: vi.fn().mockImplementation(async (rows: MockMention[]) => {
      mentions.push(...rows)
    }),
    getChunksForEntitiesViaJunction: vi.fn().mockImplementation(
      async (entityIds: string[], opts: { bucketIds?: string[]; limit?: number }) => {
        const matched = mentions
          .filter(m => entityIds.includes(m.entityId))
          .filter(m => !opts.bucketIds || opts.bucketIds.includes(m.bucketId))
          .map(m => {
            const key = `${m.documentId}:${m.chunkIndex}`
            const c = chunkContent.get(key)
            if (!c) return null
            return {
              content: c.content,
              bucketId: c.bucketId,
              documentId: c.documentId,
              chunkIndex: c.chunkIndex,
              entityId: m.entityId,
              confidence: m.confidence ?? null,
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
        // Dedupe on (documentId, chunkIndex) — same as the real SQL DISTINCT ON
        const seen = new Set<string>()
        const out: typeof matched = []
        for (const r of matched) {
          const k = `${r.documentId}:${r.chunkIndex}`
          if (seen.has(k)) continue
          seen.add(k)
          out.push(r)
        }
        return out.slice(0, opts.limit ?? 20)
      }
    ),
  }
  return store
}

function mockEmbedding() {
  let counter = 0
  return {
    model: 'mock-embed',
    dimensions: 10,
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

describe('createKnowledgeGraphBridge', () => {
  describe('addTriple', () => {
    it('creates entities, edge, and entity↔chunk mentions from a triple', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const mentions: MockMention[] = []
      const store = mockStore(entities, edges, mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'prevents',
        object: 'osteoporosis',
        content: 'Vitamin D prevents osteoporosis in elderly patients.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      })

      // Two entities created
      expect(store.upsertEntity).toHaveBeenCalledTimes(2)
      expect(entities.size).toBe(2)

      // One edge created — content is NOT embedded in properties anymore
      expect(store.upsertEdge).toHaveBeenCalledTimes(1)
      expect(edges).toHaveLength(1)

      const edge = edges[0]!
      expect(edge.relation).toBe('PREVENTS')
      expect(edge.properties.content).toBeUndefined()
      expect(edge.properties.bucketId).toBeUndefined()
      expect(edge.properties.chunkIndex).toBeUndefined()

      // Two mentions written to the junction (subject + object for the same chunk)
      expect(store.upsertEntityChunkMentions).toHaveBeenCalled()
      expect(mentions).toHaveLength(2)
      expect(mentions.every(m => m.documentId === 'doc-1' && m.chunkIndex === 0 && m.bucketId === 'bucket-1')).toBe(true)
      expect(mentions.map(m => m.mentionType).sort()).toEqual(['object', 'subject'])
    })

    it('normalizes predicate to SCREAMING_SNAKE_CASE', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Alice',
        predicate: 'works at',
        object: 'Acme Corp',
        content: 'Alice works at Acme Corp.',
        bucketId: 'doc-2',
      })

      expect(edges[0]!.relation).toBe('WORKS_FOR')
    })

    it('resolves duplicate entities on repeated addTriple calls', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
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
      // 2 explicit edges (prevents, supports), 0 CO_OCCURS (all entities have direct edges)
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
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: emb,
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

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
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
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
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
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const adj = await bridge.getAdjacencyList!(['nonexistent'])
      expect(adj.size).toBe(0)
    })
  })

  describe('getChunksForEntities', () => {
    function setupJunctionBridge(
      entityIds: string[],
      chunksPerEntity: Array<{ entityId: string; documentId: string; chunkIndex: number; bucketId: string; content: string }>,
    ) {
      const edges: SemanticEdge[] = entityIds.flatMap((e, i) =>
        i > 0 ? [makeEdge(`e${i}`, entityIds[0]!, e, 'REL')] : [],
      )
      const mentions: MockMention[] = chunksPerEntity.map(c => ({
        entityId: c.entityId,
        documentId: c.documentId,
        chunkIndex: c.chunkIndex,
        bucketId: c.bucketId,
        mentionType: 'subject',
      }))
      const chunkContent = new Map<string, MockChunk>()
      for (const c of chunksPerEntity) {
        chunkContent.set(`${c.documentId}:${c.chunkIndex}`, {
          entityId: c.entityId,
          documentId: c.documentId,
          chunkIndex: c.chunkIndex,
          bucketId: c.bucketId,
          content: c.content,
        })
      }
      const store = mockStore(new Map(), edges, mentions, chunkContent)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
      })
      return { bridge, store }
    }

    it('retrieves chunks for entities via the junction', async () => {
      const { bridge } = setupJunctionBridge(['a', 'b', 'c'], [
        { entityId: 'a', documentId: 'doc-1', chunkIndex: 0, bucketId: 'bucket-1', content: 'Vitamin D prevents osteoporosis.' },
        { entityId: 'a', documentId: 'doc-2', chunkIndex: 0, bucketId: 'bucket-2', content: 'Vitamin D supports bone health.' },
      ])

      const chunks = await bridge.getChunksForEntities!(['a'], 10)

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toEqual(expect.objectContaining({
        content: expect.any(String),
        bucketId: expect.any(String),
        score: expect.any(Number),
      }))
      expect(chunks[0]!.score).toBeGreaterThan(0)
    })

    it('deduplicates chunks by (documentId, chunkIndex)', async () => {
      const { bridge } = setupJunctionBridge(['a', 'b', 'c'], [
        { entityId: 'a', documentId: 'doc-1', chunkIndex: 0, bucketId: 'bucket-1', content: 'Same chunk.' },
        { entityId: 'a', documentId: 'doc-1', chunkIndex: 0, bucketId: 'bucket-1', content: 'Same chunk.' },
      ])

      const chunks = await bridge.getChunksForEntities!(['a'], 10)
      expect(chunks).toHaveLength(1)
    })

    it('respects limit parameter', async () => {
      const chunksSeed = Array.from({ length: 10 }, (_, i) => ({
        entityId: 'a', documentId: `doc-${i}`, chunkIndex: 0, bucketId: `bucket-${i}`, content: `Content ${i}`,
      }))
      const { bridge } = setupJunctionBridge(['a'], chunksSeed)

      const chunks = await bridge.getChunksForEntities!(['a'], 3)
      expect(chunks).toHaveLength(3)
    })

    it('filters by bucketIds when provided', async () => {
      const { bridge } = setupJunctionBridge(['a'], [
        { entityId: 'a', documentId: 'doc-1', chunkIndex: 0, bucketId: 'bucket-1', content: 'In bucket 1.' },
        { entityId: 'a', documentId: 'doc-2', chunkIndex: 0, bucketId: 'bucket-2', content: 'In bucket 2.' },
      ])

      const chunks = await bridge.getChunksForEntities!(['a'], 10, undefined, ['bucket-1'])
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.bucketId).toBe('bucket-1')
    })

    it('returns empty when resolveChunksTable is not configured', async () => {
      const store = mockStore()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        // no resolveChunksTable
      })

      const chunks = await bridge.getChunksForEntities!(['a'], 10)
      expect(chunks).toEqual([])
    })

    it('passes the dimension-qualified embedding model key to resolveChunksTable', async () => {
      const edges: SemanticEdge[] = []
      const mentions: MockMention[] = [
        { entityId: 'a', documentId: 'doc-1', chunkIndex: 0, bucketId: 'bucket-1', mentionType: 'subject' },
      ]
      const chunkContent = new Map<string, MockChunk>([
        ['doc-1:0', { entityId: 'a', documentId: 'doc-1', chunkIndex: 0, bucketId: 'bucket-1', content: 'x' }],
      ])
      const store = mockStore(new Map(), edges, mentions, chunkContent)
      const resolveChunksTable = vi.fn().mockReturnValue('typegraph_chunks_mock')
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable,
      })

      await bridge.getChunksForEntities!(['a'], 10)
      expect(resolveChunksTable).toHaveBeenCalledWith('mock-embed:10')
    })
  })
})
