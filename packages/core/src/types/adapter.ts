import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from './document.js'
import type { d8umDocument, DocumentFilter, DocumentStatus, UpsertDocumentInput } from './d8um-document.js'
import type { DocumentJobRelation, DocumentJobRelationFilter } from './document-job-relation.js'
import type { Bucket } from './bucket.js'
import type { Job, JobRun } from './job.js'

export interface SearchOpts {
  count: number
  filter?: ChunkFilter | undefined
  approximate?: boolean | undefined
  iterativeScan?: boolean | undefined
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
  set(key: string, record: HashRecord): Promise<void>
  delete(key: string): Promise<void>
  listByBucket(bucketId: string, tenantId?: string | undefined): Promise<HashRecord[]>
  getLastRunTime(bucketId: string, tenantId?: string | undefined): Promise<Date | null>
  setLastRunTime(bucketId: string, tenantId: string | undefined, time: Date): Promise<void>
  deleteByBucket(bucketId: string, tenantId?: string | undefined): Promise<void>
}

export interface ScoredChunkWithDocument extends ScoredChunk {
  document?: d8umDocument | undefined
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

  /** Drop all d8um tables. Refuses if any table contains data. */
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
  upsertDocumentRecord?(input: UpsertDocumentInput): Promise<d8umDocument>
  /** Get a document by UUID. */
  getDocument?(id: string): Promise<d8umDocument | null>
  /** List documents matching a filter. */
  listDocuments?(filter: DocumentFilter): Promise<d8umDocument[]>
  /** Delete documents matching a filter. Returns count deleted. */
  deleteDocuments?(filter: DocumentFilter): Promise<number>
  /** Update a document's status and optionally its chunk count. */
  updateDocumentStatus?(id: string, status: DocumentStatus, chunkCount?: number): Promise<void>

  /** Hybrid search with document-level filtering via JOIN to d8um_documents. */
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

  // --- Document-Job relation storage (optional) ---

  /** Create or update a document-job relation. */
  upsertDocumentJobRelation?(relation: DocumentJobRelation): Promise<void>
  /** Get document-job relations matching a filter. */
  getDocumentJobRelations?(filter: DocumentJobRelationFilter): Promise<DocumentJobRelation[]>
  /** Delete all relations for a given job. */
  deleteDocumentJobRelations?(filter: { jobId: string }): Promise<void>
  /** Get document IDs where the given job is the ONLY related job (orphaned on job delete). */
  getOrphanedDocumentIds?(jobId: string): Promise<string[]>

  // --- Bucket persistence (optional - adapters that support persistence implement these) ---

  /** Create or update a bucket. */
  upsertBucket?(bucket: Bucket): Promise<Bucket>
  /** Get a bucket by ID. */
  getBucket?(id: string): Promise<Bucket | null>
  /** List buckets, optionally filtered by tenant. */
  listBuckets?(tenantId?: string): Promise<Bucket[]>
  /** Delete a bucket by ID. */
  deleteBucket?(id: string): Promise<void>

  // --- Job persistence (optional) ---

  /** Create or update a job instance. */
  upsertJob?(job: Job): Promise<Job>
  /** Get a job by ID. */
  getJob?(id: string): Promise<Job | null>
  /** List jobs matching an optional filter. */
  listJobs?(filter?: { bucketId?: string; type?: string; tenantId?: string; status?: string }): Promise<Job[]>
  /** Delete a job by ID. */
  deleteJob?(id: string): Promise<void>

  // --- Job run history (optional) ---

  /** Record a job execution. */
  createJobRun?(run: JobRun): Promise<JobRun>
  /** Update a running job's status/result. */
  updateJobRun?(id: string, update: Partial<JobRun>): Promise<void>
  /** List run history for a job, most recent first. */
  listJobRuns?(jobId: string, limit?: number): Promise<JobRun[]>
}
