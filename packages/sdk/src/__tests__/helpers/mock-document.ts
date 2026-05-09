import type { Bucket } from '../../types/bucket.js'
import type { ChunkOpts, DocumentInput } from '../../types/document.js'
import type { IngestOptions } from '../../types/index-types.js'

export interface MockDocumentOpts {
  id?: string
  name?: string
  documents?: DocumentInput[]
  chunkSize?: number
  chunkOverlap?: number
  deduplicateBy?: string[] | ((document: DocumentInput) => string)
  stripMarkdownForEmbedding?: boolean
  preprocessForEmbedding?: (content: string) => string
  propagateMetadata?: string[]
}

export interface MockDocumentResult {
  bucket: Bucket
  documents: DocumentInput[]
  ingestOptions: IngestOptions
  chunkOpts: ChunkOpts
}

export function createMockBucket(opts: MockDocumentOpts = {}): MockDocumentResult {
  const id = opts.id ?? 'test-bucket'
  const documents = opts.documents ?? []

  const bucket: Bucket = {
    id,
    name: opts.name ?? 'Test Bucket',
    status: 'active',
    tenantId: 'tenant-1',
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

  return { bucket, documents, ingestOptions, chunkOpts }
}
