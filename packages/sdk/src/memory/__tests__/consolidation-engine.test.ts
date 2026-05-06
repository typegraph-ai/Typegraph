import { describe, expect, it, vi } from 'vitest'
import { ConsolidationEngine } from '../consolidation/engine.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { LLMProvider } from '../../types/llm-provider.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'

function createStore(): MemoryStoreAdapter {
  return {
    initialize: vi.fn(),
    upsert: vi.fn(async record => record),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn(async () => []),
    search: vi.fn(async () => []),
  }
}

describe('ConsolidationEngine', () => {
  const scope = { tenantId: 'tenant-1' }
  const llm: LLMProvider = {
    generateText: vi.fn(),
    generateJSON: vi.fn(),
  }
  const embedding: EmbeddingProvider = {
    model: 'mock',
    dimensions: 3,
    embed: vi.fn(async () => [0, 0, 0]),
    embedBatch: vi.fn(async texts => texts.map(() => [0, 0, 0])),
  }

  it('treats null consolidation opts as omitted', async () => {
    const store = createStore()
    const engine = new ConsolidationEngine({ memoryStore: store, llm, embedding })

    await expect(engine.consolidate(scope, null)).resolves.toEqual({
      factsExtracted: 0,
      factsUpdated: 0,
      proceduresCreated: 0,
      communitiesDetected: 0,
      episodesConsolidated: 0,
    })
  })

  it('treats null promotion opts as omitted', async () => {
    const store = createStore()
    const engine = new ConsolidationEngine({ memoryStore: store, llm, embedding })

    await expect(engine.promoteEpisodicToSemantic(scope, null)).resolves.toEqual({
      factsExtracted: 0,
      episodesConsolidated: 0,
    })
    await expect(engine.promoteToProcedural(scope, null)).resolves.toEqual({
      proceduresCreated: 0,
    })
  })
})
