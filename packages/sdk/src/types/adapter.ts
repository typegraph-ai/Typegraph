import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from './chunk.js'
import type { typegraphSource, SourceFilter, SourceStatus, UpsertSourceInput, UpsertedSourceRecord } from './source.js'
import type { Bucket, BucketListFilter } from './bucket.js'
import type { PaginationOpts, PaginatedResult } from './pagination.js'
import type { Job, JobFilter, UpsertJobInput, JobStatusPatch } from './job.js'

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

export interface ScoredChunkWithSource extends ScoredChunk {
  source?: typegraphSource | undefined
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

  /** Upsert chunks for a source into the vector store. */
  upsertSourceChunks(model: string, chunks: EmbeddedChunk[]): Promise<void>
  delete(model: string, filter: ChunkFilter): Promise<void>

  search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]>
  hybridSearch?(model: string, embedding: number[], query: string, opts: SearchOpts): Promise<ScoredChunk[]>
  countChunks(model: string, filter: ChunkFilter): Promise<number>

  hashStore: HashStoreAdapter

  // --- Source record methods (optional - adapters that support sources implement these) ---

  /** Create or update a source record. Returns the canonical source row. */
  upsertSourceRecord?(input: UpsertSourceInput): Promise<UpsertedSourceRecord>
  /** Get a source by UUID. */
  getSource?(id: string): Promise<typegraphSource | null>
  /** List sources matching a filter. Supports optional pagination. */
  listSources?(filter: SourceFilter, pagination?: PaginationOpts): Promise<typegraphSource[] | PaginatedResult<typegraphSource>>
  /** Delete sources matching a filter. Returns count deleted. */
  deleteSources?(filter: SourceFilter): Promise<number>
  /** Update a source's status and optionally its chunk count. */
  updateSourceStatus?(id: string, status: SourceStatus, chunkCount?: number): Promise<void>
  /** Update source metadata fields (title, url, visibility, subject, etc.). Returns updated source. */
  updateSource?(id: string, input: Partial<Pick<typegraphSource, 'title' | 'url' | 'visibility' | 'metadata' | 'subject'>>): Promise<typegraphSource>

  // --- Job record methods (optional - adapters that persist job state implement these) ---

  /** Create or replace a job row. Callers provide the id (e.g. an Inngest run id). */
  upsertJob?(input: UpsertJobInput): Promise<Job>
  /** Fetch a job by id. */
  getJob?(id: string): Promise<Job | null>
  /** List jobs matching a filter, ordered by created_at DESC. */
  listJobs?(filter: JobFilter, pagination?: PaginationOpts): Promise<Job[] | PaginatedResult<Job>>
  /** Apply a partial status/result/error/progress patch to a job. */
  updateJobStatus?(id: string, patch: JobStatusPatch): Promise<void>
  /** Atomically add to a job's progress_processed counter. Safe under concurrent workers. */
  incrementJobProgress?(id: string, processedDelta: number): Promise<void>

  /** Hybrid search with source-level filtering via JOIN to typegraph_sources. */
  searchWithSources?(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts & { sourceFilter?: SourceFilter | undefined }
  ): Promise<ScoredChunkWithSource[]>

  /** Fetch chunks by source and index range (for neighbor expansion). No vector search. */
  getChunksByRange?(
    model: string,
    sourceId: string,
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
  listBuckets?(filter?: BucketListFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>>
  /** Delete a bucket by ID. */
  deleteBucket?(id: string): Promise<void>

}
