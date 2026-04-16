import { describe, it, expect, vi } from 'vitest'
import { InvalidationEngine } from '../extraction/invalidation.js'
import type { LLMProvider } from '../extraction/llm-provider.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { SemanticFact } from '../types/memory.js'
import { buildScope } from '../types/scope.js'

function mockLLM(overrides?: Partial<LLMProvider>): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue({ contradicts: false, type: 'compatible', reasoning: 'No conflict' }),
    ...overrides,
  }
}

function makeFact(overrides?: Partial<SemanticFact>): SemanticFact {
  return {
    id: 'fact-1',
    category: 'semantic',
    status: 'active',
    content: 'Alice works at Google',
    subject: 'Alice',
    predicate: 'works_at',
    object: 'Google',
    confidence: 0.9,
    sourceMemoryIds: [],
    importance: 0.7,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope: buildScope({ userId: 'alice' }),
    validAt: new Date('2025-01-01'),
    createdAt: new Date('2025-01-01'),
    ...overrides,
  }
}

function mockStore(facts: SemanticFact[] = []): MemoryStoreAdapter {
  return {
    initialize: vi.fn(),
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue(facts),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue(facts),
  }
}

const testScope = buildScope({ userId: 'alice' })

describe('InvalidationEngine', () => {
  describe('checkContradictions', () => {
    it('detects a direct contradiction', async () => {
      const existingFact = makeFact({ id: 'old', content: 'Alice works at Google' })
      const newFact = makeFact({ id: 'new', content: 'Alice works at Meta', embedding: [0.1, 0.2, 0.3] })

      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue({
          contradicts: true,
          type: 'direct',
          reasoning: 'Alice cannot work at both companies simultaneously',
        }),
      })

      const engine = new InvalidationEngine({ llm, store: mockStore([existingFact]) })
      const contradictions = await engine.checkContradictions(newFact, testScope)

      expect(contradictions).toHaveLength(1)
      expect(contradictions[0]!.conflictType).toBe('direct')
      expect(contradictions[0]!.existingFact.id).toBe('old')
    })

    it('returns empty when no contradictions found', async () => {
      const existingFact = makeFact({ id: 'old', content: 'Alice works at Google' })
      const newFact = makeFact({ id: 'new', content: 'Alice likes coffee', embedding: [0.1, 0.2, 0.3] })

      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue({
          contradicts: false,
          type: 'compatible',
          reasoning: 'Different topics',
        }),
      })

      const engine = new InvalidationEngine({ llm, store: mockStore([existingFact]) })
      const contradictions = await engine.checkContradictions(newFact, testScope)

      expect(contradictions).toHaveLength(0)
    })

    it('returns empty when no related facts exist', async () => {
      const newFact = makeFact({ id: 'new', content: 'Alice likes TypeScript', embedding: [0.1, 0.2, 0.3] })

      const engine = new InvalidationEngine({ llm: mockLLM(), store: mockStore([]) })
      const contradictions = await engine.checkContradictions(newFact, testScope)

      expect(contradictions).toHaveLength(0)
    })

    it('skips comparison on LLM failure', async () => {
      const existingFact = makeFact({ id: 'old' })
      const newFact = makeFact({ id: 'new', embedding: [0.1, 0.2, 0.3] })

      const llm = mockLLM({
        generateJSON: vi.fn().mockRejectedValue(new Error('LLM error')),
      })

      const engine = new InvalidationEngine({ llm, store: mockStore([existingFact]) })
      const contradictions = await engine.checkContradictions(newFact, testScope)

      expect(contradictions).toHaveLength(0)
    })
  })

  describe('resolveContradictions', () => {
    it('invalidates the existing fact in the store', async () => {
      const store = mockStore()
      const engine = new InvalidationEngine({ llm: mockLLM(), store })

      const existingFact = makeFact({ id: 'old' })
      const newFact = makeFact({ id: 'new', validAt: new Date('2025-06-01') })

      await engine.resolveContradictions([{
        existingFact,
        newFact,
        conflictType: 'direct',
        confidence: 0.9,
        reasoning: 'Direct contradiction',
      }])

      expect(store.invalidate).toHaveBeenCalledWith('old', expect.any(Date))
    })
  })
})
