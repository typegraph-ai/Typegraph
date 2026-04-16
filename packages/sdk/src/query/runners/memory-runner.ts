import type { MemoryBridge } from '../../types/graph-bridge.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { NormalizedResult } from '../merger.js'

/** Memory composite score weights */
const W_SIMILARITY = 0.55
const W_IMPORTANCE = 0.30
const W_RECENCY = 0.15

/** Half-life for recency decay (7 days in ms) */
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/** Exponential decay recency score (0-1). 1.0 = just accessed, ~0.5 at half-life. */
function computeRecency(lastAccessedAt: Date | undefined, createdAt: Date): number {
  const ref = lastAccessedAt ?? createdAt
  const ageMs = Math.max(0, Date.now() - ref.getTime())
  return Math.exp(-(Math.LN2 / HALF_LIFE_MS) * ageMs)
}

export class MemoryRunner {
  constructor(private memory: MemoryBridge) {}

  async run(
    text: string,
    identity: typegraphIdentity,
    count: number,
    opts?: { temporalAt?: Date | undefined; includeInvalidated?: boolean | undefined; useKeyword?: boolean | undefined },
  ): Promise<NormalizedResult[]> {
    // Use hybrid search when keyword signal is active and bridge supports it
    const useHybrid = opts?.useKeyword && this.memory.recallHybrid
    const recallOpts = {
      limit: count,
      ...(opts?.temporalAt ? { temporalAt: opts.temporalAt } : {}),
      ...(opts?.includeInvalidated != null ? { includeInvalidated: opts.includeInvalidated } : {}),
    }

    const memories = useHybrid
      ? await this.memory.recallHybrid!(text, identity, recallOpts)
      : await this.memory.recall(text, identity, recallOpts)

    return memories.map((m, i) => {
      const similarity = (m.metadata?._similarity as number | undefined) ?? 0
      const importance = m.importance ?? 0.5
      const lastAccessedAt = m.metadata?._lastAccessedAt
        ? new Date(m.metadata._lastAccessedAt as string)
        : undefined
      const createdAt = m.metadata?._createdAt
        ? new Date(m.metadata._createdAt as string)
        : m.createdAt ?? new Date()
      const recency = computeRecency(lastAccessedAt, createdAt)

      // Composite memory score: weighted combination of all three sub-signals
      const compositeMemoryScore = Math.min(Math.max(
        W_SIMILARITY * similarity + W_IMPORTANCE * importance + W_RECENCY * recency,
      0), 1)

      return {
        content: m.content ?? '',
        bucketId: '__memory__',
        documentId: m.id ?? `memory-${i}`,
        rawScores: {
          memory: compositeMemoryScore,
          semantic: similarity, // Cosine similarity — same algorithm as indexed search
          memorySimilarity: similarity,
          memoryImportance: importance,
          memoryRecency: recency,
          ...(m.metadata?._keywordScore != null ? { keyword: m.metadata._keywordScore as number } : {}),
        },
        normalizedScore: compositeMemoryScore,
        mode: 'memory' as const,
        metadata: (m.metadata ?? {}) as Record<string, unknown>,
        tenantId: identity.tenantId,
      }
    })
  }
}
