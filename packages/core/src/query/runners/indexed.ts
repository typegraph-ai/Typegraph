import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { DocumentFilter } from '../../types/d8um-document.js'
import type { d8umIdentity } from '../../types/identity.js'
import type { NormalizedResult } from '../merger.js'
import type { d8umEvent, d8umEventSink } from '../../types/events.js'

export class IndexedRunner {
  constructor(
    private adapter: VectorStoreAdapter,
    private eventSink?: d8umEventSink
  ) {}

  /**
   * Run indexed search across sources grouped by embedding model.
   * For each model group: embed the query once, search, collect results.
   */
  async run(
    text: string,
    sourcesByModel: Map<string, { embedding: EmbeddingProvider; bucketIds: string[] }>,
    count: number,
    identity?: d8umIdentity,
    documentFilter?: DocumentFilter,
    vectorOnly?: boolean,
    traceId?: string,
    spanId?: string
  ): Promise<NormalizedResult[]> {
    const allResults: NormalizedResult[] = []
    const fetchCount = count * 3

    for (const [modelId, group] of sourcesByModel) {
      const bucketStartMs = Date.now()
      const queryEmbedding = await group.embedding.embed(text)

      const filter = {
        tenantId: identity?.tenantId,
        groupId: identity?.groupId,
        userId: identity?.userId,
        agentId: identity?.agentId,
        conversationId: identity?.conversationId,
        bucketId: group.bucketIds.length === 1 ? group.bucketIds[0] : undefined,
      }

      // Prefer searchWithDocuments if available and documentFilter is set
      if (this.adapter.searchWithDocuments && documentFilter) {
        const chunks = await this.adapter.searchWithDocuments(modelId, queryEmbedding, text, {
          count: fetchCount,
          filter,
          documentFilter,
        })

        for (const chunk of chunks) {
          if (group.bucketIds.length > 1 && !group.bucketIds.includes(chunk.bucketId)) {
            continue
          }

          allResults.push({
            content: chunk.content,
            bucketId: chunk.bucketId,
            documentId: chunk.documentId,
            rawScores: {
              vector: chunk.scores.vector,
              keyword: chunk.scores.keyword,
              rrf: chunk.scores.rrf,
            },
            normalizedScore: chunk.scores.rrf ?? chunk.scores.vector ?? 0,
            mode: 'indexed',
            metadata: chunk.metadata,
            chunk: {
              index: chunk.chunkIndex,
              total: chunk.totalChunks,
              isNeighbor: false,
            },
            url: chunk.document?.url ?? chunk.metadata.url as string | undefined,
            title: chunk.document?.title ?? chunk.metadata.title as string | undefined,
            updatedAt: chunk.indexedAt,
            tenantId: chunk.tenantId,
            // Carry document-level fields if available
            documentStatus: chunk.document?.status,
            documentVisibility: chunk.document?.visibility,
            documentType: chunk.document?.documentType,
            sourceType: chunk.document?.sourceType,
            userId: chunk.document?.userId,
            groupId: chunk.document?.groupId,
            agentId: chunk.document?.agentId,
            conversationId: chunk.document?.conversationId,
          })
        }
      } else {
        // Fall back to standard hybrid/vector search (or vector-only in fast mode)
        const chunks = (!vectorOnly && this.adapter.hybridSearch)
          ? await this.adapter.hybridSearch(modelId, queryEmbedding, text, { count: fetchCount, filter })
          : await this.adapter.search(modelId, queryEmbedding, { count: fetchCount, filter })

        for (const chunk of chunks) {
          if (group.bucketIds.length > 1 && !group.bucketIds.includes(chunk.bucketId)) {
            continue
          }

          allResults.push({
            content: chunk.content,
            bucketId: chunk.bucketId,
            documentId: chunk.documentId,
            rawScores: {
              vector: chunk.scores.vector,
              keyword: chunk.scores.keyword,
              rrf: chunk.scores.rrf,
            },
            normalizedScore: chunk.scores.rrf ?? chunk.scores.vector ?? 0,
            mode: 'indexed',
            metadata: chunk.metadata,
            chunk: {
              index: chunk.chunkIndex,
              total: chunk.totalChunks,
              isNeighbor: false,
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
        const mode = vectorOnly ? 'fast' : 'hybrid'
        for (const bucketId of group.bucketIds) {
          const bucketResultCount = allResults.filter(r => r.bucketId === bucketId).length
          const event: d8umEvent = {
            id: crypto.randomUUID(),
            eventType: 'query.bucket_result',
            identity: identity ?? {},
            payload: { bucketId, resultCount: bucketResultCount, mode },
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
    const docBest = new Map<string, NormalizedResult>()
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
