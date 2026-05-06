import type { Bucket } from '../../types/bucket.js'
import type { SourceInput, ChunkOpts } from '../../types/connector.js'
import type { IngestOptions } from '../../types/index-types.js'

export interface MockSourceOpts {
  id?: string
  name?: string
  sources?: SourceInput[]
  chunkSize?: number
  chunkOverlap?: number
  deduplicateBy?: string[] | ((source: SourceInput) => string)
  stripMarkdownForEmbedding?: boolean
  preprocessForEmbedding?: (content: string) => string
  propagateMetadata?: string[]
}

export interface MockSourceResult {
  bucket: Bucket
  sources: SourceInput[]
  ingestOptions: IngestOptions
  chunkOpts: ChunkOpts
}

export function createMockBucket(opts: MockSourceOpts = {}): MockSourceResult {
  const id = opts.id ?? 'test-source'
  const sources = opts.sources ?? []

  const bucket: Bucket = {
    id,
    name: opts.name ?? 'Test Bucket',
    status: 'active',
  }

  const chunkSize = opts.chunkSize ?? 100
  const chunkOverlap = opts.chunkOverlap ?? 20

  const ingestOptions: IngestOptions = {
    chunkSize,
    chunkOverlap,
    deduplicateBy: opts.deduplicateBy ?? ['id'],
    stripMarkdownForEmbedding: opts.stripMarkdownForEmbedding,
    preprocessForEmbedding: opts.preprocessForEmbedding,
    propagateMetadata: opts.propagateMetadata,
  }

  const chunkOpts: ChunkOpts = { chunkSize, chunkOverlap }

  return { bucket, sources, ingestOptions, chunkOpts }
}
