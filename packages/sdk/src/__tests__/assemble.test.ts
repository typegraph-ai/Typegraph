import { describe, it, expect } from 'vitest'
import { buildContext } from '../query/assemble.js'
import type { QueryChunkResult, QueryResults } from '../types/query.js'

function makeChunk(overrides: Partial<QueryChunkResult> = {}): QueryChunkResult {
  return {
    content: 'Maud is a poem by Alfred Tennyson.',
    score: 0.9123,
    scores: { raw: { cosineSimilarity: 0.9123 }, normalized: { semantic: 0.9123 } },
    sources: ['semantic'],
    document: {
      id: 'doc-1',
      bucketId: 'books',
      title: 'Maud',
      url: 'https://example.com/maud',
      updatedAt: new Date('2024-01-01'),
    },
    chunk: { index: 0, total: 4 },
    metadata: { source: 'gutenberg', tags: ['poetry', 'victorian'] },
    ...overrides,
  }
}

function makeResults(chunks: QueryChunkResult[] = [makeChunk()], overrides: Partial<QueryResults> = {}): QueryResults {
  return {
    chunks,
    facts: [],
    entities: [],
    memories: [],
    ...overrides,
  }
}

describe('buildContext', () => {
  it('defaults to XML with context section and numbered chunk tags', () => {
    const built = buildContext(makeResults())

    expect(built.context).toContain('<context>')
    expect(built.context).toContain('<context_chunks>')
    expect(built.context).toContain('<context_chunk_1>')
    expect(built.context).toContain('Maud is a poem by Alfred Tennyson.')
    expect(built.context).not.toContain('score=')
    expect(built.stats.format).toBe('xml')
    expect(built.stats.sections.chunks?.included).toBe(1)
  })

  it('renders XML attributes and nested readable metadata when requested', () => {
    const built = buildContext(makeResults(), {
      format: 'xml',
      includeAttributes: true,
      sections: ['chunks'],
    })

    expect(built.context).toContain('score="0.9123"')
    expect(built.context).toContain('bucketId="books"')
    expect(built.context).toContain('url="https://example.com/maud"')
    expect(built.context).toContain('<context_chunk_1_metadata>{"source":"gutenberg","tags":["poetry","victorian"]}</context_chunk_1_metadata>')
    expect(built.context).toContain('<context_chunk_1_content>Maud is a poem by Alfred Tennyson.</context_chunk_1_content>')
    expect(built.context).not.toContain('metadata=')
    expect(built.context).not.toContain('&quot;source&quot;')
  })

  it('renders markdown with context headings and XML-like content wrappers', () => {
    const built = buildContext(makeResults([], {
      chunks: [makeChunk()],
      facts: [{
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'ent-1',
        sourceEntityName: 'Alfred Tennyson',
        targetEntityId: 'ent-2',
        targetEntityName: 'Maud',
        relation: 'AUTHORED',
        factText: 'Alfred Tennyson wrote Maud.',
        weight: 1,
        evidenceCount: 2,
      }],
    }), {
      format: 'markdown',
      sections: ['chunks', 'facts'],
      includeAttributes: true,
    })

    expect(built.context).toContain('# Context')
    expect(built.context).toContain('## Context Chunks')
    expect(built.context).toContain('### Context Chunk 1')
    expect(built.context).toContain('metadata: {"source":"gutenberg","tags":["poetry","victorian"]}')
    expect(built.context).toContain('<context_chunk_1>\nMaud is a poem by Alfred Tennyson.\n</context_chunk_1>')
    expect(built.context).toContain('## Context Facts')
    expect(built.context).toContain('relation: AUTHORED')
    expect(built.context).toContain('<context_fact_1>\nAlfred Tennyson wrote Maud.\n</context_fact_1>')
  })

  it('omits facts when the facts section is not requested', () => {
    const built = buildContext(makeResults([makeChunk()], {
      facts: [{
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'ent-1',
        targetEntityId: 'ent-2',
        relation: 'AUTHORED',
        factText: 'Alfred Tennyson wrote Maud.',
        weight: 1,
        evidenceCount: 2,
      }],
    }), {
      format: 'markdown',
      sections: ['chunks'],
    })

    expect(built.context).toContain('## Context Chunks')
    expect(built.context).not.toContain('## Context Facts')
    expect(built.context).not.toContain('Alfred Tennyson wrote Maud.')
  })

  it('applies per-section token budgets and reports truncation stats', () => {
    const built = buildContext(makeResults([], {
      facts: [
        {
          id: 'fact-1',
          edgeId: 'edge-1',
          sourceEntityId: 'ent-1',
          targetEntityId: 'ent-2',
          relation: 'FIRST',
          factText: 'First fact.',
          weight: 1,
          evidenceCount: 1,
        },
        {
          id: 'fact-2',
          edgeId: 'edge-2',
          sourceEntityId: 'ent-1',
          targetEntityId: 'ent-3',
          relation: 'SECOND',
          factText: 'Second fact.',
          weight: 1,
          evidenceCount: 1,
        },
      ],
    }), {
      format: 'plain',
      sections: ['facts'],
      maxFactTokens: 5,
    }, text => text.includes('Second fact') ? 10 : 1)

    expect(built.context).toContain('First fact.')
    expect(built.context).not.toContain('Second fact.')
    expect(built.stats.sections.facts?.available).toBe(2)
    expect(built.stats.sections.facts?.included).toBe(1)
    expect(built.stats.sections.facts?.truncated).toBe(true)
  })
})
