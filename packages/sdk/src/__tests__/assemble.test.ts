import { describe, it, expect } from 'vitest'
import { assemble } from '../query/assemble.js'
import type { typegraphResult } from '../types/query.js'

function makeResult(overrides: Partial<typegraphResult> = {}): typegraphResult {
  return {
    content: 'Test passage content',
    score: 0.85,
    scores: { raw: { cosineSimilarity: 0.85 }, normalized: { semantic: 0.85 } },
    sources: ['semantic'],
    document: {
      id: 'doc-1',
      bucketId: 'src-1',
      title: 'Test Document',
      url: 'https://example.com/doc',
      updatedAt: new Date('2024-01-01'),
    },
    chunk: { index: 0, total: 1, isNeighbor: false },
    metadata: {},
    ...overrides,
  }
}

describe('assemble', () => {
  it('defaults to XML format with context/source/passage tags', () => {
    const results = [makeResult()]
    const output = assemble(results)
    expect(output).toContain('<context>')
    expect(output).toContain('</context>')
    expect(output).toContain('<source')
    expect(output).toContain('</source>')
    expect(output).toContain('<passage')
    expect(output).toContain('</passage>')
  })

  it('includes source attributes in XML', () => {
    const results = [makeResult()]
    const output = assemble(results)
    expect(output).toContain('id="src-1"')
    expect(output).toContain('title="Test Document"')
    expect(output).toContain('url="https://example.com/doc"')
  })

  it('includes score in XML passage', () => {
    const results = [makeResult({ score: 0.8500 })]
    const output = assemble(results)
    expect(output).toContain('score="0.8500"')
  })

  it('groups by bucket in XML', () => {
    const results = [
      makeResult({ content: 'A', document: { ...makeResult().document, bucketId: 'src-1' } }),
      makeResult({ content: 'B', document: { ...makeResult().document, bucketId: 'src-1' } }),
      makeResult({ content: 'C', document: { ...makeResult().document, bucketId: 'src-2', title: 'Other' } }),
    ]
    const output = assemble(results)
    // Should have two <source> blocks
    const sourceMatches = output.match(/<source /g)
    expect(sourceMatches).toHaveLength(2)
  })

  it('escapes XML special chars', () => {
    const results = [makeResult({
      content: 'Use <div> & "quotes"',
      document: { ...makeResult().document, title: 'A & B <C>' },
    })]
    const output = assemble(results)
    expect(output).toContain('&amp;')
    expect(output).toContain('&lt;')
    expect(output).toContain('&gt;')
    expect(output).toContain('&quot;')
  })

  it('assembles markdown format with headings and horizontal rules', () => {
    const results = [
      makeResult({ content: 'First' }),
      makeResult({ content: 'Second' }),
    ]
    const output = assemble(results, { format: 'markdown' })
    expect(output).toContain('# [Test Document]')
    expect(output).toContain('First')
    expect(output).toContain('---')
    expect(output).toContain('Second')
  })

  it('assembles markdown with linked title when url present', () => {
    const results = [makeResult({
      content: 'Content here',
      document: { ...makeResult().document, title: 'My Page', url: 'https://example.com' },
    })]
    const output = assemble(results, { format: 'markdown' })
    expect(output).toContain('# [My Page](https://example.com)')
  })

  it('assembles markdown with plain title when no url', () => {
    const results = [makeResult({
      content: 'Content here',
      document: { ...makeResult().document, title: 'FAQ Item', url: undefined },
    })]
    const output = assemble(results, { format: 'markdown' })
    expect(output).toContain('# FAQ Item')
    expect(output).not.toContain('[')
  })

  it('assembles plain format with double newlines', () => {
    const results = [
      makeResult({ content: 'First' }),
      makeResult({ content: 'Second' }),
    ]
    const output = assemble(results, { format: 'plain' })
    expect(output).toBe('First\n\nSecond')
  })

  it('supports custom format function', () => {
    const results = [makeResult({ content: 'Test' })]
    const output = assemble(results, { format: (r) => r.map(x => x.content.toUpperCase()).join(',') })
    expect(output).toBe('TEST')
  })
})
