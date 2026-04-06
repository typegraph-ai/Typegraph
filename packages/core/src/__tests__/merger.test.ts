import { describe, it, expect } from 'vitest'
import { dedupKey, minMaxNormalize, mergeAndRank, normalizeRRF, normalizePPR, type NormalizedResult } from '../query/merger.js'

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
  it('always uses content hash (64-char SHA256)', () => {
    const r = makeResult({ url: 'https://example.com/page', chunk: { index: 2, total: 5, isNeighbor: false } })
    const key = dedupKey(r)
    expect(key).toHaveLength(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same content produces same key regardless of documentId', () => {
    const a = makeResult({ content: 'hello world', documentId: 'doc-1' })
    const b = makeResult({ content: 'hello world', documentId: 'graph-0' })
    expect(dedupKey(a)).toBe(dedupKey(b))
  })

  it('different content produces different keys', () => {
    const a = makeResult({ content: 'content A' })
    const b = makeResult({ content: 'content B' })
    expect(dedupKey(a)).not.toBe(dedupKey(b))
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

describe('normalizeRRF', () => {
  it('normalizes rank-1 score from 1 list to ~1.0', () => {
    const raw = 1 / 61
    expect(normalizeRRF(raw, 1)).toBeCloseTo(1.0)
  })

  it('normalizes rank-1 score from 2 lists', () => {
    const raw = 2 / 61
    expect(normalizeRRF(raw, 2)).toBeCloseTo(1.0)
  })

  it('returns 0 for 0 lists', () => {
    expect(normalizeRRF(0.5, 0)).toBe(0)
  })

  it('caps at 1.0', () => {
    expect(normalizeRRF(1, 1)).toBeLessThanOrEqual(1)
  })

  it('lower ranks produce lower normalized scores', () => {
    const rank1 = normalizeRRF(1 / 61, 1)
    const rank5 = normalizeRRF(1 / 65, 1)
    expect(rank1).toBeGreaterThan(rank5)
  })
})

describe('normalizePPR', () => {
  it('normalizes PPR by dividing by damping factor', () => {
    // PPR of 0.35 (damping factor) → 1.0
    expect(normalizePPR(0.35, 0.35)).toBeCloseTo(1.0)
  })

  it('produces values between 0 and 1 for typical PPR scores', () => {
    // Typical PPR scores are 0.01-0.3
    expect(normalizePPR(0.1, 0.35)).toBeCloseTo(0.1 / 0.35)
    expect(normalizePPR(0.1, 0.35)).toBeGreaterThan(0)
    expect(normalizePPR(0.1, 0.35)).toBeLessThan(1)
  })

  it('caps at 1.0 for scores above damping factor', () => {
    expect(normalizePPR(0.5, 0.35)).toBe(1.0)
  })

  it('returns 0 for 0 damping factor', () => {
    expect(normalizePPR(0.1, 0)).toBe(0)
  })

  it('returns 0 for 0 PPR score', () => {
    expect(normalizePPR(0, 0.35)).toBe(0)
  })

  it('is cross-query comparable — same PPR score always produces same normalized value', () => {
    // Same raw PPR from different queries should produce identical normalized scores
    const query1Result = normalizePPR(0.15, 0.35)
    const query2Result = normalizePPR(0.15, 0.35)
    expect(query1Result).toBe(query2Result)
    expect(query1Result).toBeCloseTo(0.4286, 3)
  })
})

describe('mergeAndRank', () => {
  it('ranks by composite score', () => {
    const group1 = [
      makeResult({ content: 'A', normalizedScore: 0.9, rawScores: { vector: 0.9 } }),
      makeResult({ content: 'B', normalizedScore: 0.5, rawScores: { vector: 0.5 } }),
    ]
    const merged = mergeAndRank([group1], 10)
    expect(merged[0]!.content).toBe('A')
  })

  it('deduplicates by content', () => {
    const group1 = [makeResult({ content: 'same content', normalizedScore: 0.9, mode: 'indexed', rawScores: { vector: 0.8 } })]
    const group2 = [makeResult({ content: 'same content', normalizedScore: 0.8, mode: 'graph', documentId: 'graph-0', rawScores: { graph: 0.7 } })]
    const merged = mergeAndRank([group1, group2], 10)
    expect(merged).toHaveLength(1)
  })

  it('aggregates rawScores across runners', () => {
    const indexed = [makeResult({ content: 'shared', normalizedScore: 0.9, mode: 'indexed', rawScores: { vector: 0.8, keyword: 0.3 } })]
    const graph = [makeResult({ content: 'shared', normalizedScore: 0.7, mode: 'graph', documentId: 'graph-0', rawScores: { graph: 0.6 } })]
    const merged = mergeAndRank([indexed, graph], 10)
    expect(merged).toHaveLength(1)
    const result = merged[0]!
    expect(result.rawScores.vector).toBe(0.8)
    expect(result.rawScores.keyword).toBe(0.3)
    expect(result.rawScores.graph).toBe(0.6)
  })

  it('tracks modes from contributing runners', () => {
    const indexed = [makeResult({ content: 'shared', mode: 'indexed', rawScores: { vector: 0.8 } })]
    const graph = [makeResult({ content: 'shared', mode: 'graph', documentId: 'graph-0', rawScores: { graph: 0.6 } })]
    const merged = mergeAndRank([indexed, graph], 10)
    const result = merged[0] as any
    expect(result.modes).toContain('indexed')
    expect(result.modes).toContain('graph')
  })

  it('produces compositeScore in 0-1 range', () => {
    const group1 = [makeResult({ content: 'A', normalizedScore: 0.9, rawScores: { vector: 0.9 } })]
    const merged = mergeAndRank([group1], 10)
    const result = merged[0] as any
    expect(result.compositeScore).toBeGreaterThanOrEqual(0)
    expect(result.compositeScore).toBeLessThanOrEqual(1)
  })

  it('includes memory weight in composite score', () => {
    // Memory-only result should get composite > 0 due to memory weight
    const memResult = makeResult({ content: 'memory', mode: 'memory', normalizedScore: 0.95, rawScores: { memory: 0.95 } })
    const merged = mergeAndRank([[memResult]], 10)
    const result = merged[0] as any
    // 0.15 * 0.95 = 0.1425 (memory weight contribution)
    expect(result.compositeScore).toBeGreaterThan(0.1)
  })

  it('memory results influence ranking when merged with indexed', () => {
    // Two results: one with high memory, one without
    const highMemory = [makeResult({ content: 'remembered', mode: 'indexed', normalizedScore: 0.5, rawScores: { vector: 0.5 } })]
    const memoryRunner = [makeResult({ content: 'remembered', mode: 'memory', normalizedScore: 0.95, rawScores: { memory: 0.95 } })]
    const noMemory = [makeResult({ content: 'forgotten', mode: 'indexed', normalizedScore: 0.5, rawScores: { vector: 0.5 } })]

    const merged = mergeAndRank([highMemory, memoryRunner, noMemory], 10)
    const rememberedResult = merged.find(r => r.content === 'remembered') as any
    const forgottenResult = merged.find(r => r.content === 'forgotten') as any

    // Result with memory contribution should score higher
    expect(rememberedResult.compositeScore).toBeGreaterThan(forgottenResult.compositeScore)
  })

  it('respects count', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ content: `content-${i}`, normalizedScore: i / 20, rawScores: { vector: i / 20 } })
    )
    const merged = mergeAndRank([results], 5)
    expect(merged).toHaveLength(5)
  })

  it('applies mode weights', () => {
    const indexed = [makeResult({ content: 'a', mode: 'indexed', normalizedScore: 0.5, rawScores: { vector: 0.5 } })]
    const live = [makeResult({ content: 'b', mode: 'live', normalizedScore: 0.5, rawScores: { vector: 0.5 } })]
    const merged = mergeAndRank([indexed, live], 10)
    expect(merged[0]!.content).toBe('a')
  })

  it('accepts custom weights', () => {
    const indexed = [makeResult({ content: 'a', mode: 'indexed', normalizedScore: 0.5, rawScores: { vector: 0.5 } })]
    const live = [makeResult({ content: 'b', mode: 'live', normalizedScore: 0.5, rawScores: { vector: 0.5 } })]
    const merged = mergeAndRank([indexed, live], 10, { indexed: 0.1, live: 0.9 })
    expect(merged[0]!.content).toBe('b')
  })

  it('handles empty input', () => {
    expect(mergeAndRank([], 10)).toEqual([])
    expect(mergeAndRank([[]], 10)).toEqual([])
  })

  it('merges multiple runner groups', () => {
    const group1 = [makeResult({ content: 'a', normalizedScore: 0.9, rawScores: { vector: 0.9 } })]
    const group2 = [makeResult({ content: 'b', normalizedScore: 0.8, rawScores: { vector: 0.8 } })]
    const group3 = [makeResult({ content: 'c', normalizedScore: 0.7, rawScores: { vector: 0.7 } })]
    const merged = mergeAndRank([group1, group2, group3], 10)
    expect(merged).toHaveLength(3)
  })

  it('cross-runner dedup: indexed + graph with same content → 1 result with both scores', () => {
    const indexed = [makeResult({
      content: 'Golden State Warriors are awesome',
      documentId: 'doc-123',
      mode: 'indexed',
      normalizedScore: 0.8,
      rawScores: { vector: 0.75, keyword: 0.4 },
      chunk: { index: 0, total: 1, isNeighbor: false },
    })]
    const graph = [makeResult({
      content: 'Golden State Warriors are awesome',
      documentId: 'graph-0',
      mode: 'graph',
      normalizedScore: 0.15,
      rawScores: { graph: 0.15 },
    })]
    const merged = mergeAndRank([indexed, graph], 10)
    expect(merged).toHaveLength(1)
    const result = merged[0]!
    expect(result.rawScores.vector).toBe(0.75)
    expect(result.rawScores.keyword).toBe(0.4)
    expect(result.rawScores.graph).toBe(0.15)
  })

  it('normalizes graph PPR scores in composite via normalizePPR', () => {
    // Raw PPR 0.175 → normalized 0.175/0.35 = 0.5
    const graphResult = makeResult({
      content: 'graph only',
      mode: 'graph',
      normalizedScore: 0.175,
      rawScores: { graph: 0.175 },
    })
    const merged = mergeAndRank([[graphResult]], 10)
    const result = merged[0] as any
    // composite = 0.25*nRRF + 0.35*0 + 0.1*0 + 0.15*normalizePPR(0.175) + 0.15*0
    // normalizePPR(0.175) = 0.5
    // graph contribution = 0.15 * 0.5 = 0.075
    expect(result.compositeScore).toBeGreaterThan(0)
  })
})
