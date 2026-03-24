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
    sourcesByModel: Map<string, { embedding: EmbeddingProvider; sourceIds: string[] }>,
    topK: number,
    tenantId?: string,
    documentFilter?: DocumentFilter
  ): Promise<NormalizedResult[]> {
    const allResults: NormalizedResult[] = []

    for (const [modelId, group] of sourcesByModel) {
      const queryEmbedding = await group.embedding.embed(text)

      const filter = {
        tenantId,
        sourceId: group.sourceIds.length === 1 ? group.sourceIds[0] : undefined,
      }

      // Prefer searchWithDocuments if available and documentFilter is set
      if (this.adapter.searchWithDocuments && documentFilter) {
        const chunks = await this.adapter.searchWithDocuments(modelId, queryEmbedding, text, {
          topK,
          filter,
          documentFilter,
        })

        for (const chunk of chunks) {
          if (group.sourceIds.length > 1 && !group.sourceIds.includes(chunk.sourceId)) {
            continue
          }

          allResults.push({
            content: chunk.content,
            sourceId: chunk.sourceId,
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
            folderId: chunk.document?.folderId,
          })
        }
      } else {
        // Fall back to standard hybrid/vector search
        const chunks = this.adapter.hybridSearch
          ? await this.adapter.hybridSearch(modelId, queryEmbedding, text, { topK, filter })
          : await this.adapter.search(modelId, queryEmbedding, { topK, filter })

        for (const chunk of chunks) {
          if (group.sourceIds.length > 1 && !group.sourceIds.includes(chunk.sourceId)) {
            continue
          }

          allResults.push({
            content: chunk.content,
            sourceId: chunk.sourceId,
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

    return allResults
  }
}
