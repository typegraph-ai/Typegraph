import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../query/assemble.js'
import type { QueryChunkResult, QueryResults } from '../types/query.js'

function makeChunk(overrides: Partial<QueryChunkResult> = {}): QueryChunkResult {
  return {
    content: 'Maud is a poem by Alfred Tennyson.',
    score: 0.9123,
    scores: { raw: { cosineSimilarity: 0.9123 }, normalized: { semantic: 0.9123 } },
    matchedBy: ['semantic'],
    document: {
      id: 'source-1',
      bucketId: 'books',
      name: 'Maud',
      url: 'https://example.com/maud',
      updatedAt: new Date('2024-01-01'),
    },
    chunk: { index: 0, total: 4 },
    metadata: { document: 'gutenberg', tags: ['poetry', 'victorian'] },
    ...overrides,
  }
}

function makeResults(chunks: QueryChunkResult[] = [makeChunk()], overrides: Partial<QueryResults> = {}): QueryResults {
  return {
    chunks,
    facts: [],
    entities: [],
    ...overrides,
  }
}

describe('buildPrompt', () => {
  it('defaults to XML with context section and numbered chunk tags', () => {
    const built = buildPrompt(makeResults())

    expect(built.prompt).toContain('<context>')
    expect(built.prompt).toContain('<context_chunks>')
    expect(built.prompt).toContain('<context_chunk_1>')
    expect(built.prompt).toContain('Maud is a poem by Alfred Tennyson.')
    expect(built.prompt).not.toContain('score=')
    expect(built.stats.format).toBe('xml')
    expect(built.stats.sections.chunks?.included).toBe(1)
  })

  it('renders XML attributes and nested readable metadata when requested', () => {
    const built = buildPrompt(makeResults(), {
      format: 'xml',
      includeAttributes: true,
      sections: ['chunks'],
    })

    expect(built.prompt).toContain('score="0.9123"')
    expect(built.prompt).toContain('bucketId="books"')
    expect(built.prompt).toContain('url="https://example.com/maud"')
    expect(built.prompt).toContain('<context_chunk_1_metadata>{"document":"gutenberg","tags":["poetry","victorian"]}</context_chunk_1_metadata>')
    expect(built.prompt).toContain('<context_chunk_1_content>Maud is a poem by Alfred Tennyson.</context_chunk_1_content>')
    expect(built.prompt).not.toContain('metadata=')
    expect(built.prompt).not.toContain('&quot;source&quot;')
  })

  it('renders markdown with context headings and XML-like content wrappers', () => {
    const built = buildPrompt(makeResults([], {
      chunks: [makeChunk()],
      facts: [{
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'ent-1',
        sourceEntityName: 'Alfred Tennyson',
        targetEntityId: 'ent-2',
        targetEntityName: 'Maud',
        relation: 'AUTHORED',
        description: 'Alfred Tennyson wrote Maud.',
        weight: 1,      }],
    }), {
      format: 'markdown',
      sections: ['chunks', 'facts'],
      includeAttributes: true,
    })

    expect(built.prompt).toContain('# Context')
    expect(built.prompt).toContain('## Context Chunks')
    expect(built.prompt).toContain('### Context Chunk 1')
    expect(built.prompt).toContain('metadata: {"document":"gutenberg","tags":["poetry","victorian"]}')
    expect(built.prompt).toContain('<context_chunk_1>\nMaud is a poem by Alfred Tennyson.\n</context_chunk_1>')
    expect(built.prompt).toContain('## Context Facts')
    expect(built.prompt).toContain('relation: AUTHORED')
    expect(built.prompt).toContain('<context_fact_1>\nAlfred Tennyson wrote Maud.\n</context_fact_1>')
  })

  it('omits facts when the facts section is not requested', () => {
    const built = buildPrompt(makeResults([makeChunk()], {
      facts: [{
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'ent-1',
        targetEntityId: 'ent-2',
        relation: 'AUTHORED',
        description: 'Alfred Tennyson wrote Maud.',
        weight: 1,      }],
    }), {
      format: 'markdown',
      sections: ['chunks'],
    })

    expect(built.prompt).toContain('## Context Chunks')
    expect(built.prompt).not.toContain('## Context Facts')
    expect(built.prompt).not.toContain('Alfred Tennyson wrote Maud.')
  })

  it('applies per-section token budgets and reports truncation stats', () => {
    const built = buildPrompt(makeResults([], {
      facts: [
        {
          id: 'fact-1',
          edgeId: 'edge-1',
          sourceEntityId: 'ent-1',
          targetEntityId: 'ent-2',
          relation: 'FIRST',
          description: 'First fact.',
          weight: 1,        },
        {
          id: 'fact-2',
          edgeId: 'edge-2',
          sourceEntityId: 'ent-1',
          targetEntityId: 'ent-3',
          relation: 'SECOND',
          description: 'Second fact.',
          weight: 1,        },
      ],
    }), {
      format: 'plain',
      sections: ['facts'],
      maxFactTokens: 5,
    }, text => text.includes('Second fact') ? 10 : 1)

    expect(built.prompt).toContain('First fact.')
    expect(built.prompt).not.toContain('Second fact.')
    expect(built.stats.sections.facts?.available).toBe(2)
    expect(built.stats.sections.facts?.included).toBe(1)
    expect(built.stats.sections.facts?.truncated).toBe(true)
  })
})
