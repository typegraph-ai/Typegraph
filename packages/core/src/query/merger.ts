import { createHash } from 'crypto'

export interface NormalizedResult {
  content: string
  sourceId: string
  documentId: string
  rawScores: { vector?: number | undefined; keyword?: number | undefined; liveRelevance?: number | undefined }
  normalizedScore: number
  mode: 'indexed' | 'live' | 'cached'
  metadata: Record<string, unknown>
  chunk?: { index: number; total: number; isNeighbor: boolean } | undefined
  url?: string | undefined
  title?: string | undefined
  updatedAt?: Date | undefined
  tenantId?: string | undefined
  // Document-level fields (populated when searchWithDocuments is used)
  documentStatus?: string | undefined
  documentScope?: string | undefined
  documentType?: string | undefined
  sourceType?: string | undefined
  userId?: string | undefined
  folderId?: string | undefined
}

export function dedupKey(r: NormalizedResult): string {
  if (r.url) return r.url
  if (r.chunk) return `${r.documentId}::${r.chunk.index}`
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

const DEFAULT_WEIGHTS: Record<string, number> = {
  indexed: 0.7,
  live: 0.2,
  cached: 0.1,
}

export function mergeAndRank(
  runnerResults: NormalizedResult[][],
  topK: number,
  weights?: Record<string, number>
): NormalizedResult[] {
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

  const merged = Array.from(groups.values()).map(group => {
    const rrfScore = group.reduce((sum, r) => {
      const weight = (weights ?? DEFAULT_WEIGHTS)[r.mode] ?? 0.5
      return sum + weight * (1 / (60 + r.runnerRank))
    }, 0)
    const best = group.sort((a, b) => b.normalizedScore - a.normalizedScore)[0]!
    return { ...best, finalScore: rrfScore }
  })

  return merged
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK)
}
