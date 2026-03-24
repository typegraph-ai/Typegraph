import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { d8umResult, QueryOpts, QueryResponse } from '../types/query.js'
import type { DocumentFilter } from '../types/d8um-document.js'
import type { d8umSource } from '../types/source.js'
import { QueryPlanner } from './planner.js'

export interface ContextSearchOpts extends QueryOpts {
  /** Number of neighbor chunks to expand around each hit. Default: 1 */
  neighborRadius?: number | undefined
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
 * Hybrid search with neighbor expansion — returns both raw ranked chunks
 * and stitched passages (each hit + its ±N neighbor chunks, grouped by document).
 */
export async function searchWithContext(
  adapter: VectorStoreAdapter,
  sources: Map<string, d8umSource>,
  sourceEmbeddings: Map<string, EmbeddingProvider>,
  text: string,
  opts: ContextSearchOpts = {}
): Promise<ContextSearchResponse> {
  const startMs = Date.now()
  const radius = opts.neighborRadius ?? 1

  // Run the standard query to get top hits
  const planner = new QueryPlanner(adapter, sources, sourceEmbeddings)
  const response = await planner.execute(text, opts)
  const rawResults = response.results

  if (rawResults.length === 0 || !adapter.getChunksByRange) {
    return {
      passages: [],
      rawResults,
      query: { text, tenantId: opts.tenantId, durationMs: Date.now() - startMs },
    }
  }

  // Determine which model to use for fetching neighbors
  // Use the first distinct embedding model found
  const firstModel = [...sourceEmbeddings.values()][0]
  if (!firstModel) {
    return {
      passages: [],
      rawResults,
      query: { text, tenantId: opts.tenantId, durationMs: Date.now() - startMs },
    }
  }

  // Collect unique (documentId, chunkIndex) hits
  const hitsByDoc = new Map<string, { result: d8umResult; chunkIndex: number }[]>()
  for (const result of rawResults) {
    const docId = result.source.documentId
    const existing = hitsByDoc.get(docId) ?? []
    existing.push({ result, chunkIndex: result.chunk.index })
    hitsByDoc.set(docId, existing)
  }

  // Fetch neighbors for each document
  const passages: ContextPassage[] = []

  for (const [docId, hits] of hitsByDoc) {
    // Compute the range of chunks to fetch (all hits ± radius)
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

    // Build the chunk list with isHit flags
    const hitIndexSet = new Set(hitIndices)
    const chunkList = neighborChunks.map(c => ({
      chunkIndex: c.chunkIndex,
      content: c.content,
      isHit: hitIndexSet.has(c.chunkIndex),
    })).sort((a, b) => a.chunkIndex - b.chunkIndex)

    // Stitch content with truncation markers
    const bestHit = hits.reduce((best, h) =>
      h.result.score > best.result.score ? h : best, hits[0]!)

    const stitchedContent = stitchChunks(chunkList, totalChunks)

    passages.push({
      documentId: docId,
      title: bestHit.result.source.title,
      url: bestHit.result.source.url,
      documentType: bestHit.result.source.documentType,
      sourceType: bestHit.result.source.sourceType,
      rrfScore: bestHit.result.score,
      similarity: bestHit.result.scores.vector ?? 0,
      chunks: chunkList,
      content: stitchedContent,
    })
  }

  // Sort passages by best RRF score
  passages.sort((a, b) => b.rrfScore - a.rrfScore)

  return {
    passages,
    rawResults,
    query: { text, tenantId: opts.tenantId, durationMs: Date.now() - startMs },
  }
}

/** Stitch chunks together with truncation markers for gaps. */
function stitchChunks(
  chunks: Array<{ chunkIndex: number; content: string }>,
  totalChunks: number
): string {
  if (chunks.length === 0) return ''

  let text = ''

  // Leading truncation
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

  // Trailing truncation
  const lastChunk = chunks[chunks.length - 1]!
  if (lastChunk.chunkIndex < totalChunks - 1) {
    text += '...\n\n[truncated ' + (totalChunks - 1 - lastChunk.chunkIndex) + ' chunks]'
  }

  return text
}
