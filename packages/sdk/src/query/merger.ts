import { createHash } from 'crypto'
import type { QuerySignals, NormalizedScores } from '../types/query.js'
import { computeCompositeScore } from './planner.js'

export interface NormalizedResult {
  content: string
  bucketId: string
  documentId: string
  rawScores: { semantic?: number | undefined; keyword?: number | undefined; rrf?: number | undefined; liveRelevance?: number | undefined; memory?: number | undefined; graph?: number | undefined; memorySimilarity?: number | undefined; memoryImportance?: number | undefined; memoryRecency?: number | undefined }
  normalizedScore: number
  mode: 'indexed' | 'live' | 'cached' | 'memory' | 'graph'
  metadata: Record<string, unknown>
  chunk?: { index: number; total: number; isNeighbor: boolean } | undefined
  url?: string | undefined
  title?: string | undefined
  updatedAt?: Date | undefined
  tenantId?: string | undefined
  // Document-level fields (populated when searchWithDocuments is used)
  documentStatus?: string | undefined
  documentVisibility?: string | undefined
  documentType?: string | undefined
  sourceType?: string | undefined
  userId?: string | undefined
  groupId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
}

/** Content-based dedup key. Uses SHA256 hash of content to ensure cross-runner dedup works
 *  (e.g. graph runner assigns synthetic documentIds like `graph-0` that won't match indexed results). */
export function dedupKey(r: NormalizedResult): string {
  return createHash('sha256').update(r.content).digest('hex')
}

export function minMaxNormalize(results: NormalizedResult[]): NormalizedResult[] {
  if (results.length === 0) return results
  const scores = results.map(r => r.normalizedScore)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  if (max === min) return results.map(r => ({ ...r, normalizedScore: 1 }))
  return results.map(r => ({
    ...r,
    normalizedScore: (r.normalizedScore - min) / (max - min),
  }))
}

/** Normalize a raw RRF score to 0-1 by dividing by its theoretical maximum.
 *  theoreticalMax = numLists / (k + 1) where k=60 for standard RRF. */
export function normalizeRRF(rrfScore: number, numLists: number, k = 60): number {
  const theoreticalMax = numLists / (k + 1)
  return theoreticalMax > 0 ? Math.min(rrfScore / theoreticalMax, 1) : 0
}

/** Normalize a raw PPR score to 0-1 by dividing by a reference value.
 *  Kept for backward compatibility — composite scoring now uses query-relative
 *  min-max normalization instead. This function is still exported for tests
 *  and any direct consumers. */
export function normalizePPR(pprScore: number, reference = 0.30): number {
  if (reference <= 0) return 0
  return Math.min(pprScore / reference, 1.0)
}

/** Calibrate raw cosine similarity to a 0-1 relevance scale.
 *  Rescales the practical range of the embedding model to use the full 0-1 range.
 *  Default floor/ceiling tuned for text-embedding-3-small. */
export function calibrateSemantic(cosine: number, floor = 0.10, ceiling = 0.70): number {
  if (cosine <= floor) return 0
  if (cosine >= ceiling) return 1
  return (cosine - floor) / (ceiling - floor)
}

/** Calibrate raw ts_rank() BM25 score to 0-1.
 *  ts_rank() produces values typically in [0, 0.5] range.
 *  Static ceiling normalization ensures consistent 0-1 scale across queries. */
export function calibrateKeyword(score: number, floor = 0, ceiling = 0.23): number {
  if (score <= floor) return 0
  if (score >= ceiling) return 1
  return (score - floor) / (ceiling - floor)
}

/** Default RRF weights by internal runner mode. */
const DEFAULT_RRF_WEIGHTS: Record<string, number> = {
  indexed: 0.5,
  live: 0.1,
  cached: 0.1,
  memory: 0.2,
  graph: 0.15,
}

/** Derive RRF weights from user's score weights.
 *  Maps score categories to runner modes proportionally. */
function deriveRRFWeights(scoreWeights?: Partial<Record<string, number>>): Record<string, number> {
  if (!scoreWeights || Object.keys(scoreWeights).length === 0) return DEFAULT_RRF_WEIGHTS
  return {
    indexed: (scoreWeights.semantic ?? 0.5) + (scoreWeights.keyword ?? 0),
    memory: scoreWeights.memory ?? 0.2,
    graph: scoreWeights.graph ?? 0.15,
    live: 0.1,
    cached: 0.1,
  }
}

