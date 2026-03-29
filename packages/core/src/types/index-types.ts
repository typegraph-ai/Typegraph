export interface IndexOpts {
  mode?: 'upsert' | 'replace' | undefined
  tenantId?: string | undefined
  removeDeleted?: boolean | undefined
  dryRun?: boolean | undefined
  onProgress?: ((event: IndexProgressEvent) => void) | undefined
  /** Max concurrent documents to process. Default: 1 (sequential). Higher values speed up LLM-heavy pipelines like neural. */
  concurrency?: number | undefined
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
