import type { Bucket } from '../../types/bucket.js'
import type { RawDocument, ChunkOpts } from '../../types/connector.js'
import type { IngestOptions } from '../../types/index-types.js'

export interface MockSourceOpts {
  id?: string
  name?: string
  documents?: RawDocument[]
  chunkSize?: number
  chunkOverlap?: number
  deduplicateBy?: string[] | ((doc: RawDocument) => string)
  stripMarkdownForEmbedding?: boolean
  preprocessForEmbedding?: (content: string) => string
  propagateMetadata?: string[]
  documentType?: string
  sourceType?: string
}

export interface MockSourceResult {
  bucket: Bucket
  documents: RawDocument[]
  ingestOptions: IngestOptions
  chunkOpts: ChunkOpts
}

export function createMockBucket(opts: MockSourceOpts = {}): MockSourceResult {
  const id = opts.id ?? 'test-source'
  const documents = opts.documents ?? []

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
    documentType: opts.documentType,
    sourceType: opts.sourceType,
  }

  const chunkOpts: ChunkOpts = { chunkSize, chunkOverlap }

  return { bucket, documents, ingestOptions, chunkOpts }
}
