import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { DocumentFilter } from '../../types/typegraph-document.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { QuerySignals } from '../../types/query.js'
import type { ChunkRef } from '../../types/document.js'
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
    documentFilter?: DocumentFilter,
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

      // Prefer searchWithDocuments if available and documentFilter is set
      if (this.adapter.searchWithDocuments && documentFilter) {
        const chunks = await this.adapter.searchWithDocuments(modelId, queryEmbedding, text, {
          count: fetchCount,
          filter,
          documentFilter,
          temporalAt,
          signals: { semantic: useSemantic, keyword: useKeyword },
        })

        for (const chunk of chunks) {
          allResults.push({
            content: chunk.content,
            bucketId: chunk.bucketId,
            documentId: chunk.documentId,
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
            url: chunk.document?.url ?? chunk.metadata.url as string | undefined,
            title: chunk.document?.title ?? chunk.metadata.title as string | undefined,
            updatedAt: chunk.indexedAt,
            tenantId: chunk.tenantId,
            // Carry document-level fields if available
            documentStatus: chunk.document?.status,
            documentVisibility: chunk.document?.visibility,
            userId: chunk.document?.userId,
            groupId: chunk.document?.groupId,
            agentId: chunk.document?.agentId,
            conversationId: chunk.document?.conversationId,
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
            documentId: chunk.documentId,
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

    // Document-level dedup: keep highest-scoring chunk per document
    const docBest = new Map<string, RetrievalCandidate>()
    for (const r of allResults) {
      const existing = docBest.get(r.documentId)
      if (!existing || r.normalizedScore > existing.normalizedScore) {
        docBest.set(r.documentId, r)
      }
    }

    return [...docBest.values()]
      .sort((a, b) => b.normalizedScore - a.normalizedScore)
      .slice(0, count)
  }
}
