import type { Chunk, ChunkOpts } from '@d8um/core'
import type { RawDocument } from '@d8um/core'

export function notionChunker(doc: RawDocument, opts: ChunkOpts): Chunk[] {
  // Block-aware chunker — respect Notion's block hierarchy
  // Never split: callouts, code blocks, tables, toggle blocks
  // Natural split points: H1/H2 headings, horizontal dividers
  // TODO: implement
  throw new Error('Not implemented')
}
