import { describe, it, expect, vi } from 'vitest'
import { createKnowledgeGraphBridge } from '../graph-bridge.js'
import type { MemoryStoreAdapter, SemanticEntity, SemanticEdge, SemanticFactRecord } from '../../memory/types/index.js'
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
  mentionType: 'subject' | 'object' | 'co_occurrence' | 'entity' | 'alias'
  surfaceText?: string | undefined
  normalizedSurfaceText?: string | undefined
  confidence?: number | undefined
}

function mockStore(
  entities: Map<string, SemanticEntity> = new Map(),
  edges: SemanticEdge[] = [],
  mentions: MockMention[] = [],
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
    searchEntitiesHybrid: vi.fn().mockImplementation(async (query: string) => {
      const normalized = query
        .replace(/[Ææ]/g, 'ae')
        .replace(/[Œœ]/g, 'oe')
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
      const exact = [...entities.values()]
        .filter(e =>
          e.name.toLowerCase() === query.toLowerCase()
          || e.aliases.some(a => a.toLowerCase() === query.toLowerCase())
          || mentions.some(m => m.entityId === e.id && m.normalizedSurfaceText === normalized)
        )
        .map(e => ({ ...e, properties: { ...e.properties, _similarity: 1 } }))
      return exact.length > 0
        ? exact
        : [...entities.values()].map(e => ({ ...e, properties: { ...e.properties, _similarity: 0.5 } }))
    }),
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
        predicate: 'supported',
        object: 'bone health',
        relationshipDescription: 'Vitamin D supports bone health in elderly patients.',
        evidenceText: 'Vitamin D supports bone health in elderly patients.',
        sourceChunkId: 'chk-vitd-0',
        content: 'Vitamin D supports bone health in elderly patients.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      })

      // Two entities created, then profile evidence is updated from the stored fact.
      expect(store.upsertEntity).toHaveBeenCalledTimes(4)
      expect(entities.size).toBe(2)

      // One edge created — content is NOT embedded in properties anymore
      expect(store.upsertEdge).toHaveBeenCalledTimes(1)
      expect(edges).toHaveLength(1)

      const edge = edges[0]!
      expect(edge.relation).toBe('SUPPORTED')
      expect(edge.properties.content).toBeUndefined()
      expect(edge.properties.bucketId).toBeUndefined()
      expect(edge.properties.chunkIndex).toBeUndefined()
      expect(edge.properties).toEqual(expect.objectContaining({
        relationshipDescription: 'Vitamin D supports bone health in elderly patients.',
        evidenceText: 'Vitamin D supports bone health in elderly patients.',
        sourceChunkId: 'chk-vitd-0',
      }))

      // Two mentions written to the junction (subject + object for the same chunk)
      expect(store.upsertEntityChunkMentions).toHaveBeenCalled()
      expect(mentions).toHaveLength(2)
      expect(mentions.every(m => m.documentId === 'doc-1' && m.chunkIndex === 0 && m.bucketId === 'bucket-1')).toBe(true)
	      expect(mentions.map(m => m.mentionType).sort()).toEqual(['object', 'subject'])
	    })

    it('propagates visibility and identity scope to graph rows from a triple', async () => {
      const cases = [
        { visibility: 'tenant' as const, identity: { tenantId: 'tenant-1' } },
        { visibility: 'group' as const, identity: { groupId: 'group-1' } },
        { visibility: 'user' as const, identity: { userId: 'user-1' } },
        { visibility: 'agent' as const, identity: { agentId: 'agent-1' } },
        { visibility: 'conversation' as const, identity: { conversationId: 'conversation-1' } },
      ]

      for (const item of cases) {
        const entities = new Map<string, SemanticEntity>()
        const edges: SemanticEdge[] = []
        const store = mockStore(entities, edges)
        store.upsertPassageEntityEdges = vi.fn().mockResolvedValue(undefined)
        store.upsertFactRecord = vi.fn().mockImplementation(async fact => fact)
        const bridge = createKnowledgeGraphBridge({
          memoryStore: store,
          embedding: mockEmbedding(),
          scope: testScope,
        })

        await bridge.addTriple!({
          subject: `Subject ${item.visibility}`,
          subjectType: 'person',
          predicate: 'leads',
          object: `Object ${item.visibility}`,
          objectType: 'organization',
          content: `Subject ${item.visibility} leads Object ${item.visibility}.`,
          bucketId: 'bucket-1',
          documentId: `doc-${item.visibility}`,
          chunkIndex: 0,
          ...item.identity,
          visibility: item.visibility,
        })

        expect([...entities.values()].every(entity =>
          entity.visibility === item.visibility
          && Object.entries(item.identity).every(([key, value]) => entity.scope[key as keyof typeof item.identity] === value)
        )).toBe(true)
        expect(edges.every(edge =>
          edge.visibility === item.visibility
          && Object.entries(item.identity).every(([key, value]) => edge.scope[key as keyof typeof item.identity] === value)
        )).toBe(true)
        expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
          visibility: item.visibility,
          scope: expect.objectContaining(item.identity),
        }))
        expect(store.upsertPassageEntityEdges).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({
            visibility: item.visibility,
            scope: expect.objectContaining(item.identity),
          }),
        ]))
      }
    })

    it('does not merge same-name group-visible entities across groups in one process', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addEntityMentions!([{
        name: 'TypeGraph',
        type: 'organization',
        content: 'TypeGraph appears in group A.',
        bucketId: 'bucket-1',
        documentId: 'doc-a',
        chunkIndex: 0,
        groupId: 'group-a',
        visibility: 'group',
      }])
      await bridge.addEntityMentions!([{
        name: 'TypeGraph',
        type: 'organization',
        content: 'TypeGraph appears in group B.',
        bucketId: 'bucket-1',
        documentId: 'doc-b',
        chunkIndex: 0,
        groupId: 'group-b',
        visibility: 'group',
      }])

      const typegraphEntities = [...entities.values()].filter(entity => entity.name === 'TypeGraph')
      expect(typegraphEntities).toHaveLength(2)
      expect(new Set(typegraphEntities.map(entity => entity.scope.groupId))).toEqual(new Set(['group-a', 'group-b']))
    })

	    it('stores aliases as searchable surface mentions', async () => {
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
        subject: 'Cæsar Simon',
        subjectType: 'person',
        subjectAliases: ['Conway', 'Cole Conway', 'Cousin Cæsar'],
        predicate: 'collaborated_with',
        object: 'Steve Sharp',
        objectType: 'person',
        content: 'Cæsar Simon was calling himself Cole Conway in company with Steve Sharp.',
        bucketId: 'bucket-1',
        documentId: 'doc-47558',
        chunkIndex: 24,
      })

      expect(mentions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          mentionType: 'alias',
          surfaceText: 'Cole Conway',
          normalizedSurfaceText: 'cole conway',
        }),
      ]))

      const found = await bridge.searchEntities!('Cole Conway', testScope, 10)
      expect(found[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundBySurname = await bridge.searchEntities!('Conway', testScope, 10)
      expect(foundBySurname[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundByAlias = await bridge.searchEntities!('Cousin Cæsar', testScope, 10)
      expect(foundByAlias[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundByAsciiAlias = await bridge.searchEntities!('Cousin Caesar', testScope, 10)
      expect(foundByAsciiAlias[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))
    })

    it('does not persist self-edges after entity resolution', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Cæsar Simon',
        subjectType: 'person',
        subjectAliases: ['Conway'],
        predicate: 'known_as',
        object: 'Conway',
        objectType: 'person',
        objectAliases: ['Cæsar Simon'],
        content: 'Cæsar Simon was known as Conway.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      })

      expect(edges).toHaveLength(0)
    })

    it('stores entity mentions even when no relationship is available', async () => {
      const entities = new Map<string, SemanticEntity>()
      const mentions: MockMention[] = []
      const store = mockStore(entities, [], mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addEntityMentions!([{
        name: 'Cole Conway',
        type: 'person',
        aliases: ['Conway'],
        description: 'A name used by Cæsar Simon in Paducah.',
        content: 'At twenty years of age Cousin Cæsar was calling himself Cole Conway.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      }])

      expect(entities.size).toBe(1)
      expect(mentions).toEqual(expect.arrayContaining([
        expect.objectContaining({ mentionType: 'entity', surfaceText: 'Cole Conway' }),
        expect.objectContaining({ mentionType: 'alias', surfaceText: 'Conway' }),
      ]))
    })

    it('normalizes predicate to SCREAMING_SNAKE_CASE', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      store.upsertFactRecord = vi.fn()
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

    it('rejects invented predicates before persistence', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Chaacmol',
        predicate: 'FUNERAL_CHAMBER_IN',
        object: 'Chichen-Itza',
        content: 'Chaacmol is associated with a funeral chamber at Chichen-Itza.',
        bucketId: 'bucket-1',
      })

      expect(edges).toHaveLength(0)
      expect(store.upsertFactRecord).not.toHaveBeenCalled()
    })

    it('normalizes inverse predicates by swapping subject and object', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Chaacmol',
        predicate: 'KILLED_BY',
        object: 'Aac',
        relationshipDescription: 'Chaacmol was killed by Aac.',
        evidenceText: 'Chaacmol was killed by Aac.',
        content: 'Chaacmol was killed by Aac.',
        bucketId: 'bucket-1',
      })

      const edge = edges[0]!
      const entityById = new Map([...entities.values()].map(entity => [entity.id, entity]))
      expect(edge.relation).toBe('KILLED')
      expect(entityById.get(edge.sourceEntityId)?.name).toBe('Aac')
      expect(entityById.get(edge.targetEntityId)?.name).toBe('Chaacmol')
    })

    it('drops obvious directional contradictions instead of persisting them', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Chaacmol',
        predicate: 'KILLED',
        object: 'Aac',
        relationshipDescription: 'Aac killed Chaacmol with a spear.',
        evidenceText: 'Aac killed Chaacmol with a spear.',
        content: 'Aac killed Chaacmol with a spear.',
        bucketId: 'bucket-1',
      })

      expect(edges).toHaveLength(0)
      expect(store.upsertFactRecord).not.toHaveBeenCalled()
    })

    it('normalizes gendered spouse predicates to MARRIED before persistence', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Moo',
        predicate: 'WIFE_OF',
        object: 'Chaacmol',
        relationshipDescription: 'Moo was married to Chaacmol.',
        evidenceText: 'Moo was married to Chaacmol.',
        content: 'Moo was married to Chaacmol.',
        bucketId: 'bucket-1',
      })

      expect(edges[0]!.relation).toBe('MARRIED')
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
        predicate: 'supported',
        object: 'bone health',
        content: 'Chunk 1',
        bucketId: 'doc-1',
      })

      const firstEntityCount = entities.size

      // Second triple: "Vitamin D" should be resolved to existing entity
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'supported',
        object: 'skeletal health',
        content: 'Chunk 2',
        bucketId: 'doc-1',
      })

      // Should have 3 entities (Vitamin D reused, + bone health + skeletal health)
      expect(firstEntityCount).toBe(2)
      expect(entities.size).toBe(3)
      // 2 explicit edges, 0 CO_OCCURS (all entities have direct edges)
      expect(edges).toHaveLength(2)
    })
  })

  describe('backfill', () => {
    it('creates passage nodes, passage-entity edges, fact records, and profiles from existing rows', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['alice', makeEntity('alice', 'Alice', 'person')],
        ['beta', makeEntity('beta', 'Beta Inc', 'organization')],
      ])
      const edges = [makeEdge('edge-1', 'alice', 'beta', 'WORKS_AT')]
      const store = mockStore(entities, edges)
      Object.assign(store, {
        listPassageBackfillChunks: vi.fn().mockImplementation(async ({ offset }: { offset?: number }) => {
          if ((offset ?? 0) > 0) return []
          return [{
            chunkId: 'chk-1',
            bucketId: 'bucket-1',
            documentId: 'doc-1',
            chunkIndex: 0,
            embeddingModel: 'mock-embed',
            content: 'Alice works at Beta Inc.',
            metadata: { source: 'test' },
            userId: 'test-user',
          }]
        }),
        listPassageMentionBackfillRows: vi.fn().mockImplementation(async ({ offset }: { offset?: number }) => {
          if ((offset ?? 0) > 0) return []
          return [
            {
              chunkId: 'chk-1',
              bucketId: 'bucket-1',
              documentId: 'doc-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
              content: 'Alice works at Beta Inc.',
              metadata: {},
              userId: 'test-user',
              entityId: 'alice',
              mentionType: 'subject',
              surfaceText: 'Alice',
              confidence: 0.9,
            },
            {
              chunkId: 'chk-1',
              bucketId: 'bucket-1',
              documentId: 'doc-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
              content: 'Alice works at Beta Inc.',
              metadata: {},
              userId: 'test-user',
              entityId: 'beta',
              mentionType: 'object',
              surfaceText: 'Beta Inc',
              confidence: 0.9,
            },
          ]
        }),
        listSemanticEdgesForBackfill: vi.fn().mockImplementation(async ({ offset }: { offset?: number } = {}) => {
          if ((offset ?? 0) > 0) return []
          return edges
        }),
        upsertPassageNodes: vi.fn(),
        upsertPassageEntityEdges: vi.fn(),
        upsertFactRecord: vi.fn().mockImplementation(async fact => fact),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'chunks_mock',
      })

      const result = await bridge.backfill!(testScope, { batchSize: 10 })

      expect(result.passageNodesUpserted).toBe(1)
      expect(result.passageEntityEdgesUpserted).toBe(2)
      expect(result.factRecordsUpserted).toBe(1)
      expect(result.entityProfilesUpdated).toBe(2)
      expect(store.upsertPassageNodes).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({
          bucketId: 'bucket-1',
          documentId: 'doc-1',
          chunkIndex: 0,
        }),
      ]))
      expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
        factText: 'Alice works at Beta Inc',
      }))
    })
  })

  describe('searchEntities', () => {
    it('embeds query and searches store', async () => {
      const entities = new Map<string, SemanticEntity>()
      entities.set('e1', {
        ...makeEntity('e1', 'Vitamin D', 'supplement'),
        aliases: ['cholecalciferol'],
        properties: { source: 'test fixture' },
      })
      entities.set('e2', makeEntity('e2', 'Calcium'))
      const edges = [
        makeEdge('edge-1', 'e1', 'e2', 'SUPPORTS'),
        makeEdge('edge-2', 'e1', 'e3', 'IMPROVES'),
      ]

      const store = mockStore(entities, edges)
      ;(store.getEdgesBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
        edges[0]!,
        edges[0]!,
        edges[1]!,
      ])
      const emb = mockEmbedding()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: emb,
        scope: testScope,
      })

      const results = await bridge.searchEntities!('vitamin supplements', testScope, 5)

      expect(emb.embed).toHaveBeenCalledWith('vitamin supplements')
      expect(store.searchEntitiesHybrid).toHaveBeenCalled()
      expect(results).toHaveLength(2)
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('name')
      expect(results[0]).toHaveProperty('entityType')
      expect(results[0]).toEqual(expect.objectContaining({
        aliases: ['cholecalciferol'],
        similarity: 0.5,
        edgeCount: 2,
        properties: expect.objectContaining({ source: 'test fixture' }),
      }))
      expect(results[0]?.properties).not.toHaveProperty('_similarity')
      expect(results[1]).toEqual(expect.objectContaining({ edgeCount: 1 }))
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

  describe('searchGraphPassages', () => {
    it('returns ranked passages and keeps direct entity seeding from hybrid entity lookup', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['adarsh', {
          ...makeEntity('adarsh', 'Adarsh Tadimari', 'person'),
          aliases: [],
          properties: { description: 'Technical team member at Plotline.' },
        }],
      ])
      const mentions: MockMention[] = [{
        entityId: 'adarsh',
        documentId: 'doc-1',
        chunkIndex: 0,
        bucketId: 'bucket-1',
        mentionType: 'entity',
        surfaceText: 'Adarsh',
        normalizedSurfaceText: 'adarsh',
      }]
      const store = mockStore(entities, [], mentions)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue([]),
        searchPassageNodes: vi.fn().mockResolvedValue([]),
        getPassageEdgesForEntities: vi.fn().mockResolvedValue([{
          passageId: 'passage_test',
          entityId: 'adarsh',
          weight: 1.5,
          mentionCount: 1,
          confidence: 0.9,
          surfaceTexts: ['Adarsh'],
          mentionTypes: ['entity'],
        }]),
        getPassagesByIds: vi.fn().mockResolvedValue([{
          passageId: 'passage_test',
          content: 'Adarsh Tadimari is debugging Plotline SDK initialization issues.',
          bucketId: 'bucket-1',
          documentId: 'doc-1',
          chunkIndex: 0,
          totalChunks: 1,
          metadata: { source: 'test' },
          userId: 'test-user',
        }]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
        explorationLlm: {
          generateText: vi.fn().mockResolvedValue(''),
          generateJSON: vi.fn().mockResolvedValue({
            sourceEntityQueries: ['Adarsh'],
            targetEntityQueries: [],
            predicates: [],
            answerSide: 'none',
            subqueries: ['Adarsh'],
            mode: 'summary',
          }),
        },
      })

      const result = await bridge.searchGraphPassages!('Adarsh', testScope, { count: 5 })

      expect(store.searchEntitiesHybrid).toHaveBeenCalledWith(expect.any(String), expect.any(Array), testScope, 5)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({
        passageId: 'passage_test',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 0,
      }))
      expect(result.results[0]!.score).toBeGreaterThan(0)
      expect(result.trace.entitySeedCount).toBeGreaterThan(0)
      expect(result.trace.selectedEntityIds).toContain('adarsh')
    })

    it('attaches selected graph facts and entity names to evidence passages', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['tennyson', makeEntity('tennyson', 'Tennyson', 'person')],
        ['maud', makeEntity('maud', 'Maud', 'work_of_art')],
      ])
      const edges = [makeEdge('edge-1', 'tennyson', 'maud', 'WROTE')]
      const fact: SemanticFactRecord = {
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'tennyson',
        targetEntityId: 'maud',
        relation: 'WROTE',
        factText: 'Tennyson wrote Maud',
        weight: 1,
        evidenceCount: 1,
        scope: testScope,
        createdAt: new Date(),
        updatedAt: new Date(),
        similarity: 0.9,
      }
      const store = mockStore(entities, edges)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue([fact]),
        searchPassageNodes: vi.fn().mockResolvedValue([]),
        getPassageEdgesForEntities: vi.fn().mockResolvedValue([
          {
            passageId: 'passage_maud',
            entityId: 'tennyson',
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Tennyson'],
            mentionTypes: ['subject'],
          },
          {
            passageId: 'passage_maud',
            entityId: 'maud',
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Maud'],
            mentionTypes: ['object'],
          },
        ]),
        getPassagesByIds: vi.fn().mockResolvedValue([{
          passageId: 'passage_maud',
          content: 'A tiny shell was moralised over by Tennyson in Maud.',
          bucketId: 'bucket-1',
          documentId: 'doc-1',
          chunkIndex: 0,
          totalChunks: 1,
          metadata: { source: 'test' },
          userId: 'test-user',
        }]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
        explorationLlm: {
          generateText: vi.fn().mockResolvedValue(''),
          generateJSON: vi.fn().mockResolvedValue({
            sourceEntityQueries: [],
            targetEntityQueries: ['Maud'],
            predicates: [{ name: 'WROTE', confidence: 0.95 }],
            answerSide: 'source',
            subqueries: ['who wrote Maud'],
            mode: 'fact',
          }),
        },
      })

      const result = await bridge.searchGraphPassages!('Who moralised Maud?', testScope, { count: 5 })

      expect(result.facts).toEqual([expect.objectContaining({ id: 'fact-1', factText: 'Tennyson wrote Maud' })])
      expect(result.facts[0]!.properties?.relevanceScore).toEqual(expect.any(Number))
      expect(result.entities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'tennyson', name: 'Tennyson' }),
        expect.objectContaining({ id: 'maud', name: 'Maud' }),
      ]))
      expect(result.results[0]).not.toHaveProperty('facts')
      expect(result.results[0]).not.toHaveProperty('entities')
      expect(result.trace.finalPassageIds).toEqual(['passage_maud'])
      expect(result.trace.selectedFactTexts).toEqual([{ id: 'fact-1', content: 'Tennyson wrote Maud' }])
      expect(result.trace.selectedEntityNames).toEqual(expect.arrayContaining([
        { id: 'tennyson', content: 'Tennyson' },
        { id: 'maud', content: 'Maud' },
      ]))
    })

    it('ranks exact entity-constrained facts ahead of weaker adjacent facts and emits chains', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['tennyson', makeEntity('tennyson', 'Tennyson', 'person')],
        ['maud', makeEntity('maud', 'Maud', 'work_of_art')],
        ['shell', makeEntity('shell', 'Tiny shell', 'object')],
        ['lizard', makeEntity('lizard', 'Lizard', 'place')],
      ])
      const edges = [
        makeEdge('edge-1', 'tennyson', 'maud', 'WROTE'),
        makeEdge('edge-2', 'maud', 'shell', 'MORALISED'),
        makeEdge('edge-3', 'lizard', 'shell', 'CONTAINS'),
      ]
      const facts: SemanticFactRecord[] = [
        {
          id: 'fact-noisy',
          edgeId: 'edge-3',
          sourceEntityId: 'lizard',
          targetEntityId: 'shell',
          relation: 'CONTAINS',
          factText: 'Lizard contains a tiny shell',
          weight: 1,
          evidenceCount: 1,
          scope: testScope,
          createdAt: new Date(),
          updatedAt: new Date(),
          similarity: 0.6,
        },
        {
          id: 'fact-maud',
          edgeId: 'edge-1',
          sourceEntityId: 'tennyson',
          targetEntityId: 'maud',
          relation: 'WROTE',
          factText: 'Tennyson wrote Maud',
          weight: 1,
          evidenceCount: 1,
          scope: testScope,
          createdAt: new Date(),
          updatedAt: new Date(),
          similarity: 0.3,
        },
        {
          id: 'fact-shell',
          edgeId: 'edge-2',
          sourceEntityId: 'maud',
          targetEntityId: 'shell',
          relation: 'MORALISED',
          factText: 'Maud moralised a tiny shell',
          weight: 1,
          evidenceCount: 1,
          scope: testScope,
          createdAt: new Date(),
          updatedAt: new Date(),
          similarity: 0.2,
        },
      ]
      const store = mockStore(entities, edges)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue(facts),
        searchPassageNodes: vi.fn().mockResolvedValue([]),
        getPassageEdgesForEntities: vi.fn().mockResolvedValue([
          {
            passageId: 'passage_maud',
            entityId: 'tennyson',
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Tennyson'],
            mentionTypes: ['subject'],
          },
          {
            passageId: 'passage_maud',
            entityId: 'maud',
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Maud'],
            mentionTypes: ['object'],
          },
          {
            passageId: 'passage_shell',
            entityId: 'shell',
            weight: 0.4,
            mentionCount: 1,
            surfaceTexts: ['shell'],
            mentionTypes: ['object'],
          },
        ]),
        getPassagesByIds: vi.fn().mockResolvedValue([
          {
            passageId: 'passage_maud',
            content: 'A tiny shell was moralised over by Tennyson in Maud.',
            bucketId: 'bucket-1',
            documentId: 'doc-1',
            chunkIndex: 0,
            totalChunks: 1,
            metadata: { source: 'test' },
            userId: 'test-user',
          },
          {
            passageId: 'passage_shell',
            content: 'The Lizard coast contains shells.',
            bucketId: 'bucket-1',
            documentId: 'doc-2',
            chunkIndex: 0,
            totalChunks: 1,
            metadata: { source: 'test' },
            userId: 'test-user',
          },
        ]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
        explorationLlm: {
          generateText: vi.fn().mockResolvedValue(''),
          generateJSON: vi.fn().mockResolvedValue({
            sourceEntityQueries: [],
            targetEntityQueries: ['Maud'],
            predicates: [{ name: 'WROTE', confidence: 0.95 }],
            answerSide: 'source',
            subqueries: ['who wrote Maud'],
            mode: 'fact',
          }),
        },
      })

      const result = await bridge.searchGraphPassages!('Who wrote Maud?', testScope, {
        count: 5,
        factCandidateLimit: 3,
        factChainLimit: 2,
      })

      expect(result.trace.selectedFactIds[0]).toBe('fact-maud')
      expect(result.facts[0]).toEqual(expect.objectContaining({ id: 'fact-maud', factText: 'Tennyson wrote Maud' }))
      expect(result.facts.map(fact => fact.id)).not.toContain('fact-noisy')
      expect(result.facts.map(fact => fact.id)).not.toContain('fact-shell')
      expect(result.factChains).toEqual([])
      expect(result.trace.selectedFactChains).toEqual([])
    })
  })

  describe('explore graph intent V2', () => {
    it('uses LLM source/target intent to keep only matching killer facts', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['aac', makeEntity('aac', 'Aac', 'person')],
        ['chaacmol', makeEntity('chaacmol', 'Chaacmol', 'person')],
        ['moo', makeEntity('moo', 'Moo', 'person')],
      ])
      const edges = [
        makeEdge('edge-killed', 'aac', 'chaacmol', 'KILLED'),
        makeEdge('edge-sibling', 'chaacmol', 'aac', 'SIBLING_OF'),
        makeEdge('edge-married', 'chaacmol', 'moo', 'MARRIED'),
      ]
      const store = mockStore(entities, edges)
      const explorationLlm = {
        generateText: vi.fn().mockResolvedValue(''),
        generateJSON: vi.fn().mockResolvedValue({
          sourceEntityQueries: [],
          targetEntityQueries: ['Chaacmol'],
          predicates: [{ name: 'KILLED', confidence: 0.98 }],
          answerSide: 'source',
          subqueries: ['who killed Chaacmol'],
          mode: 'fact',
        }),
      }
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        explorationLlm,
      })

      const result = await bridge.explore!('Who killed Chaacmol?', { userId: 'test-user', explain: true })

      expect(result.trace?.parser).toBe('llm')
      expect(result.intent.targetEntityQueries).toEqual(['Chaacmol'])
      expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(['KILLED'])
      expect(result.facts.map(fact => fact.edgeId)).toEqual(['edge-killed'])
      expect(result.entities.map(entity => entity.name).sort()).toEqual(['Aac', 'Chaacmol'])
    })

    it('treats spouse facts as symmetric evidence without returning unrelated relations', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['aac', makeEntity('aac', 'Aac', 'person')],
        ['chaacmol', makeEntity('chaacmol', 'Chaacmol', 'person')],
        ['moo', makeEntity('moo', 'Moo', 'person')],
      ])
      const edges = [
        makeEdge('edge-killed', 'aac', 'chaacmol', 'KILLED'),
        makeEdge('edge-sibling', 'chaacmol', 'aac', 'SIBLING_OF'),
        makeEdge('edge-married', 'moo', 'chaacmol', 'MARRIED'),
      ]
      const store = mockStore(entities, edges)
      const explorationLlm = {
        generateText: vi.fn().mockResolvedValue(''),
        generateJSON: vi.fn().mockResolvedValue({
          sourceEntityQueries: ['Chaacmol'],
          targetEntityQueries: [],
          predicates: [{ name: 'WIFE_OF', confidence: 0.98 }],
          answerSide: 'target',
          subqueries: ['Chaacmol wife spouse married'],
          mode: 'fact',
        }),
      }
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        explorationLlm,
      })

      const result = await bridge.explore!('Who is Chaacmol wife?', { userId: 'test-user', explain: true })

      expect(result.intent.predicates).toEqual([
        expect.objectContaining({ name: 'MARRIED', symmetric: true }),
      ])
      expect(result.facts.map(fact => fact.edgeId)).toEqual(['edge-married'])
      expect(result.entities.map(entity => entity.name).sort()).toEqual(['Chaacmol', 'Moo'])
      expect(result.facts.map(fact => fact.relation)).not.toContain('KILLED')
      expect(result.facts.map(fact => fact.relation)).not.toContain('SIBLING_OF')
    })
  })
})
