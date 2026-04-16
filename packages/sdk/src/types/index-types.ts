import type { RawDocument } from './connector.js'
import type { Visibility } from './typegraph-document.js'

/**
 * Options for an ingest() call.
 *
 * Single unified options bag. Fields fall into two groups:
 *
 * - **Bucket-mergeable** (inherit from `bucket.indexDefaults` when unset):
 *   `chunkSize`, `chunkOverlap`, `deduplicateBy`, `propagateMetadata`,
 *   `stripMarkdownForEmbedding`, `preprocessForEmbedding`, `visibility`,
 *   `documentType`, `sourceType`, `graphExtraction`.
 *
 * - **Runtime-only** (never inherit from bucket defaults):
 *   `bucketId`, `mode`, `tenantId`, `groupId`, `userId`, `agentId`, `conversationId`,
 *   `removeDeleted`, `dryRun`, `concurrency`, `onProgress`, `traceId`, `spanId`.
 */
export interface IngestOptions {
  // Targeting
  /** Target bucket. Defaults to the system default bucket. */
  bucketId?: string | undefined
  mode?: 'upsert' | 'replace' | undefined

  // Identity (runtime only)
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined

  // Chunking (bucket-mergeable)
  chunkSize?: number | undefined
  chunkOverlap?: number | undefined

  // Document properties (bucket-mergeable)
  /** Access visibility for documents from this ingest call. */
  visibility?: Visibility | undefined
  /** App-specific document type (e.g. 'pdf', 'webpage'). */
  documentType?: string | undefined
  /** App-specific source type (e.g. 'upload', 'web_scrape'). */
  sourceType?: string | undefined

  // Processing (bucket-mergeable)
  deduplicateBy?: string[] | ((doc: RawDocument) => string) | undefined
  propagateMetadata?: string[] | undefined
  /** If true, strip markdown syntax from chunk content before embedding. Original content is stored as-is. */
  stripMarkdownForEmbedding?: boolean | undefined
  /** Custom preprocessing function for embedding. Overrides stripMarkdownForEmbedding. */
  preprocessForEmbedding?: ((content: string) => string) | undefined

  // Extraction control (bucket-mergeable)
  /**
   * Per-call override for graph extraction. When unspecified, falls back to the bucket's
   * `indexDefaults.graphExtraction`, then to false. Requires the instance to be configured
   * with `llm` and `knowledgeGraph` if set to true — otherwise ingest throws ConfigError.
   */
  graphExtraction?: boolean | undefined

  // Batch behavior (runtime only)
  removeDeleted?: boolean | undefined
  dryRun?: boolean | undefined
  /** Max concurrent documents to process. Default: 1 (sequential). Higher values speed up LLM-heavy pipelines like neural. */
  concurrency?: number | undefined
  onProgress?: ((event: IndexProgressEvent) => void) | undefined

  // Tracing (runtime only)
  /** OpenTelemetry trace ID for distributed tracing correlation. */
  traceId?: string | undefined
  /** OpenTelemetry span ID for distributed tracing correlation. */
  spanId?: string | undefined
}

export interface IndexProgressEvent {
  phase: 'fetch' | 'hash_check' | 'embed' | 'store' | 'prune'
  bucketId: string
  tenantId?: string | undefined
  total: number
  done: number
  skipped: number
  updated: number
  inserted: number
  pruned: number
  failed: number
  current?: {
    idempotencyKey: string
    reason: 'new' | 'hash_changed' | 'forced' | 'skipped'
  } | undefined
}

export interface IndexResult {
  /** Job ID for tracking async operations (present in cloud mode). */
  jobId?: string | undefined
  bucketId: string
  tenantId?: string | undefined
  mode: 'upsert' | 'replace'
  total: number
  skipped: number
  updated: number
  inserted: number
  pruned: number
  failedAt?: {
    idempotencyKey: string
    phase: 'fetch' | 'embed' | 'store' | 'hash_write'
    error: Error
  } | undefined
  durationMs: number
  /** 'accepted' in cloud mode (async), 'complete' in self-hosted mode (sync). */
  status?: 'accepted' | 'complete' | undefined
  /** Triple extraction stats (present when graph is configured). */
  extraction?: {
    /** Number of chunks where extraction succeeded. */
    succeeded: number
    /** Number of chunks where extraction failed (errors swallowed). */
    failed: number
    /** Details of failed chunks (capped at 100 entries). */
    failedChunks?: ExtractionFailure[]
  } | undefined
}

export interface ExtractionFailure {
  documentId: string
  chunkIndex: number
  reason: 'timeout' | 'error'
  message?: string
}

export class IndexError extends Error {
  constructor(
    message: string,
    public readonly result: IndexResult,
    public readonly cause: Error
  ) {
    super(message)
    this.name = 'IndexError'
  }
}
