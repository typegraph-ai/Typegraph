import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { DocumentFilter } from '../../types/d8um-document.js'
import type { NormalizedResult } from '../merger.js'

export class IndexedRunner {
  constructor(
    private adapter: VectorStoreAdapter
  ) {}

  /**
   * Run indexed search across sources grouped by embedding model.
   * For each model group: embed the query once, search, collect results.
   */
  async run(
    text: string,
    sourcesByModel: Map<string, { embedding: EmbeddingProvider; bucketIds: string[] }>,
    count: number,
    tenantId?: string,
    documentFilter?: DocumentFilter,
    vectorOnly?: boolean
  ): Promise<NormalizedResult[]> {
    const allResults: NormalizedResult[] = []
    const fetchCount = count * 3

    for (const [modelId, group] of sourcesByModel) {
      const queryEmbedding = await group.embedding.embed(text)

      const filter = {
        tenantId,
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
            documentScope: chunk.document?.scope,
            documentType: chunk.document?.documentType,
            sourceType: chunk.document?.sourceType,
            userId: chunk.document?.userId,
            groupId: chunk.document?.groupId,
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
