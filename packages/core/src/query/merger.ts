import { createHash } from 'crypto'
import type { QuerySignals, NormalizedScores } from '../types/query.js'
import { computeCompositeScore } from './planner.js'

export interface NormalizedResult {
  content: string
  bucketId: string
  documentId: string
  rawScores: { vector?: number | undefined; keyword?: number | undefined; rrf?: number | undefined; liveRelevance?: number | undefined; memory?: number | undefined; graph?: number | undefined }
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

/** Normalize a raw PPR score to 0-1 by dividing by the damping factor.
 *  The damping factor (restart probability) is the approximate theoretical max
 *  PPR score for a strongly-connected seed node. This produces scores that are
 *  comparable across different queries and graph structures. */
export function normalizePPR(pprScore: number, dampingFactor = 0.35): number {
  if (dampingFactor <= 0) return 0
  return Math.min(pprScore / dampingFactor, 1.0)
}

/** RRF weights by internal runner mode (used for inter-runner rank fusion). */
const RRF_WEIGHTS: Record<string, number> = {
  indexed: 0.5,
  live: 0.1,
  cached: 0.1,
  memory: 0.2,
  graph: 0.15,
}

export function mergeAndRank(
  runnerResults: NormalizedResult[][],
  count: number,
  weights?: Record<string, number>,
  signals?: Required<QuerySignals>,
  scoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>
): NormalizedResult[] {
  const numLists = runnerResults.length
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
  const resolvedSignals: Required<QuerySignals> = signals ?? { vector: true, keyword: true, graph: true, memory: true }

  const merged = Array.from(groups.values()).map(group => {
    // Weighted RRF across runners
    const rrfScore = group.reduce((sum, r) => {
      const weight = (weights ?? RRF_WEIGHTS)[r.mode] ?? 0.5
      return sum + weight * (1 / (60 + r.runnerRank))
    }, 0)

    const best = group.sort((a, b) => b.normalizedScore - a.normalizedScore)[0]!

    // Aggregate rawScores: take max of each score type across all entries in the group
    const aggregatedScores: Record<string, number> = {}
    const modes = new Set<string>()
    for (const r of group) {
      modes.add(r.mode)
      for (const [key, val] of Object.entries(r.rawScores)) {
        if (val != null && (aggregatedScores[key] == null || val > aggregatedScores[key]!))
          aggregatedScores[key] = val
      }
    }

    // Compute normalized composite score using shared function
    const nRRF = normalizeRRF(rrfScore, numLists)
    const normalizedScores: NormalizedScores = {
      rrf: nRRF,
      semantic: aggregatedScores.vector ?? 0,
      keyword: aggregatedScores.keyword ?? 0,
      graph: normalizePPR(aggregatedScores.graph ?? 0),
      memory: aggregatedScores.memory ?? 0,
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
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, count)
}
