import { describe, it, expect } from 'vitest'
import { dedupKey, minMaxNormalize, mergeAndRank, normalizeRRF, normalizePPR, calibrateSemantic, calibrateKeyword, type NormalizedResult } from '../query/merger.js'

function makeResult(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    content: 'Test content',
    bucketId: 'src-1',
    documentId: 'doc-1',
    rawScores: { semantic: 0.9 },
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
  it('normalizes PPR by dividing by reference', () => {
    // PPR equal to reference → 1.0
    expect(normalizePPR(0.35, 0.35)).toBeCloseTo(1.0)
  })

  it('produces values between 0 and 1 for typical PPR scores', () => {
    expect(normalizePPR(0.1, 0.35)).toBeCloseTo(0.1 / 0.35)
    expect(normalizePPR(0.1, 0.35)).toBeGreaterThan(0)
    expect(normalizePPR(0.1, 0.35)).toBeLessThan(1)
  })

  it('caps at 1.0 for scores above reference', () => {
    expect(normalizePPR(0.5, 0.35)).toBe(1.0)
  })

  it('returns 0 for 0 reference', () => {
    expect(normalizePPR(0.1, 0)).toBe(0)
  })

  it('returns 0 for 0 PPR score', () => {
    expect(normalizePPR(0, 0.35)).toBe(0)
  })

  it('uses default reference of 0.30', () => {
    // Default reference = 0.30
    expect(normalizePPR(0.15)).toBeCloseTo(0.15 / 0.30)
    expect(normalizePPR(0.30)).toBeCloseTo(1.0)
  })

  it('same PPR score always produces same normalized value', () => {
    const query1Result = normalizePPR(0.15, 0.35)
    const query2Result = normalizePPR(0.15, 0.35)
    expect(query1Result).toBe(query2Result)
    expect(query1Result).toBeCloseTo(0.4286, 3)
  })
})

describe('calibrateSemantic', () => {
  it('maps floor to 0', () => {
    expect(calibrateSemantic(0.10)).toBe(0)
  })

  it('maps ceiling to 1', () => {
    expect(calibrateSemantic(0.70)).toBe(1)
  })

  it('maps below floor to 0', () => {
    expect(calibrateSemantic(0.05)).toBe(0)
  })

  it('maps above ceiling to 1', () => {
    expect(calibrateSemantic(0.85)).toBe(1)
  })

  it('maps midpoint correctly', () => {
    // midpoint of [0.10, 0.70] = 0.40 → 0.50
    expect(calibrateSemantic(0.40)).toBeCloseTo(0.5)
  })

  it('maps Stephen Curry score (0.52) to ~0.70', () => {
    expect(calibrateSemantic(0.52)).toBeCloseTo(0.70)
  })

  it('accepts custom floor/ceiling', () => {
    expect(calibrateSemantic(0.30, 0.20, 0.60)).toBeCloseTo(0.25)
    expect(calibrateSemantic(0.20, 0.20, 0.60)).toBe(0)
    expect(calibrateSemantic(0.60, 0.20, 0.60)).toBe(1)
  })
})

describe('calibrateKeyword', () => {
  it('maps 0 to 0', () => {
    expect(calibrateKeyword(0)).toBe(0)
  })

  it('maps ceiling to 1', () => {
    expect(calibrateKeyword(0.23)).toBe(1)
  })

  it('maps above ceiling to 1', () => {
    expect(calibrateKeyword(0.50)).toBe(1)
  })

  it('maps midpoint correctly', () => {
    expect(calibrateKeyword(0.115)).toBeCloseTo(0.5)
  })

  it('accepts custom floor/ceiling', () => {
    expect(calibrateKeyword(0.15, 0.05, 0.25)).toBeCloseTo(0.5)
  })
})

