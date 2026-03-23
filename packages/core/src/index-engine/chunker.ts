import type { Chunk, ChunkOpts } from '../types/connector.js'
import type { RawDocument } from '../types/connector.js'

export function defaultChunker(doc: RawDocument, opts: ChunkOpts): Chunk[] {
  const { chunkSize, chunkOverlap } = opts
  const approxChunkChars = chunkSize * 4
  const approxOverlapChars = chunkOverlap * 4

  const chunks: Chunk[] = []
  let start = 0

  while (start < doc.content.length) {
    const end = Math.min(start + approxChunkChars, doc.content.length)
    const content = doc.content.slice(start, end).trim()

    if (content.length > 0) {
      chunks.push({ content, chunkIndex: chunks.length })
    }

    if (end === doc.content.length) break
    start = end - approxOverlapChars
  }

  return chunks
}
