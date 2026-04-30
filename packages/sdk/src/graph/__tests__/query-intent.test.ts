import { describe, expect, it, vi } from 'vitest'
import { parseGraphQueryIntent } from '../query-intent.js'
import type { LLMProvider } from '../../types/llm-provider.js'

function mockLlm(output: unknown): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue(output),
  }
}

describe('parseGraphQueryIntent', () => {
  it('returns empty intent when no exploration LLM is configured', async () => {
    const result = await parseGraphQueryIntent({ query: 'Who killed Chaacmol?' })

    expect(result.parser).toBe('none')
    expect(result.fallbackUsed).toBe(false)
    expect(result.intent.sourceEntityQueries).toEqual([])
    expect(result.intent.targetEntityQueries).toEqual([])
    expect(result.intent.predicates).toEqual([])
    expect(result.intent.answerSide).toBe('none')
  })

  it('parses parent questions into target anchor, PARENT_OF, and source answer side', async () => {
    const result = await parseGraphQueryIntent({
      query: 'Who are Chaacmol parents?',
      llm: mockLlm({
        sourceEntityQueries: [],
        targetEntityQueries: ['Chaacmol'],
        predicates: [{ name: 'PARENT_OF', confidence: 0.98 }],
        answerSide: 'source',
        subqueries: ['Chaacmol parents'],
        mode: 'fact',
      }),
    })

    expect(result.parser).toBe('llm')
    expect(result.fallbackUsed).toBe(false)
    expect(result.intent.targetEntityQueries).toEqual(['Chaacmol'])
    expect(result.intent.predicates).toEqual([{ name: 'PARENT_OF', confidence: 0.98, symmetric: false }])
    expect(result.intent.answerSide).toBe('source')
  })

  it('parses active killer questions into source anchor and target answer side', async () => {
    const result = await parseGraphQueryIntent({
      query: 'Who did Aac kill?',
      llm: mockLlm({
        sourceEntityQueries: ['Aac'],
        targetEntityQueries: [],
        predicates: [{ name: 'KILLED', confidence: 0.97 }],
        answerSide: 'target',
        subqueries: ['Aac killed'],
        mode: 'fact',
      }),
    })

    expect(result.intent.sourceEntityQueries).toEqual(['Aac'])
    expect(result.intent.targetEntityQueries).toEqual([])
    expect(result.intent.predicates.map((predicate) => predicate.name)).toEqual(['KILLED'])
    expect(result.intent.answerSide).toBe('target')
  })

  it('parses passive killer questions into target anchor and source answer side', async () => {
    const result = await parseGraphQueryIntent({
      query: 'Who was Chaacmol killed by?',
      llm: mockLlm({
        sourceEntityQueries: [],
        targetEntityQueries: ['Chaacmol'],
        predicates: [{ name: 'KILLED', confidence: 0.97 }],
        answerSide: 'source',
        subqueries: ['Chaacmol killed by'],
        mode: 'fact',
      }),
    })

    expect(result.intent.sourceEntityQueries).toEqual([])
    expect(result.intent.targetEntityQueries).toEqual(['Chaacmol'])
    expect(result.intent.predicates.map((predicate) => predicate.name)).toEqual(['KILLED'])
    expect(result.intent.answerSide).toBe('source')
  })

  it('normalizes gendered spouse predicates to MARRIED', async () => {
    const result = await parseGraphQueryIntent({
      query: 'Who is Chaacmol wife?',
      llm: mockLlm({
        sourceEntityQueries: ['Chaacmol'],
        targetEntityQueries: [],
        predicates: [{ name: 'WIFE_OF', confidence: 0.91 }],
        answerSide: 'target',
        subqueries: ['Chaacmol wife spouse married'],
        mode: 'fact',
      }),
    })

    expect(result.intent.sourceEntityQueries).toEqual(['Chaacmol'])
    expect(result.intent.predicates).toEqual([{ name: 'MARRIED', confidence: 0.91, symmetric: true }])
    expect(result.intent.answerSide).toBe('target')
  })

  it('parses sibling questions into symmetric sibling intent', async () => {
    const result = await parseGraphQueryIntent({
      query: 'Who is Chaacmol brother?',
      llm: mockLlm({
        sourceEntityQueries: ['Chaacmol'],
        targetEntityQueries: [],
        predicates: [{ name: 'BROTHER_OF', confidence: 0.93 }],
        answerSide: 'target',
        subqueries: ['Chaacmol brother sibling'],
        mode: 'fact',
      }),
    })

    expect(result.intent.sourceEntityQueries).toEqual(['Chaacmol'])
    expect(result.intent.predicates).toEqual([{ name: 'SIBLING_OF', confidence: 0.93, symmetric: true }])
    expect(result.intent.answerSide).toBe('target')
  })

  it('drops predicates that are not in the ontology', async () => {
    const result = await parseGraphQueryIntent({
      query: 'What happened in Chaacmol funeral chamber?',
      llm: mockLlm({
        sourceEntityQueries: ['Chaacmol'],
        targetEntityQueries: ['funeral chamber'],
        predicates: [{ name: 'FUNERAL_CHAMBER_IN', confidence: 0.9 }],
        answerSide: 'either',
        subqueries: ['Chaacmol funeral chamber'],
        mode: 'summary',
      }),
    })

    expect(result.intent.predicates).toEqual([])
    expect(result.intent.sourceEntityQueries).toEqual(['Chaacmol'])
    expect(result.intent.targetEntityQueries).toEqual(['funeral chamber'])
  })

  it('returns empty graph intent when LLM parsing fails', async () => {
    const llm: LLMProvider = {
      generateText: vi.fn().mockResolvedValue(''),
      generateJSON: vi.fn().mockRejectedValue(new Error('bad JSON')),
    }

    const result = await parseGraphQueryIntent({ query: 'Who killed Chaacmol?', llm })

    expect(result.parser).toBe('none')
    expect(result.fallbackUsed).toBe(false)
    expect(result.intent.predicates).toEqual([])
    expect(result.intent.answerSide).toBe('none')
  })
})
