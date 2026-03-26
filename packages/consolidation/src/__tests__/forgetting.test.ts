import { describe, it, expect, vi } from 'vitest'
import { ForgettingEngine } from '../forgetting.js'
import type { MemoryStoreAdapter, MemoryRecord } from '@d8um/memory'
import { buildScope } from '@d8um/memory'

const scope = buildScope({ userId: 'test' })

function makeRecord(id: string, importance: number, daysOld: number): MemoryRecord {
  const lastAccessed = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
  return {
    id,
    category: 'semantic',
    content: `Memory ${id}`,
    importance,
    accessCount: 0,
    lastAccessedAt: lastAccessed,
    metadata: {},
    scope,
    validAt: lastAccessed,
    createdAt: lastAccessed,
  }
}

function mockStore(records: MemoryRecord[]): MemoryStoreAdapter {
  return {
    initialize: vi.fn(),
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue(records),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
  }
}

describe('ForgettingEngine', () => {
  it('archives decayed memories', async () => {
    const old = makeRecord('old', 0.01, 60)
    const fresh = makeRecord('fresh', 0.9, 0)
    const store = mockStore([old, fresh])

    const engine = new ForgettingEngine(store)
    const result = await engine.forget(scope, 'archive')

    expect(result.archived).toBe(1)
    expect(store.expire).toHaveBeenCalledWith('old')
    expect(store.expire).not.toHaveBeenCalledWith('fresh')
  })

  it('deletes decayed memories', async () => {
    const old = makeRecord('old', 0.01, 60)
    const store = mockStore([old])

    const engine = new ForgettingEngine(store)
    const result = await engine.forget(scope, 'delete')

    expect(result.deleted).toBe(1)
    expect(store.delete).toHaveBeenCalledWith('old')
  })

  it('returns zero counts when no memories are decayed', async () => {
    const fresh = makeRecord('fresh', 0.9, 0)
    const store = mockStore([fresh])

    const engine = new ForgettingEngine(store)
    const result = await engine.forget(scope, 'archive')

    expect(result.totalProcessed).toBe(0)
  })

  it('summarizes decayed memories with LLM', async () => {
    const old1 = makeRecord('old1', 0.01, 60)
    const old2 = makeRecord('old2', 0.01, 60)
    const store = mockStore([old1, old2])

    const llm = {
      generateText: vi.fn().mockResolvedValue('Combined summary'),
      generateJSON: vi.fn(),
    }

    const engine = new ForgettingEngine(store, llm)
    const result = await engine.forget(scope, 'summarize')

    expect(result.summarized).toBe(1) // one summary for the semantic group
    expect(store.upsert).toHaveBeenCalled()
    expect(store.expire).toHaveBeenCalledTimes(2) // both originals archived
  })
})
