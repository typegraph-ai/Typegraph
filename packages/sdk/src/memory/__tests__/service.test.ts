import { describe, it, expect, vi } from 'vitest'
import { MemoryService } from '../service.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { ExternalId, MemoryRecord, SemanticEntity, SemanticEdge, SemanticGraphEdge } from '../types/memory.js'
import { buildScope } from '../types/scope.js'

const testScope = buildScope({ userId: 'test-user' })

function mockStore() {
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
    upsertEntity: vi.fn().mockImplementation(async (e: SemanticEntity) => e),
    getEntity: vi.fn().mockResolvedValue(null),
    findEntities: vi.fn().mockResolvedValue([]),
    searchEntities: vi.fn().mockResolvedValue([]),
    upsertEdge: vi.fn().mockImplementation(async (e: SemanticEdge) => e),
    getEntitiesBatch: vi.fn().mockResolvedValue([]),
    getEdges: vi.fn().mockResolvedValue([]),
    getEdgesBatch: vi.fn().mockResolvedValue([]),
    findEdges: vi.fn().mockResolvedValue([]),
    invalidateEdge: vi.fn(),
    invalidateGraphEdgesForNode: vi.fn(),
  }
  return store
}

function mockEmbedding() {
  let counter = 0
  return {
    name: 'mock-embed',
    dimensions: 10,
    embed: vi.fn().mockImplementation(async (input: { texts: string[] }) => {
      return input.texts.map(() => {
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

describe('MemoryService', () => {
  it('stores memories directly through the service', async () => {
    const store = mockStore()
    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    const result = await runtime.remember('test memory', { identity: testScope })
    expect(result).toBeDefined()
    expect(store.upsert).toHaveBeenCalled()
  })

  it('forget calls store.invalidate directly', async () => {
    const store = mockStore()
    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    await runtime.forget('some-id', { identity: testScope })
    expect(store.invalidate).toHaveBeenCalledWith('some-id')
    expect(store.invalidateGraphEdgesForNode).toHaveBeenCalledWith('memory', 'some-id')
  })

  it('recalls memories directly through the runtime', async () => {
    const store = mockStore()
    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    const results = await runtime.recall('query', { identity: testScope })
    expect(Array.isArray(results)).toBe(true)
    expect(store.search).toHaveBeenCalled()
  })

  it('uses explicit identity for service operations', async () => {
    const store = mockStore()
    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    await runtime.remember('test memory', { identity: testScope })
    const results = await runtime.recall('query', { identity: testScope })
    await runtime.forget('some-id', { identity: testScope })

    expect(Array.isArray(results)).toBe(true)
    expect(store.upsert).toHaveBeenCalled()
    expect(store.search).toHaveBeenCalled()
    expect(store.invalidate).toHaveBeenCalledWith('some-id')
  })

  it('links memories to deterministic external-ID subjects and recalls by entity scope', async () => {
    const store = mockStore()
    const records: MemoryRecord[] = []
    const entities = new Map<string, SemanticEntity>()
    const edges: SemanticGraphEdge[] = []
    const email: ExternalId = { id: 'pat@example.com', type: 'email' }

    Object.assign(store, {
      upsert: vi.fn().mockImplementation(async (record: MemoryRecord) => {
        records.push(record)
        return record
      }),
      findEntityByExternalId: vi.fn().mockImplementation(async (externalId: ExternalId) => {
        return [...entities.values()].find(entity =>
          entity.externalIds?.some(id =>
            id.type === externalId.type &&
            id.id === externalId.id
          )
        ) ?? null
      }),
      upsertEntity: vi.fn().mockImplementation(async (entity: SemanticEntity) => {
        entities.set(entity.id, entity)
        return entity
      }),
      upsertGraphEdges: vi.fn().mockImplementation(async (nextEdges: SemanticGraphEdge[]) => {
        edges.push(...nextEdges)
      }),
      getMemoryIdsForEntities: vi.fn().mockImplementation(async (entityIds: string[]) => {
        const ids = new Set(entityIds)
        return edges
          .filter(edge => edge.sourceType === 'memory' && edge.targetType === 'entity' && ids.has(edge.targetId))
          .map(edge => edge.sourceId)
      }),
      search: vi.fn().mockImplementation(async (_embedding, opts) => {
        const ids = new Set(opts.filter?.ids ?? [])
        return ids.size > 0 ? records.filter(record => ids.has(record.id)) : records
      }),
    })

    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })
    const identity = { tenantId: 'acme' }

    const memory = await runtime.remember('Prefers SMS for urgent notices', {
      identity,
      subject: {
        externalIds: [email],
        entityType: 'person',
      },
    })
    const recalled = await runtime.recall('urgent notices', {
      identity,
      entityScope: { externalIds: [email] },
    })

    expect(store.upsertEntity).toHaveBeenCalledWith(expect.objectContaining({
      name: 'pat@example.com',
      entityType: 'person',
      externalIds: [email],
      scope: expect.objectContaining({ tenantId: 'acme' }),
      accessScope: undefined,
    }))
    expect(store.upsertGraphEdges).toHaveBeenCalledWith([expect.objectContaining({
      sourceType: 'memory',
      sourceId: memory.id,
      targetType: 'entity',
      relation: 'ABOUT',
      scope: expect.objectContaining({ tenantId: 'acme' }),
      accessScope: undefined,
    })])
    expect(store.getMemoryIdsForEntities).toHaveBeenCalledWith([expect.any(String)], identity)
    expect(recalled).toEqual([memory])
  })

  it('returns empty scoped recall when external IDs resolve to no entity', async () => {
    const store = mockStore()
    const email: ExternalId = { id: 'missing@example.com', type: 'email' }
    Object.assign(store, {
      findEntityByExternalId: vi.fn().mockResolvedValue(null),
      getMemoryIdsForEntities: vi.fn().mockResolvedValue(['should-not-be-used']),
      search: vi.fn().mockResolvedValue([]),
    })
    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })
    const identity = { tenantId: 'acme' }

    const recalled = await runtime.recall('urgent notices', {
      identity,
      entityScope: { externalIds: [email] },
    })

    expect(store.getMemoryIdsForEntities).not.toHaveBeenCalled()
    expect(store.search).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      filter: expect.objectContaining({ ids: [] }),
    }))
    expect(recalled).toEqual([])
  })
})
