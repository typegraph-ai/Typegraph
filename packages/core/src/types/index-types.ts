export interface IndexOpts {
  /** Target bucket. Defaults to the system default bucket. */
  bucketId?: string | undefined
  mode?: 'upsert' | 'replace' | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  visibility?: import('./typegraph-document.js').Visibility | undefined
  removeDeleted?: boolean | undefined
  dryRun?: boolean | undefined
  onProgress?: ((event: IndexProgressEvent) => void) | undefined
  /** Max concurrent documents to process. Default: 1 (sequential). Higher values speed up LLM-heavy pipelines like neural. */
  concurrency?: number | undefined
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
  } | undefined
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
