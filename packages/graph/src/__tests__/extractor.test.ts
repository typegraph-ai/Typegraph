import { describe, it, expect, vi } from 'vitest'
import { MemoryExtractor } from '../extraction/extractor.js'
import type { LLMProvider } from '../extraction/llm-provider.js'
import type { EmbeddingProvider } from '@d8um-ai/core'
import type { SemanticFact } from '../types/memory.js'
import { buildScope } from '../types/scope.js'

function mockLLM(overrides?: Partial<LLMProvider>): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function mockEmbedding(): EmbeddingProvider {
  return {
    model: 'test-model',
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }
}

const testScope = buildScope({ userId: 'alice' })

describe('MemoryExtractor', () => {
  describe('extractFacts', () => {
    it('extracts facts from conversation messages', async () => {
      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue([
          {
            content: 'Alice works at Acme Corp',
            subject: 'Alice',
            predicate: 'works_at',
            object: 'Acme Corp',
            importance: 0.8,
            confidence: 0.9,
          },
        ]),
      })

      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })
      const facts = await extractor.extractFacts([
        { role: 'user', content: 'I just started working at Acme Corp' },
      ])

      expect(facts).toHaveLength(1)
      expect(facts[0]!.subject).toBe('Alice')
      expect(facts[0]!.predicate).toBe('works_at')
      expect(facts[0]!.object).toBe('Acme Corp')
    })

    it('returns empty array when LLM returns non-array', async () => {
      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue('not an array'),
      })

      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })
      const facts = await extractor.extractFacts([
        { role: 'user', content: 'Hello' },
      ])

      expect(facts).toHaveLength(0)
    })

    it('filters out malformed facts', async () => {
      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue([
          { content: 'Valid fact', subject: 'A', predicate: 'is', object: 'B', importance: 0.5, confidence: 0.5 },
          { content: 123 }, // invalid: content not a string
          { subject: 'X' }, // invalid: missing content
        ]),
      })

      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })
      const facts = await extractor.extractFacts([
        { role: 'user', content: 'Test' },
      ])

      expect(facts).toHaveLength(1)
    })
  })

  describe('resolveConflicts', () => {
    it('returns ADD for all candidates when no existing facts', async () => {
      const llm = mockLLM()
      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })

      const candidates = [
        { content: 'Alice works at Acme', subject: 'Alice', predicate: 'works_at', object: 'Acme', importance: 0.8, confidence: 0.9 },
      ]

      const operations = await extractor.resolveConflicts(candidates, [])
      expect(operations).toHaveLength(1)
      expect(operations[0]!.type).toBe('ADD')
    })

    it('uses LLM to resolve conflicts with existing facts', async () => {
      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue({
          operation: 'UPDATE',
          targetIndex: 0,
          reasoning: 'More specific information',
        }),
      })

      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })

      const existing: SemanticFact[] = [{
        id: 'existing-1',
        category: 'semantic',
        status: 'active',
        content: 'Alice works at a tech company',
        subject: 'Alice',
        predicate: 'works_at',
        object: 'tech company',
        confidence: 0.7,
        sourceMemoryIds: [],
        importance: 0.5,
        accessCount: 0,
        lastAccessedAt: new Date(),
        metadata: {},
        scope: testScope,
        validAt: new Date(),
        createdAt: new Date(),
      }]

      const candidates = [
        { content: 'Alice works at Acme Corp', subject: 'Alice', predicate: 'works_at', object: 'Acme Corp', importance: 0.8, confidence: 0.9 },
      ]

      const operations = await extractor.resolveConflicts(candidates, existing)
      expect(operations).toHaveLength(1)
      expect(operations[0]!.type).toBe('UPDATE')
      expect(operations[0]!.targetId).toBe('existing-1')
    })

    it('defaults to ADD on LLM failure', async () => {
      const llm = mockLLM({
        generateJSON: vi.fn().mockRejectedValue(new Error('LLM error')),
      })

      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })

      const existing: SemanticFact[] = [{
        id: 'existing-1',
        category: 'semantic',
        status: 'active',
        content: 'Something',
        subject: 'X',
        predicate: 'is',
        object: 'Y',
        confidence: 0.5,
        sourceMemoryIds: [],
        importance: 0.5,
        accessCount: 0,
        lastAccessedAt: new Date(),
        metadata: {},
        scope: testScope,
        validAt: new Date(),
        createdAt: new Date(),
      }]

      const operations = await extractor.resolveConflicts(
        [{ content: 'New fact', subject: 'X', predicate: 'is', object: 'Z', importance: 0.5, confidence: 0.8 }],
        existing,
      )

      expect(operations[0]!.type).toBe('ADD')
      expect(operations[0]!.confidence).toBe(0.4) // 0.8 * 0.5
    })
  })

  describe('createEpisodicMemory', () => {
    it('creates an episodic memory from messages', () => {
      const extractor = new MemoryExtractor({ llm: mockLLM(), embedding: mockEmbedding(), scope: testScope })
      const episode = extractor.createEpisodicMemory(
        [{ role: 'user', content: 'Hello world' }],
        'session-1',
        1,
      )

      expect(episode.category).toBe('episodic')
      expect(episode.eventType).toBe('conversation')
      expect(episode.sessionId).toBe('session-1')
      expect(episode.sequence).toBe(1)
      expect(episode.content).toContain('Hello world')
      expect(episode.scope).toEqual(testScope)
    })
  })

  describe('processConversation', () => {
    it('runs the full extraction pipeline', async () => {
      const llm = mockLLM({
        generateJSON: vi.fn().mockResolvedValue([
          { content: 'Alice likes TypeScript', subject: 'Alice', predicate: 'likes', object: 'TypeScript', importance: 0.7, confidence: 0.85 },
        ]),
      })

      const extractor = new MemoryExtractor({ llm, embedding: mockEmbedding(), scope: testScope })
      const result = await extractor.processConversation([
        { role: 'user', content: 'I really love TypeScript' },
      ])

      expect(result.episodic).toHaveLength(1)
      expect(result.facts).toHaveLength(1)
      expect(result.facts[0]!.content).toBe('Alice likes TypeScript')
      expect(result.operations).toHaveLength(1)
      expect(result.operations[0]!.type).toBe('ADD')
    })
  })
})
