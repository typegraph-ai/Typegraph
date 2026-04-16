import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from './document.js'
import type { typegraphDocument, DocumentFilter, DocumentStatus, UpsertDocumentInput } from './typegraph-document.js'
import type { Bucket, BucketListFilter } from './bucket.js'
import type { PaginationOpts, PaginatedResult } from './pagination.js'

export interface SearchOpts {
  count: number
  filter?: ChunkFilter | undefined
  approximate?: boolean | undefined
  iterativeScan?: boolean | undefined
  /** Only return chunks indexed before this date. Used for point-in-time queries. */
  temporalAt?: Date | undefined
}

export interface HashRecord {
  idempotencyKey: string
  contentHash: string
  bucketId: string
  tenantId?: string | undefined
  embeddingModel: string
  indexedAt: Date
  chunkCount: number
}

export interface HashStoreAdapter {
  initialize(): Promise<void>
  get(key: string): Promise<HashRecord | null>
  /** Batch get: returns a Map of key → HashRecord for all found keys. */
  getMany?(keys: string[]): Promise<Map<string, HashRecord>>
  set(key: string, record: HashRecord): Promise<void>
  delete(key: string): Promise<void>
  listByBucket(bucketId: string, tenantId?: string | undefined): Promise<HashRecord[]>
  getLastRunTime(bucketId: string, tenantId?: string | undefined): Promise<Date | null>
  setLastRunTime(bucketId: string, tenantId: string | undefined, time: Date): Promise<void>
  deleteByBucket(bucketId: string, tenantId?: string | undefined): Promise<void>
}

export interface ScoredChunkWithDocument extends ScoredChunk {
  document?: typegraphDocument | undefined
}

export interface UndeployResult {
  success: boolean
  message: string
}

export interface VectorStoreAdapter {
  /** Run DDL to create all tables and extensions. Idempotent. Called once during setup/CI. */
  deploy(): Promise<void>

  /** Lightweight runtime init — load model registrations, etc. Assumes tables already exist. */
  connect(): Promise<void>

  /** Drop all typegraph tables. Refuses if any table contains data. */
  undeploy?(): Promise<UndeployResult>

  destroy?(): Promise<void>

  /** Ensure a model's storage (e.g., table) exists. Called lazily before first write. */
  ensureModel(model: string, dimensions: number): Promise<void>

  /** Upsert chunks for a document into the vector store. */
  upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void>
  delete(model: string, filter: ChunkFilter): Promise<void>

  search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]>
  hybridSearch?(model: string, embedding: number[], query: string, opts: SearchOpts): Promise<ScoredChunk[]>
  countChunks(model: string, filter: ChunkFilter): Promise<number>

  hashStore: HashStoreAdapter

  // --- Document record methods (optional - adapters that support documents implement these) ---

  /** Create or update a document record. Returns the document with its UUID. */
  upsertDocumentRecord?(input: UpsertDocumentInput): Promise<typegraphDocument>
  /** Get a document by UUID. */
  getDocument?(id: string): Promise<typegraphDocument | null>
  /** List documents matching a filter. Supports optional pagination. */
  listDocuments?(filter: DocumentFilter, pagination?: PaginationOpts): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>>
  /** Delete documents matching a filter. Returns count deleted. */
  deleteDocuments?(filter: DocumentFilter): Promise<number>
  /** Update a document's status and optionally its chunk count. */
  updateDocumentStatus?(id: string, status: DocumentStatus, chunkCount?: number): Promise<void>
  /** Update document metadata fields (title, url, visibility, etc.). Returns updated document. */
  updateDocument?(id: string, input: Partial<Pick<typegraphDocument, 'title' | 'url' | 'visibility' | 'documentType' | 'sourceType' | 'metadata'>>): Promise<typegraphDocument>

  /** Hybrid search with document-level filtering via JOIN to typegraph_documents. */
  searchWithDocuments?(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts & { documentFilter?: DocumentFilter | undefined }
  ): Promise<ScoredChunkWithDocument[]>

  /** Fetch chunks by document and index range (for neighbor expansion). No vector search. */
  getChunksByRange?(
    model: string,
    documentId: string,
    fromIndex: number,
    toIndex: number
  ): Promise<ScoredChunk[]>

  // --- Bucket persistence (optional - adapters that support persistence implement these) ---

  /** Create or update a bucket. */
  upsertBucket?(bucket: Bucket): Promise<Bucket>
  /** Get a bucket by ID. */
  getBucket?(id: string): Promise<Bucket | null>
  /** List buckets, optionally filtered by identity fields. Supports optional pagination. */
  listBuckets?(filter?: BucketListFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>>
  /** Delete a bucket by ID. */
  deleteBucket?(id: string): Promise<void>

}
