import { createHash } from 'crypto'
import type { QueryMemoryRecord, QuerySignals, NormalizedScores } from '../types/query.js'
import type { SourceSubject } from '../types/connector.js'
import { computeCompositeScore } from './planner.js'

export interface RetrievalCandidate {
  content: string
  bucketId: string
  sourceId: string
  rawScores: { semantic?: number | undefined; keyword?: number | undefined; rrf?: number | undefined; memory?: number | undefined; graph?: number | undefined; memorySimilarity?: number | undefined; memoryImportance?: number | undefined; memoryRecency?: number | undefined }
  normalizedScore: number
  mode: 'indexed' | 'memory' | 'graph'
  metadata: Record<string, unknown>
  chunk?: { index: number; total: number } | undefined
  url?: string | undefined
  title?: string | undefined
  updatedAt?: Date | undefined
  tenantId?: string | undefined
  // Source-level fields (populated when searchWithSources is used)
  sourceStatus?: string | undefined
  sourceVisibility?: string | undefined
  sourceSubject?: SourceSubject | undefined
  userId?: string | undefined
  groupId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  memoryRecord?: QueryMemoryRecord | undefined
}

export function dedupKey(r: RetrievalCandidate): string {
  if (r.sourceId && r.chunk?.index !== undefined && r.bucketId) {
    return `${r.bucketId}:${r.sourceId}:${r.chunk.index}`
  }
  return createHash('sha256').update(r.content).digest('hex')
}

export function minMaxNormalize(results: RetrievalCandidate[]): RetrievalCandidate[] {
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

/** Normalize graph PPR scores with fourth-root scaling.
 *  PPR is a probability mass and useful chunk scores are often small
 *  absolute values. Fourth-root scaling expands low-but-meaningful scores
 *  while keeping the mapping deterministic and comparable across queries. */
export function normalizeGraphPPR(pprScore: number): number {
  if (!Number.isFinite(pprScore) || pprScore <= 0) return 0
  return Math.min(Math.sqrt(Math.sqrt(pprScore)), 1)
}

/** Calibrate raw cosine similarity to a 0-1 relevance scale.
 *  Rescales the practical range of the embedding model to use the full 0-1 range.
 *  Default floor/ceiling tuned for current cross-query score stability. */
export function calibrateSemantic(cosine: number, floor = 0, ceiling = 0.85): number {
  if (cosine <= floor) return 0
  if (cosine >= ceiling) return 1
  return (cosine - floor) / (ceiling - floor)
}

/** Calibrate raw ts_rank() BM25 score to 0-1.
 *  ts_rank() produces values typically in [0, 1] range.
 *  Static ceiling normalization ensures consistent 0-1 scale across queries. */
export function calibrateKeyword(score: number, floor = 0, ceiling = 1): number {
  if (score <= floor) return 0
  if (score >= ceiling) return 1
  return (score - floor) / (ceiling - floor)
}

/** Default RRF weights by internal runner mode. */
const DEFAULT_RRF_WEIGHTS: Record<string, number> = {
  indexed: 0.5,
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
  }
}

export function mergeAndRank(
  runnerResults: RetrievalCandidate[][],
  count: number,
  weights?: Record<string, number>,
  signals?: Required<QuerySignals>,
  scoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>
): RetrievalCandidate[] {
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
      // Graph: fourth-root PPR normalization for stable absolute scores across queries.
      // When graph signal is active, ALL results get a score (0 if no connection), never undefined.
      graph: resolvedSignals.graph
        ? normalizeGraphPPR(aggregatedScores.graph ?? 0)
        : undefined,
      memory: hasMemory
        ? Math.min(Math.max(aggregatedScores.memory ?? 0, 0), 1)
        : undefined,
    }
    const compositeScore = computeCompositeScore(normalizedScores, resolvedSignals, scoreWeights)

    return {
      ...best,
      rawScores: aggregatedScores as RetrievalCandidate['rawScores'],
      modes: [...modes],
      finalScore: rrfScore,
      compositeScore,
    }
  })

  return merged
    .sort((a, b) => b.compositeScore - a.compositeScore || b.finalScore - a.finalScore)
    .slice(0, count)
}
