import { describe, expect, it, vi } from 'vitest'
import { parseGraphQueryIntent } from '../query-intent.js'
import type { LLMProvider } from '../../types/llm-provider.js'
import type { GraphQueryIntent } from '../../types/graph-bridge.js'

function mockLlm(output: unknown): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue(output),
  }
}

function expectNoAnswerSide(intent: GraphQueryIntent): void {
  expect('answerSide' in intent).toBe(false)
}

function predicateNames(intent: GraphQueryIntent): string[] {
  return intent.predicates.map(predicate => predicate.name)
}

describe('parseGraphQueryIntent', () => {
  it.each([
    {
      query: 'Who killed Chaacmol?',
      source: [],
      target: ['Chaacmol'],
      predicates: ['KILLED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who did Aac kill?',
      source: ['Aac'],
      target: [],
      predicates: ['KILLED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who was Chaacmol killed by?',
      source: [],
      target: ['Chaacmol'],
      predicates: ['KILLED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Chaacmol was killed by whom?',
      source: [],
      target: ['Chaacmol'],
      predicates: ['KILLED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who murdered Julius Caesar?',
      source: [],
      target: ['Julius Caesar'],
      predicates: ['KILLED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who was Julius Caesar assassinated by?',
      source: [],
      target: ['Julius Caesar'],
      predicates: ['KILLED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who is Chaacmol's wife?",
      source: ['Chaacmol'],
      target: [],
      predicates: ['MARRIED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who is Chaacmol's husband?",
      source: ['Chaacmol'],
      target: [],
      predicates: ['MARRIED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who is Chaacmol wife?',
      source: ['Chaacmol'],
      target: [],
      predicates: ['MARRIED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who was Marie Curie married to?',
      source: ['Marie Curie'],
      target: [],
      predicates: ['MARRIED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who is the spouse of Barack Obama?',
      source: ['Barack Obama'],
      target: [],
      predicates: ['MARRIED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who are Chaacmol's parents?",
      source: [],
      target: ['Chaacmol'],
      predicates: ['PARENT_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who is Chaacmol's father?",
      source: [],
      target: ['Chaacmol'],
      predicates: ['PARENT_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who is Chaacmol's mother?",
      source: [],
      target: ['Chaacmol'],
      predicates: ['PARENT_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who are CAN's children?",
      source: [],
      target: ['CAN'],
      predicates: ['CHILD_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who is the son of CAN?',
      source: [],
      target: ['CAN'],
      predicates: ['CHILD_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who did CAN father?',
      source: ['CAN'],
      target: [],
      predicates: ['PARENT_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who is Chaacmol's brother?",
      source: ['Chaacmol'],
      target: [],
      predicates: ['SIBLING_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who is Chaacmol's sister?",
      source: ['Chaacmol'],
      target: [],
      predicates: ['SIBLING_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: "Who are Chaacmol's siblings?",
      source: ['Chaacmol'],
      target: [],
      predicates: ['SIBLING_OF'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who wrote Frankenstein?',
      source: [],
      target: ['Frankenstein'],
      predicates: ['WROTE'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'What did Mary Shelley write?',
      source: ['Mary Shelley'],
      target: [],
      predicates: ['WROTE'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who authored Pride and Prejudice?',
      source: [],
      target: ['Pride and Prejudice'],
      predicates: ['WROTE'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'What books did Charles Dickens write?',
      source: ['Charles Dickens'],
      target: [],
      predicates: ['WROTE'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who founded Stripe?',
      source: [],
      target: ['Stripe'],
      predicates: ['FOUNDED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'What did Patrick Collison found?',
      source: ['Patrick Collison'],
      target: [],
      predicates: ['FOUNDED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who established Uxmal?',
      source: [],
      target: ['Uxmal'],
      predicates: ['FOUNDED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'What company did Steve Jobs co-found?',
      source: ['Steve Jobs'],
      target: [],
      predicates: ['CO_FOUNDED'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Where was Marie Curie born?',
      source: ['Marie Curie'],
      target: [],
      predicates: ['BORN_IN'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Where did Albert Einstein die?',
      source: ['Albert Einstein'],
      target: [],
      predicates: ['DIED_IN'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Where is OpenAI headquartered?',
      source: ['OpenAI'],
      target: [],
      predicates: ['HEADQUARTERED_IN'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'What city is the Eiffel Tower located in?',
      source: ['Eiffel Tower'],
      target: [],
      predicates: ['LOCATED_IN'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who leads Microsoft?',
      source: [],
      target: ['Microsoft'],
      predicates: ['LEADS'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'What organization does Sam Altman lead?',
      source: ['Sam Altman'],
      target: [],
      predicates: ['LEADS'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Who works for OpenAI?',
      source: [],
      target: ['OpenAI'],
      predicates: ['WORKS_FOR'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Where does Alice work?',
      source: ['Alice'],
      target: [],
      predicates: ['WORKS_FOR'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Summarize the relationship between Aac and Chaacmol',
      source: ['Aac'],
      target: ['Chaacmol'],
      predicates: [],
      mode: 'summary',
      strictness: 'soft',
    },
    {
      query: 'How are Kubernetes and Docker related?',
      source: ['Kubernetes'],
      target: ['Docker'],
      predicates: [],
      mode: 'relationship',
      strictness: 'soft',
    },
    {
      query: 'What connects Tesla and Edison?',
      source: ['Tesla'],
      target: ['Edison'],
      predicates: [],
      mode: 'relationship',
      strictness: 'soft',
    },
    {
      query: "Write a diary entry from Elizabeth Bennet's perspective about Darcy",
      source: ['Elizabeth Bennet', 'Darcy'],
      target: [],
      predicates: [],
      mode: 'creative',
      strictness: 'soft',
    },
    {
      query: 'Imagine a letter from Aac to Chaacmol',
      source: ['Aac', 'Chaacmol'],
      target: [],
      predicates: [],
      mode: 'creative',
      strictness: 'soft',
    },
    {
      query: 'Tell me about Chaacmol',
      source: ['Chaacmol'],
      target: [],
      predicates: [],
      mode: 'summary',
      strictness: 'soft',
    },
    {
      query: 'What do we know about Uxmal?',
      source: ['Uxmal'],
      target: [],
      predicates: [],
      mode: 'summary',
      strictness: 'soft',
    },
    {
      query: 'Who wrote "The Great Gatsby"?',
      source: [],
      target: ['The Great Gatsby'],
      predicates: ['WROTE'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Tell me about CAN',
      source: ['CAN'],
      target: [],
      predicates: [],
      mode: 'summary',
      strictness: 'soft',
    },
    {
      query: 'Tell me about the Mayas’ temples',
      source: ['Mayas'],
      target: [],
      predicates: [],
      mode: 'summary',
      strictness: 'soft',
    },
    {
      query: 'Where is Worcester, Mass. located?',
      source: ['Worcester, Mass'],
      target: [],
      predicates: ['LOCATED_IN'],
      mode: 'fact',
      strictness: 'strict',
    },
    {
      query: 'Where is Chichen-Itza located?',
      source: ['Chichen-Itza'],
      target: [],
      predicates: ['LOCATED_IN'],
      mode: 'fact',
      strictness: 'strict',
    },
  ])('deterministically parses $query', async ({ query, source, target, predicates, mode, strictness }) => {
    const result = await parseGraphQueryIntent({ query })

    expect(result.parser).toBe('deterministic')
    expect(result.intent.sourceEntityQueries).toEqual(source)
    expect(result.intent.targetEntityQueries).toEqual(target)
    expect(predicateNames(result.intent)).toEqual(predicates)
    expect(result.intent.mode).toBe(mode)
    expect(result.intent.strictness).toBe(strictness)
    expect(result.intent.subqueries.length).toBeGreaterThan(0)
    expectNoAnswerSide(result.intent)
  })

  it.each([
    'what is going on here?',
    'summarize this',
    'why does this matter?',
    'compare the two passages',
  ])('returns no parser for non-actionable graph query %s', async (query) => {
    const result = await parseGraphQueryIntent({ query })

    expect(result.parser).toBe('none')
    expect(result.intent.strictness).toBe('none')
    expect(result.intent.sourceEntityQueries).toEqual([])
    expect(result.intent.targetEntityQueries).toEqual([])
    expect(result.intent.predicates).toEqual([])
    expectNoAnswerSide(result.intent)
  })

  it('marks symmetric predicate aliases as symmetric', async () => {
    const spouse = await parseGraphQueryIntent({ query: "Who is Chaacmol's wife?" })
    const sibling = await parseGraphQueryIntent({ query: "Who is Chaacmol's brother?" })

    expect(spouse.intent.predicates).toEqual([expect.objectContaining({ name: 'MARRIED', symmetric: true })])
    expect(sibling.intent.predicates).toEqual([expect.objectContaining({ name: 'SIBLING_OF', symmetric: true })])
  })

  it('uses deterministic mode by default and does not call an available LLM', async () => {
    const llm = mockLlm({
      sourceEntityQueries: [],
      targetEntityQueries: ['Wrong'],
      predicates: [{ name: 'KILLED', confidence: 0.9 }],
      subqueries: ['wrong'],
      mode: 'fact',
      strictness: 'strict',
    })

    const result = await parseGraphQueryIntent({ query: 'Who killed Chaacmol?', llm })

    expect(result.parser).toBe('deterministic')
    expect(result.intent.targetEntityQueries).toEqual(['Chaacmol'])
    expect(llm.generateJSON).not.toHaveBeenCalled()
  })

  it('calls the LLM only when llm parser mode is requested', async () => {
    const llm = mockLlm({
      sourceEntityQueries: ['Aac'],
      targetEntityQueries: [],
      predicates: [{ name: 'KILLED', confidence: 0.97 }],
      subqueries: ['Aac killed'],
      mode: 'fact',
      strictness: 'strict',
    })

    const result = await parseGraphQueryIntent({
      query: 'Who did Aac kill?',
      mode: 'llm',
      llm,
    })

    expect(result.parser).toBe('llm')
    expect(result.intent.sourceEntityQueries).toEqual(['Aac'])
    expect(predicateNames(result.intent)).toEqual(['KILLED'])
    expect(llm.generateJSON).toHaveBeenCalledTimes(1)
    expectNoAnswerSide(result.intent)
  })

  it('returns no parser when llm mode fails and does not use deterministic fallback', async () => {
    const llm: LLMProvider = {
      generateText: vi.fn().mockResolvedValue(''),
      generateJSON: vi.fn().mockRejectedValue(new Error('bad JSON')),
    }

    const result = await parseGraphQueryIntent({ query: 'Who killed Chaacmol?', mode: 'llm', llm })

    expect(result.parser).toBe('none')
    expect(result.intent.strictness).toBe('none')
    expect(result.intent.targetEntityQueries).toEqual([])
  })

  it('returns no parser when parser mode is none', async () => {
    const llm = mockLlm({})

    const result = await parseGraphQueryIntent({ query: 'Who killed Chaacmol?', mode: 'none', llm })

    expect(result.parser).toBe('none')
    expect(result.intent.strictness).toBe('none')
    expect(llm.generateJSON).not.toHaveBeenCalled()
  })

  it('drops invalid LLM predicates and traces them', async () => {
    const result = await parseGraphQueryIntent({
      query: 'What happened in Chaacmol funeral chamber?',
      mode: 'llm',
      llm: mockLlm({
        sourceEntityQueries: ['Chaacmol'],
        targetEntityQueries: ['funeral chamber'],
        predicates: [{ name: 'FUNERAL_CHAMBER_IN', confidence: 0.9 }],
        subqueries: ['Chaacmol funeral chamber'],
        mode: 'summary',
        strictness: 'soft',
      }),
    })

    expect(result.parser).toBe('llm')
    expect(result.intent.predicates).toEqual([])
    expect(result.rejectedPredicates).toEqual(['FUNERAL_CHAMBER_IN'])
    expectNoAnswerSide(result.intent)
  })
})
