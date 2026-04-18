import { describe, it, expect, vi } from 'vitest'
import { createMemoryBridge } from '../memory-bridge.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { SemanticEntity, SemanticEdge } from '../types/memory.js'
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

function mockLLM() {
  return {
    generateText: vi.fn().mockResolvedValue('mock text'),
    generateJSON: vi.fn().mockResolvedValue({}),
  }
}

describe('createMemoryBridge', () => {
  it('remember delegates to TypegraphMemory', async () => {
    const store = mockStore()
    const bridge = createMemoryBridge({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    const result = await bridge.remember('test memory', { ...testScope })
    expect(result).toBeDefined()
    expect(store.upsert).toHaveBeenCalled()
  })

  it('forget calls store.invalidate directly', async () => {
    const store = mockStore()
    const bridge = createMemoryBridge({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    await bridge.forget('some-id', { ...testScope })
    expect(store.invalidate).toHaveBeenCalledWith('some-id')
  })

  it('recall delegates to TypegraphMemory', async () => {
    const store = mockStore()
    const bridge = createMemoryBridge({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM(),
    })

    const results = await bridge.recall('query', { ...testScope })
    expect(Array.isArray(results)).toBe(true)
    expect(store.search).toHaveBeenCalled()
  })
})
