import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from './chunk.js'
import type { DocumentFilter, DocumentStatus, DocumentStorageFilter, typegraphDocument, UpsertDocumentInput, UpsertedDocumentRecord } from './document.js'
import type { EventStorageFilter, typegraphEventRecord, UpsertEventInput } from './event.js'
import type { ThreadStorageFilter, typegraphThread, UpsertThreadInput } from './thread.js'
import type { UpsertLinkInput } from './link.js'
import type { Bucket, BucketStorageFilter } from './bucket.js'
import type { PaginationOpts, PaginatedResult } from './pagination.js'
import type { Job, JobFilter, UpsertJobInput, JobStatusPatch } from './job.js'
import type { MemoryStoreAdapter } from '../memory/types/adapter.js'

export interface SearchOpts {
  count: number
  filter?: ChunkFilter | undefined
  approximate?: boolean | undefined
  iterativeScan?: boolean | undefined
  /** Internal indexed-search signal selection. Defaults to semantic-only for search(), semantic+keyword for hybridSearch(). */
  signals?: { semantic?: boolean | undefined; keyword?: boolean | undefined } | undefined
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
  getTable?(model: string): string | Promise<string>
  createMemoryStore?(config?: { embeddingDimensions?: number | undefined }): MemoryStoreAdapter

  /** Upsert chunks for a document into the vector store. */
  upsertDocumentChunks(model: string, chunks: EmbeddedChunk[]): Promise<void>
  delete(model: string, filter: ChunkFilter | null): Promise<void>

  search(model: string, embedding: number[], opts: SearchOpts | null): Promise<ScoredChunk[]>
  hybridSearch?(model: string, embedding: number[], query: string, opts: SearchOpts | null): Promise<ScoredChunk[]>
  countChunks(model: string, filter: ChunkFilter | null): Promise<number>

  hashStore: HashStoreAdapter

  // --- Document record methods (optional - adapters that support documents implement these) ---

  /** Create or update a document record. Returns the canonical document row. */
  upsertDocumentRecord?(input: UpsertDocumentInput): Promise<UpsertedDocumentRecord>
  /** Get a document by ID. */
  getDocument?(id: string): Promise<typegraphDocument | null>
  /** List documents matching a filter. Supports optional pagination. */
  listDocuments?(filter?: DocumentStorageFilter | null, pagination?: PaginationOpts | null): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>>
  /** Delete documents matching a filter. Returns count deleted. */
  deleteDocuments?(filter: DocumentStorageFilter | null): Promise<number>
  /** Update a document's status and optionally its chunk count. */
  updateDocumentStatus?(id: string, status: DocumentStatus, chunkCount?: number): Promise<void>
  /** Update document metadata fields. Returns updated document. */
  updateDocument?(id: string, input: Partial<Pick<typegraphDocument, 'name' | 'description' | 'url' | 'accessScope' | 'metadata'>>): Promise<typegraphDocument>

  upsertEvent?(input: UpsertEventInput): Promise<typegraphEventRecord>
  getEvent?(tenantId: string, id: string): Promise<typegraphEventRecord | null>
  listEvents?(filter?: EventStorageFilter | null): Promise<typegraphEventRecord[]>
  upsertThread?(input: UpsertThreadInput): Promise<typegraphThread>
  getThread?(tenantId: string, id: string): Promise<typegraphThread | null>
  listThreads?(filter?: ThreadStorageFilter | null): Promise<typegraphThread[]>
  upsertLink?(input: UpsertLinkInput): Promise<void>

  // --- Job record methods (optional - adapters that persist job state implement these) ---

  /** Create or replace a job row. Callers provide the id (e.g. an Inngest run id). */
  upsertJob?(input: UpsertJobInput): Promise<Job>
  /** Fetch a job by id. */
  getJob?(id: string): Promise<Job | null>
  /** List jobs matching a filter, ordered by created_at DESC. */
  listJobs?(filter?: JobFilter | null, pagination?: PaginationOpts | null): Promise<Job[] | PaginatedResult<Job>>
  /** Apply a partial status/result/error/progress patch to a job. */
  updateJobStatus?(id: string, patch: JobStatusPatch): Promise<void>
  /** Atomically add to a job's progress_processed counter. Safe under concurrent workers. */
  incrementJobProgress?(id: string, processedDelta: number): Promise<void>

  /** Hybrid search with document-level filtering via JOIN to typegraph_documents. */
  searchWithDocuments?(
    model: string,
    embedding: number[],
    query: string,
    opts: (SearchOpts & { documentFilter?: DocumentStorageFilter | undefined }) | null
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
  /** Get multiple buckets by ID in a single round-trip. Missing ids are simply absent from the result. */
  getBuckets?(ids: string[]): Promise<Bucket[]>
  /** List buckets, optionally filtered by identity fields. Supports optional pagination. */
  listBuckets?(filter?: BucketStorageFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>>
  /** Delete a bucket by ID. */
  deleteBucket?(id: string): Promise<void>

}
