export type QueryMode = 'fast' | 'hybrid' | 'memory' | 'neural' | 'auto'

export interface d8umQuery {
  text: string
  buckets?: string[] | undefined
  count?: number | undefined
  filters?: Record<string, unknown> | undefined
}

export interface d8umResult {
  content: string

  score: number
  scores: {
    vector?: number | undefined
    keyword?: number | undefined
    rrf?: number | undefined
  }

  bucket: {
    id: string
    documentId: string
    title: string
    url?: string | undefined
    updatedAt: Date
    status?: string | undefined
    scope?: string | undefined
    documentType?: string | undefined
    sourceType?: string | undefined
    userId?: string | undefined
    groupId?: string | undefined
  }

  chunk: {
    index: number
    total: number
    isNeighbor: boolean
  }

  metadata: Record<string, unknown>
  tenantId?: string | undefined
}

export interface QueryOpts {
  /** Retrieval strategy. Default: 'hybrid'. */
  mode?: QueryMode | undefined
  buckets?: string[] | undefined
  count?: number | undefined
  filters?: Record<string, unknown> | undefined

  // Identity fields (per-call scoping)
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  sessionId?: string | undefined
  /** Filter results by document-level fields (status, scope, type, etc.). */
  documentFilter?: import('./d8um-document.js').DocumentFilter | undefined

  mergeStrategy?: 'rrf' | 'linear' | 'custom' | undefined
  mergeWeights?: {
    indexed?: number | undefined
    live?: number | undefined
    cached?: number | undefined
    memory?: number | undefined
    graph?: number | undefined
  } | undefined

  timeouts?: {
    indexed?: number | undefined
    live?: number | undefined
    cached?: number | undefined
  } | undefined

  onBucketError?: 'omit' | 'warn' | 'throw' | undefined

  /** Point-in-time query: only return results valid at this timestamp */
  temporalAt?: Date | undefined
  /** Include invalidated/expired results. Default: false */
  includeInvalidated?: boolean | undefined
}

export interface QueryResponse {
  results: d8umResult[]
  buckets: Record<string, {
    mode: 'indexed' | 'live' | 'cached'
    resultCount: number
    durationMs: number
    status: 'ok' | 'timeout' | 'error'
    error?: Error | undefined
  }>
  query: {
    text: string
    tenantId?: string | undefined
    durationMs: number
    mergeStrategy: string
  }
  warnings?: string[] | undefined
}

export interface AssembleOpts {
  format?: 'xml' | 'markdown' | 'plain' | ((results: d8umResult[]) => string) | undefined
  maxTokens?: number | undefined
  citeBuckets?: boolean | undefined
  groupByBucket?: boolean | undefined
  neighborJoining?: boolean | undefined
}