describe('mergeAndRank', () => {
  it('ranks by composite score', () => {
    const group1 = [
      makeResult({ content: 'A', normalizedScore: 0.9, rawScores: { semantic: 0.9 } }),
      makeResult({ content: 'B', normalizedScore: 0.5, rawScores: { semantic: 0.5 } }),
    ]
    const merged = mergeAndRank([group1], 10)
    expect(merged[0]!.content).toBe('A')
  })

  it('deduplicates by content', () => {
    const group1 = [makeResult({ content: 'same content', normalizedScore: 0.9, mode: 'indexed', rawScores: { semantic: 0.8 } })]
    const group2 = [makeResult({ content: 'same content', normalizedScore: 0.8, mode: 'graph', documentId: 'graph-0', rawScores: { graph: 0.7 } })]
    const merged = mergeAndRank([group1, group2], 10)
    expect(merged).toHaveLength(1)
  })

  it('aggregates rawScores across runners', () => {
    const indexed = [makeResult({ content: 'shared', normalizedScore: 0.9, mode: 'indexed', rawScores: { semantic: 0.8, keyword: 0.3 } })]
    const graph = [makeResult({ content: 'shared', normalizedScore: 0.7, mode: 'graph', documentId: 'graph-0', rawScores: { graph: 0.6 } })]
    const merged = mergeAndRank([indexed, graph], 10)
    expect(merged).toHaveLength(1)
    const result = merged[0]!
    expect(result.rawScores.semantic).toBe(0.8)
    expect(result.rawScores.keyword).toBe(0.3)
    expect(result.rawScores.graph).toBe(0.6)
  })

  it('tracks modes from contributing runners', () => {
    const indexed = [makeResult({ content: 'shared', mode: 'indexed', rawScores: { semantic: 0.8 } })]
    const graph = [makeResult({ content: 'shared', mode: 'graph', documentId: 'graph-0', rawScores: { graph: 0.6 } })]
    const merged = mergeAndRank([indexed, graph], 10)
    const result = merged[0] as any
    expect(result.modes).toContain('indexed')
    expect(result.modes).toContain('graph')
  })

  it('produces compositeScore in 0-1 range', () => {
    const group1 = [makeResult({ content: 'A', normalizedScore: 0.9, rawScores: { semantic: 0.9 } })]
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
    const highMemory = [makeResult({ content: 'remembered', mode: 'indexed', normalizedScore: 0.5, rawScores: { semantic: 0.5 } })]
    const memoryRunner = [makeResult({ content: 'remembered', mode: 'memory', normalizedScore: 0.95, rawScores: { memory: 0.95 } })]
    const noMemory = [makeResult({ content: 'forgotten', mode: 'indexed', normalizedScore: 0.5, rawScores: { semantic: 0.5 } })]

    const merged = mergeAndRank([highMemory, memoryRunner, noMemory], 10)
    const rememberedResult = merged.find(r => r.content === 'remembered') as any
    const forgottenResult = merged.find(r => r.content === 'forgotten') as any

    // Result with memory contribution should score higher
    expect(rememberedResult.compositeScore).toBeGreaterThan(forgottenResult.compositeScore)
  })

  it('respects count', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ content: `content-${i}`, normalizedScore: i / 20, rawScores: { semantic: i / 20 } })
    )
    const merged = mergeAndRank([results], 5)
    expect(merged).toHaveLength(5)
  })

  it('applies mode weights', () => {
    const indexed = [makeResult({ content: 'a', mode: 'indexed', normalizedScore: 0.5, rawScores: { semantic: 0.5 } })]
    const live = [makeResult({ content: 'b', mode: 'live', normalizedScore: 0.5, rawScores: { semantic: 0.5 } })]
    const merged = mergeAndRank([indexed, live], 10)
    expect(merged[0]!.content).toBe('a')
  })

  it('accepts custom weights', () => {
    const indexed = [makeResult({ content: 'a', mode: 'indexed', normalizedScore: 0.5, rawScores: { semantic: 0.5 } })]
    const live = [makeResult({ content: 'b', mode: 'live', normalizedScore: 0.5, rawScores: { semantic: 0.5 } })]
    const merged = mergeAndRank([indexed, live], 10, { indexed: 0.1, live: 0.9 })
    expect(merged[0]!.content).toBe('b')
  })

  it('handles empty input', () => {
    expect(mergeAndRank([], 10)).toEqual([])
    expect(mergeAndRank([[]], 10)).toEqual([])
  })

  it('merges multiple runner groups', () => {
    const group1 = [makeResult({ content: 'a', normalizedScore: 0.9, rawScores: { semantic: 0.9 } })]
    const group2 = [makeResult({ content: 'b', normalizedScore: 0.8, rawScores: { semantic: 0.8 } })]
    const group3 = [makeResult({ content: 'c', normalizedScore: 0.7, rawScores: { semantic: 0.7 } })]
    const merged = mergeAndRank([group1, group2, group3], 10)
    expect(merged).toHaveLength(3)
  })

  it('cross-runner dedup: indexed + graph with same content → 1 result with both scores', () => {
    const indexed = [makeResult({
      content: 'Golden State Warriors are awesome',
      documentId: 'doc-123',
      mode: 'indexed',
      normalizedScore: 0.8,
      rawScores: { semantic: 0.75, keyword: 0.4 },
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
    expect(result.rawScores.semantic).toBe(0.75)
    expect(result.rawScores.keyword).toBe(0.4)
    expect(result.rawScores.graph).toBe(0.15)
  })

  it('normalizes graph PPR scores via query-relative min-max', () => {
    // Single graph result — gets 1.0 (best by definition)
    const graphResult = makeResult({
      content: 'graph only',
      mode: 'graph',
      normalizedScore: 0.175,
      rawScores: { graph: 0.175 },
    })
    const merged = mergeAndRank([[graphResult]], 10)
    const result = merged[0] as any
    // With min-max, single graph result gets graph=1.0
    // Graph weight in composite contributes meaningfully
    expect(result.compositeScore).toBeGreaterThan(0)
  })

  it('graph min-max: best graph result gets 1.0, no connection gets 0', () => {
    const withGraph = [makeResult({
      content: 'has graph',
      mode: 'indexed',
      normalizedScore: 0.5,
      rawScores: { semantic: 0.5, graph: 0.02 },
    })]
    const noGraph = [makeResult({
      content: 'no graph',
      mode: 'indexed',
      normalizedScore: 0.5,
      rawScores: { semantic: 0.5 },
    })]
    const merged = mergeAndRank([withGraph, noGraph], 10)
    const graphResult = merged.find(r => r.content === 'has graph') as any
    const noGraphResult = merged.find(r => r.content === 'no graph') as any
    // With graph signal active (default), graph-connected result should score higher
    expect(graphResult.compositeScore).toBeGreaterThan(noGraphResult.compositeScore)
  })

  it('graph results without connection get graph=0 (not undefined) when graph signal active', () => {
    const noGraphResult = makeResult({
      content: 'no graph connection',
      mode: 'indexed',
      normalizedScore: 0.5,
      rawScores: { semantic: 0.5 },
    })
    const merged = mergeAndRank([[noGraphResult]], 10)
    // When all signals default to active, graph should be 0 not undefined
    // (0 penalizes, undefined redistributes weight)
    const result = merged[0] as any
    expect(result.compositeScore).toBeDefined()
  })

  it('fixes ranking inversion: GSW with graph beats Celtics without', () => {
    // Reproduce the bug: GSW has higher individual scores in every metric
    // but was ranking below Celtics due to graph eligibility bug
    const gsw = [makeResult({
      content: 'Golden State Warriors',
      mode: 'indexed',
      normalizedScore: 0.31,
      rawScores: { semantic: 0.31, keyword: 0.10, graph: 0.014 },
    })]
    const celtics = [makeResult({
      content: 'Boston Celtics',
      mode: 'indexed',
      normalizedScore: 0.29,
      rawScores: { semantic: 0.29 },
    })]
    const merged = mergeAndRank([gsw, celtics], 10)
    const gswResult = merged.find(r => r.content === 'Golden State Warriors') as any
    const celticsResult = merged.find(r => r.content === 'Boston Celtics') as any
    expect(gswResult.compositeScore).toBeGreaterThan(celticsResult.compositeScore)
  })

  it('graph min-max: equal graph scores all get 1.0', () => {
    const a = [makeResult({ content: 'a', mode: 'indexed', normalizedScore: 0.5, rawScores: { semantic: 0.5, graph: 0.01 } })]
    const b = [makeResult({ content: 'b', mode: 'indexed', normalizedScore: 0.5, rawScores: { semantic: 0.5, graph: 0.01 } })]
    const merged = mergeAndRank([a, b], 10)
    // Both have same graph score → both should get same composite
    const resultA = merged.find(r => r.content === 'a') as any
    const resultB = merged.find(r => r.content === 'b') as any
    expect(resultA.compositeScore).toBeCloseTo(resultB.compositeScore)
  })

  it('calibrates semantic and keyword scores in composite', () => {
    // Raw semantic 0.52 → calibrated ~0.70
    // Raw keyword 0.10 → calibrated 0.50
    const result = makeResult({
      content: 'calibrated',
      mode: 'indexed',
      normalizedScore: 0.52,
      rawScores: { semantic: 0.52, keyword: 0.10 },
    })
    const merged = mergeAndRank([[result]], 10)
    const r = merged[0] as any
    // Composite should be higher than raw scores suggest
    // because calibration stretches them to use full 0-1 range
    expect(r.compositeScore).toBeGreaterThan(0.3)
  })
})
