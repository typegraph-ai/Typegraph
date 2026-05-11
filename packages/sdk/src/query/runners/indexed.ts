import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { Embedder } from '../../embedding/provider.js'
import { embedText } from '../../embedding/provider.js'
import type { DocumentStorageFilter } from '../../types/document.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { RetrievalSwitches } from '../../types/query.js'
import type { ChunkRef } from '../../types/chunk.js'
import type { RetrievalCandidate } from '../merger.js'
import type { typegraphEvent, typegraphEventSink } from '../../types/events.js'

export class IndexedRunner {
  constructor(
    private adapter: VectorStoreAdapter,
    private eventSink?: typegraphEventSink
  ) {}

  /**
   * Run indexed search across documents grouped by embedding model.
   * For each model group: embed the query once, search, collect results.
   */
  async run(
    text: string,
    documentsByModel: Map<string, { embedding: Embedder; ingestModelId: string; bucketIds: string[] }>,
    count: number,
    identity?: typegraphIdentity,
    documentFilter?: DocumentStorageFilter,
    switches?: Required<RetrievalSwitches>,
    traceId?: string,
    spanId?: string,
    temporalAt?: Date,
    chunkRefs?: ChunkRef[],
  ): Promise<RetrievalCandidate[]> {
    const allResults: RetrievalCandidate[] = []
    const fetchCount = count * 3
    const useSemantic = switches?.semantic ?? true
    const useKeyword = switches?.keyword ?? false

    for (const [, group] of documentsByModel) {
      const modelId = group.ingestModelId
      const bucketStartMs = Date.now()
      const searchEmbedding = await embedText(group.embedding, text, 'search')

      const filter = {
        tenantId: identity?.tenantId,
        bucketIds: group.bucketIds,
        graphIds: documentFilter?.graphIds,
        chunkRefs: chunkRefs
          ?.filter(ref => ref.embeddingModel == null || ref.embeddingModel === modelId),
      }

      // Prefer searchWithDocuments if available and documentFilter is set
      if (this.adapter.searchWithDocuments && documentFilter) {
        const chunks = await this.adapter.searchWithDocuments(modelId, searchEmbedding, text, {
          count: fetchCount,
          filter,
          documentFilter: {
            ...documentFilter,
            graphIds: documentFilter.graphIds,
          },
          temporalAt,
          retrieval: { semantic: useSemantic, keyword: useKeyword },
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
            name: chunk.document?.name ?? chunk.metadata.name as string | undefined,
            updatedAt: chunk.indexedAt,
            tenantId: chunk.tenantId,
            graphId: chunk.graphId,
            documentStatus: chunk.document?.status,
            userId: chunk.document?.userId,
            groupId: chunk.document?.groupId,
            agentId: chunk.document?.agentId,
            threadId: chunk.document?.threadId,
          })
        }
      } else {
        // Fall back to standard hybrid/semantic search (or semantic-only in fast mode)
        const chunks = useKeyword && this.adapter.hybridSearch
          ? await this.adapter.hybridSearch(modelId, searchEmbedding, text, {
              count: fetchCount,
              filter,
              temporalAt,
              retrieval: { semantic: useSemantic, keyword: useKeyword },
            })
          : useSemantic
            ? await this.adapter.search(modelId, searchEmbedding, { count: fetchCount, filter, temporalAt })
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
            name: chunk.metadata.name as string | undefined,
            updatedAt: chunk.indexedAt,
            tenantId: chunk.tenantId,
            graphId: chunk.graphId,
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
            payload: { bucketId, resultCount: bucketResultCount, retrieval: switches },
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
    const documentBest = new Map<string, RetrievalCandidate>()
    for (const r of allResults) {
      const existing = documentBest.get(r.documentId)
      if (!existing || r.normalizedScore > existing.normalizedScore) {
        documentBest.set(r.documentId, r)
      }
    }

    return [...documentBest.values()]
      .sort((a, b) => b.normalizedScore - a.normalizedScore)
      .slice(0, count)
  }
}