export function mergeAndRank(
  runnerResults: NormalizedResult[][],
  count: number,
  weights?: Record<string, number>,
  signals?: Required<QuerySignals>,
  scoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>
): NormalizedResult[] {
  const numLists = runnerResults.length
  const rrfWeights = weights ?? deriveRRFWeights(scoreWeights)

  // Compute theoretical max RRF from actual runner weights (not numLists which assumes weight=1).
  // Each runner's weight comes from the mode of its first result.
  const k = 60
  const sumOfWeights = runnerResults.reduce((sum, results) => {
    const mode = results[0]?.mode
    return sum + (rrfWeights[mode ?? 'indexed'] ?? 0.5)
  }, 0)
  const theoreticalMaxRRF = sumOfWeights / (k + 1)

  const ranked = runnerResults.flatMap((results) =>
    results.map((r, i) => ({ ...r, runnerRank: i + 1 }))
  )

  const groups = new Map<string, (typeof ranked)[number][]>()
  for (const r of ranked) {
    const key = dedupKey(r)
    const group = groups.get(key) ?? []
    group.push(r)
    groups.set(key, group)
  }

  // Default signals if not provided (all active — preserves legacy behavior)
  const resolvedSignals: Required<QuerySignals> = signals ?? { semantic: true, keyword: true, graph: true, memory: true }

  // Pass 1: aggregate raw scores per dedup group
  const groupEntries = Array.from(groups.values()).map(group => {
    const rrfScore = group.reduce((sum, r) => {
      const weight = rrfWeights[r.mode] ?? 0.5
      return sum + weight * (1 / (60 + r.runnerRank))
    }, 0)

    const best = group.sort((a, b) => b.normalizedScore - a.normalizedScore)[0]!

    const aggregatedScores: Record<string, number> = {}
    const modes = new Set<string>()
    for (const r of group) {
      modes.add(r.mode)
      for (const [key, val] of Object.entries(r.rawScores)) {
        if (val != null && (aggregatedScores[key] == null || val > aggregatedScores[key]!))
          aggregatedScores[key] = val
      }
    }

    return { best, rrfScore, aggregatedScores, modes }
  })

  // Pass 2: calibrate all signals and compute composite scores
  const merged = groupEntries.map(({ best, rrfScore, aggregatedScores, modes }) => {
    const nRRF = theoreticalMaxRRF > 0 ? Math.min(rrfScore / theoreticalMaxRRF, 1) : 0
    const hasMemory = modes.has('memory')
    const hasIndexed = modes.has('indexed')

    // Use undefined for ineligible categories (weight redistributes),
    // 0 for eligible-but-scored-poorly (penalizes).
    const normalizedScores: NormalizedScores = {
      rrf: nRRF,
      semantic: aggregatedScores.semantic != null ? calibrateSemantic(aggregatedScores.semantic)
        : (hasMemory && aggregatedScores.memorySimilarity != null) ? calibrateSemantic(aggregatedScores.memorySimilarity)
        : (hasIndexed ? 0 : undefined),
      keyword: aggregatedScores.keyword != null ? calibrateKeyword(aggregatedScores.keyword) : (resolvedSignals.keyword ? 0 : undefined),
      // Graph: sqrt normalization for stable absolute scores across queries.
      // When graph signal is active, ALL results get a score (0 if no connection), never undefined.
      graph: resolvedSignals.graph
        ? Math.min(Math.sqrt(aggregatedScores.graph ?? 0), 1)
        : undefined,
      memory: hasMemory
        ? Math.min(Math.max(aggregatedScores.memory ?? 0, 0), 1)
        : undefined,
    }
    const compositeScore = computeCompositeScore(normalizedScores, resolvedSignals, scoreWeights)

    return {
      ...best,
      rawScores: aggregatedScores as NormalizedResult['rawScores'],
      modes: [...modes],
      finalScore: rrfScore,
      compositeScore,
    }
  })

  return merged
    .sort((a, b) => b.compositeScore - a.compositeScore || b.finalScore - a.finalScore)
    .slice(0, count)
}
