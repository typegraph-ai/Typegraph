import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { SourceFilter } from '../../types/source.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { QuerySignals } from '../../types/query.js'
import type { ChunkRef } from '../../types/chunk.js'
import type { RetrievalCandidate } from '../merger.js'
import type { typegraphEvent, typegraphEventSink } from '../../types/events.js'

export class IndexedRunner {
  constructor(
    private adapter: VectorStoreAdapter,
    private eventSink?: typegraphEventSink
  ) {}

  /**
   * Run indexed search across sources grouped by embedding model.
   * For each model group: embed the query once, search, collect results.
   */
  async run(
    text: string,
    sourcesByModel: Map<string, { embedding: EmbeddingProvider; ingestModelId: string; bucketIds: string[] }>,
    count: number,
    identity?: typegraphIdentity,
    sourceFilter?: SourceFilter,
    signals?: Required<QuerySignals>,
    traceId?: string,
    spanId?: string,
    temporalAt?: Date,
    chunkRefs?: ChunkRef[],
  ): Promise<RetrievalCandidate[]> {
    const allResults: RetrievalCandidate[] = []
    const fetchCount = count * 3
    const useSemantic = signals?.semantic ?? true
    const useKeyword = signals?.keyword ?? false

    for (const [, group] of sourcesByModel) {
      const modelId = group.ingestModelId
      const bucketStartMs = Date.now()
      const queryEmbedding = await group.embedding.embed(text)

      const filter = {
        tenantId: identity?.tenantId,
        groupId: identity?.groupId,
        userId: identity?.userId,
        agentId: identity?.agentId,
        conversationId: identity?.conversationId,
        bucketIds: group.bucketIds,
        chunkRefs: chunkRefs
          ?.filter(ref => ref.embeddingModel == null || ref.embeddingModel === modelId),
      }

      // Prefer searchWithSources if available and sourceFilter is set
      if (this.adapter.searchWithSources && sourceFilter) {
        const chunks = await this.adapter.searchWithSources(modelId, queryEmbedding, text, {
          count: fetchCount,
          filter,
          sourceFilter,
          temporalAt,
          signals: { semantic: useSemantic, keyword: useKeyword },
        })

        for (const chunk of chunks) {
          allResults.push({
            content: chunk.content,
            bucketId: chunk.bucketId,
            sourceId: chunk.sourceId,
            rawScores: {
              semantic: chunk.scores.semantic,
              keyword: chunk.scores.keyword,
              rrf: chunk.scores.rrf,
            },
            normalizedScore: chunk.scores.rrf ?? chunk.scores.semantic ?? 0,
            mode: 'indexed',
            metadata: chunk.metadata,
            chunk: {
              index: chunk.chunkIndex,
              total: chunk.totalChunks,
            },
            url: chunk.source?.url ?? chunk.metadata.url as string | undefined,
            title: chunk.source?.title ?? chunk.metadata.title as string | undefined,
            updatedAt: chunk.indexedAt,
            tenantId: chunk.tenantId,
            // Carry source-level fields if available
            sourceStatus: chunk.source?.status,
            sourceVisibility: chunk.source?.visibility,
            sourceSubject: chunk.source?.subject,
            userId: chunk.source?.userId,
            groupId: chunk.source?.groupId,
            agentId: chunk.source?.agentId,
            conversationId: chunk.source?.conversationId,
          })
        }
      } else {
        // Fall back to standard hybrid/semantic search (or semantic-only in fast mode)
        const chunks = useKeyword && this.adapter.hybridSearch
          ? await this.adapter.hybridSearch(modelId, queryEmbedding, text, {
              count: fetchCount,
              filter,
              temporalAt,
              signals: { semantic: useSemantic, keyword: useKeyword },
            })
          : useSemantic
            ? await this.adapter.search(modelId, queryEmbedding, { count: fetchCount, filter, temporalAt })
            : []

        for (const chunk of chunks) {
          allResults.push({
            content: chunk.content,
            bucketId: chunk.bucketId,
            sourceId: chunk.sourceId,
            rawScores: {
              semantic: chunk.scores.semantic,
              keyword: chunk.scores.keyword,
              rrf: chunk.scores.rrf,
            },
            normalizedScore: chunk.scores.rrf ?? chunk.scores.semantic ?? 0,
            mode: 'indexed',
            metadata: chunk.metadata,
            chunk: {
              index: chunk.chunkIndex,
              total: chunk.totalChunks,
            },
            url: chunk.metadata.url as string | undefined,
            title: chunk.metadata.title as string | undefined,
            updatedAt: chunk.indexedAt,
            tenantId: chunk.tenantId,
          })
        }
      }

      // Emit per-bucket events after this model group's search completes
      if (this.eventSink) {
        const bucketDurationMs = Date.now() - bucketStartMs
        for (const bucketId of group.bucketIds) {
          const bucketResultCount = allResults.filter(r => r.bucketId === bucketId).length
          const event: typegraphEvent = {
            id: crypto.randomUUID(),
            eventType: 'query.bucket_result',
            identity: identity ?? {},
            payload: { bucketId, resultCount: bucketResultCount, signals },
            durationMs: bucketDurationMs,
            traceId,
            spanId,
            timestamp: new Date(),
          }
          void this.eventSink.emit(event)
        }
      }
    }

    // Source-level dedup: keep highest-scoring chunk per source
    const sourceBest = new Map<string, RetrievalCandidate>()
    for (const r of allResults) {
      const existing = sourceBest.get(r.sourceId)
      if (!existing || r.normalizedScore > existing.normalizedScore) {
        sourceBest.set(r.sourceId, r)
      }
    }

    return [...sourceBest.values()]
      .sort((a, b) => b.normalizedScore - a.normalizedScore)
      .slice(0, count)
  }
}
