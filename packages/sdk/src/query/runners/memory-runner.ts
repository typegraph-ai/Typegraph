import type { MemoryBridge } from '../../types/graph-bridge.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { QueryEntityScope } from '../../types/query.js'
import type { RetrievalCandidate } from '../merger.js'

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
    opts?: { temporalAt?: Date | undefined; includeInvalidated?: boolean | undefined; useKeyword?: boolean | undefined; entityScope?: QueryEntityScope | undefined },
  ): Promise<RetrievalCandidate[]> {
    // Use hybrid search when keyword signal is active and bridge supports it
    const useHybrid = opts?.useKeyword && this.memory.recallHybrid
    const recallOpts = {
      ...identity,
      limit: count,
      ...(opts?.temporalAt ? { temporalAt: opts.temporalAt } : {}),
      ...(opts?.includeInvalidated != null ? { includeInvalidated: opts.includeInvalidated } : {}),
      ...(opts?.entityScope ? { entityScope: opts.entityScope } : {}),
    }

    const memories = useHybrid
      ? await this.memory.recallHybrid!(text, recallOpts)
      : await this.memory.recall(text, recallOpts)

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

      const { embedding: _embedding, ...memoryRecord } = m

      return {
        content: m.content ?? '',
        bucketId: '__memory__',
        sourceId: m.id ?? `memory-${i}`,
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
        memoryRecord,
        tenantId: identity.tenantId,
      }
    })
  }
}
