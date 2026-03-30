import { describe, it, expect } from 'vitest'
import { dedupKey, minMaxNormalize, mergeAndRank, type NormalizedResult } from '../query/merger.js'

function makeResult(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    content: 'Test content',
    bucketId: 'src-1',
    documentId: 'doc-1',
    rawScores: { vector: 0.9 },
    normalizedScore: 0.9,
    mode: 'indexed',
    metadata: {},
    ...overrides,
  }
}

describe('dedupKey', () => {
  it('uses url when available', () => {
    const r = makeResult({ url: 'https://example.com/page' })
    expect(dedupKey(r)).toBe('https://example.com/page')
  })

  it('uses content hash when no url (enables cross-runner dedup)', () => {
    const r = makeResult({ url: undefined, documentId: 'doc-1', chunk: { index: 2, total: 5, isNeighbor: false } })
    const key = dedupKey(r)
    expect(key).toHaveLength(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same content from different runners produces same key', () => {
    const indexed = makeResult({ url: undefined, content: 'shared chunk', documentId: 'doc-1', chunk: { index: 0, total: 1, isNeighbor: false }, mode: 'indexed' })
    const graph = makeResult({ url: undefined, content: 'shared chunk', documentId: 'graph-0', chunk: undefined, mode: 'graph' })
    expect(dedupKey(indexed)).toBe(dedupKey(graph))
  })

})

describe('minMaxNormalize', () => {
  it('normalizes scores to [0,1]', () => {
    const results = [
      makeResult({ normalizedScore: 10 }),
      makeResult({ normalizedScore: 20 }),
      makeResult({ normalizedScore: 30 }),
    ]
    const normalized = minMaxNormalize(results)
    expect(normalized[0]!.normalizedScore).toBeCloseTo(0)
    expect(normalized[1]!.normalizedScore).toBeCloseTo(0.5)
    expect(normalized[2]!.normalizedScore).toBeCloseTo(1)
  })

  it('returns all 1s when all scores are equal', () => {
    const results = [
      makeResult({ normalizedScore: 5 }),
      makeResult({ normalizedScore: 5 }),
    ]
    const normalized = minMaxNormalize(results)
    expect(normalized.every(r => r.normalizedScore === 1)).toBe(true)
  })

  it('handles empty array', () => {
    expect(minMaxNormalize([])).toEqual([])
  })

  it('handles single result', () => {
    const results = [makeResult({ normalizedScore: 7 })]
    const normalized = minMaxNormalize(results)
    expect(normalized[0]!.normalizedScore).toBe(1)
  })
})

describe('mergeAndRank', () => {
  it('ranks by RRF', () => {
    const group1 = [
      makeResult({ content: 'A', normalizedScore: 0.9, url: 'a' }),
      makeResult({ content: 'B', normalizedScore: 0.5, url: 'b' }),
    ]
    const merged = mergeAndRank([group1], 10)
    expect(merged[0]!.content).toBe('A')
  })

  it('deduplicates by url', () => {
    const group1 = [makeResult({ url: 'same', normalizedScore: 0.9 })]
    const group2 = [makeResult({ url: 'same', normalizedScore: 0.8 })]
    const merged = mergeAndRank([group1, group2], 10)
    expect(merged).toHaveLength(1)
  })

  it('respects count', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ url: `url-${i}`, normalizedScore: i / 20 })
    )
    const merged = mergeAndRank([results], 5)
    expect(merged).toHaveLength(5)
  })

  it('applies mode weights', () => {
    const indexed = [makeResult({ url: 'a', mode: 'indexed', normalizedScore: 0.5 })]
    const live = [makeResult({ url: 'b', mode: 'live', normalizedScore: 0.5 })]
    const merged = mergeAndRank([indexed, live], 10)
    // Indexed has higher default weight (0.7) than live (0.2)
    const indexedResult = merged.find(r => r.url === 'a')!
    const liveResult = merged.find(r => r.url === 'b')!
    // With same rank position but different weights, indexed should score higher
    expect(merged[0]!.url).toBe('a')
  })

  it('accepts custom weights', () => {
    const indexed = [makeResult({ url: 'a', mode: 'indexed', normalizedScore: 0.5 })]
    const live = [makeResult({ url: 'b', mode: 'live', normalizedScore: 0.5 })]
    // Give live higher weight
    const merged = mergeAndRank([indexed, live], 10, { indexed: 0.1, live: 0.9 })
    expect(merged[0]!.url).toBe('b')
  })

  it('handles empty input', () => {
    expect(mergeAndRank([], 10)).toEqual([])
    expect(mergeAndRank([[]], 10)).toEqual([])
  })

  it('merges multiple runner groups', () => {
    const group1 = [makeResult({ url: 'a', normalizedScore: 0.9 })]
    const group2 = [makeResult({ url: 'b', normalizedScore: 0.8 })]
    const group3 = [makeResult({ url: 'c', normalizedScore: 0.7 })]
    const merged = mergeAndRank([group1, group2, group3], 10)
    expect(merged).toHaveLength(3)
  })
})
