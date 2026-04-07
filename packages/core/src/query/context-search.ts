import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { d8umResult, QueryOpts, QueryResponse } from '../types/query.js'
import type { DocumentFilter } from '../types/d8um-document.js'

export interface ContextSearchOpts extends QueryOpts {
  /** Number of neighbor chunks to expand around each hit. Default: 1 */
  surroundingChunks?: number | undefined
}

export interface ContextPassage {
  documentId: string
  title: string
  url?: string | undefined
  documentType?: string | undefined
  sourceType?: string | undefined
  rrfScore: number
  similarity: number
  chunks: Array<{
    chunkIndex: number
    content: string
    isHit: boolean
  }>
  /** Stitched content with truncation markers for gaps. */
  content: string
}

export interface ContextSearchResponse {
  passages: ContextPassage[]
  rawResults: d8umResult[]
  query: {
    text: string
    tenantId?: string | undefined
    durationMs: number
  }
}

/**
 * Hybrid search with neighbor expansion - returns both raw ranked chunks
 * and stitched passages (each hit + its ±N neighbor chunks, grouped by document).
 */
export async function searchWithContext(
  adapter: VectorStoreAdapter,
  bucketIds: string[],
  bucketEmbeddings: Map<string, EmbeddingProvider>,
  text: string,
  opts: ContextSearchOpts = {}
): Promise<ContextSearchResponse> {
  const startMs = Date.now()
  const radius = opts.surroundingChunks ?? 1

  // Run indexed search
  const { IndexedRunner } = await import('./runners/indexed.js')
  const { mergeAndRank } = await import('./merger.js')

  const count = opts.count ?? 10
  const tenantId = opts.tenantId

  // Build model groups from bucketEmbeddings
  const modelGroups = new Map<string, { embedding: EmbeddingProvider; bucketIds: string[] }>()
  for (const sid of bucketIds) {
    const emb = bucketEmbeddings.get(sid)
    if (!emb) continue
    const group = modelGroups.get(emb.model) ?? { embedding: emb, bucketIds: [] }
    group.bucketIds.push(sid)
    modelGroups.set(emb.model, group)
  }

  const runner = new IndexedRunner(adapter)
  const vectorOnly = !(opts.signals?.keyword ?? false)
  const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }
  const indexedResults = await runner.run(text, modelGroups, count, identity, opts.documentFilter, vectorOnly)

  // Convert NormalizedResult[] to d8umResult[]
  const rawResults = indexedResults.map(r => ({
    content: r.content,
    score: r.normalizedScore,
    scores: {
      raw: {
        cosineSimilarity: r.rawScores.vector,
        bm25: r.rawScores.keyword,
        rrf: r.rawScores.rrf ?? r.normalizedScore,
      },
      normalized: {
        semantic: r.rawScores.vector ?? 0,
        keyword: r.rawScores.keyword ?? 0,
        rrf: r.normalizedScore,
      },
    },
    sources: [r.mode],
    bucket: {
      id: r.bucketId,
      documentId: r.documentId,
      title: r.title ?? '',
      url: r.url,
      updatedAt: r.updatedAt ?? new Date(),
      status: r.documentStatus,
      visibility: r.documentVisibility,
      documentType: r.documentType,
      sourceType: r.sourceType,
      tenantId: r.tenantId,
      userId: r.userId,
      groupId: r.groupId,
      agentId: r.agentId,
      conversationId: r.conversationId,
    },
    chunk: r.chunk ?? { index: 0, total: 1, isNeighbor: false },
    metadata: r.metadata,
    tenantId: r.tenantId,
  }))

  if (rawResults.length === 0 || !adapter.getChunksByRange) {
    return {
      passages: [],
      rawResults,
      query: { text, tenantId, durationMs: Date.now() - startMs },
    }
  }

  const firstModel = [...bucketEmbeddings.values()][0]
  if (!firstModel) {
    return {
      passages: [],
      rawResults,
      query: { text, tenantId, durationMs: Date.now() - startMs },
    }
  }

  // Collect unique (documentId, chunkIndex) hits
  const hitsByDoc = new Map<string, { result: d8umResult; chunkIndex: number }[]>()
  for (const result of rawResults) {
    const docId = result.bucket.documentId
    const existing = hitsByDoc.get(docId) ?? []
    existing.push({ result, chunkIndex: result.chunk.index })
    hitsByDoc.set(docId, existing)
  }

  // Fetch neighbors for each document
  const passages: ContextPassage[] = []

  for (const [docId, hits] of hitsByDoc) {
    const hitIndices = hits.map(h => h.chunkIndex)
    const minIndex = Math.max(0, Math.min(...hitIndices) - radius)
    const totalChunks = hits[0]!.result.chunk.total
    const maxIndex = Math.min(totalChunks - 1, Math.max(...hitIndices) + radius)

    const neighborChunks = await adapter.getChunksByRange(
      firstModel.model,
      docId,
      minIndex,
      maxIndex
    )

    const hitIndexSet = new Set(hitIndices)
    const chunkList = neighborChunks.map(c => ({
      chunkIndex: c.chunkIndex,
      content: c.content,
      isHit: hitIndexSet.has(c.chunkIndex),
    })).sort((a, b) => a.chunkIndex - b.chunkIndex)

    const bestHit = hits.reduce((best, h) =>
      h.result.score > best.result.score ? h : best, hits[0]!)

    const stitchedContent = stitchChunks(chunkList, totalChunks)

    passages.push({
      documentId: docId,
      title: bestHit.result.bucket.title,
      url: bestHit.result.bucket.url,
      documentType: bestHit.result.bucket.documentType,
      sourceType: bestHit.result.bucket.sourceType,
      rrfScore: bestHit.result.score,
      similarity: bestHit.result.scores.normalized.semantic ?? 0,
      chunks: chunkList,
      content: stitchedContent,
    })
  }

  passages.sort((a, b) => b.rrfScore - a.rrfScore)

  return {
    passages,
    rawResults,
    query: { text, tenantId, durationMs: Date.now() - startMs },
  }
}

function stitchChunks(
  chunks: Array<{ chunkIndex: number; content: string }>,
  totalChunks: number
): string {
  if (chunks.length === 0) return ''

  let text = ''

  if (chunks[0]!.chunkIndex > 0) {
    text += '[truncated ' + chunks[0]!.chunkIndex + ' chunks]\n\n...'
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    if (i === 0) {
      text += chunk.content
    } else {
      const gap = chunk.chunkIndex - chunks[i - 1]!.chunkIndex
      if (gap > 1) {
        text += '...\n\n[truncated ' + (gap - 1) + ' chunks]\n\n...'
      }
      text += chunk.content
    }
  }

  const lastChunk = chunks[chunks.length - 1]!
  if (lastChunk.chunkIndex < totalChunks - 1) {
    text += '...\n\n[truncated ' + (totalChunks - 1 - lastChunk.chunkIndex) + ' chunks]'
  }

  return text
}
