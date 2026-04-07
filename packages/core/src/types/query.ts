/** Which retrieval signals to activate. All fields default to false except `vector` which defaults to true. */
export interface QuerySignals {
  /** ANN vector search against chunk embeddings. Default: true */
  vector?: boolean | undefined
  /** BM25 keyword search (requires adapter.hybridSearch). Default: false */
  keyword?: boolean | undefined
  /** PPR graph traversal via entity embeddings. Requires graph bridge. Default: false */
  graph?: boolean | undefined
  /** Cognitive memory recall. Requires graph bridge. Default: false */
  memory?: boolean | undefined
}

export interface d8umQuery {
  text: string
  buckets?: string[] | undefined
  count?: number | undefined
  filters?: Record<string, unknown> | undefined
}

/** Raw algorithm-level scores — mixed ranges, not normalized */
export interface RawScores {
  cosineSimilarity?: number | undefined
  bm25?: number | undefined
  rrf?: number | undefined
  ppr?: number | undefined
  importance?: number | undefined
}

/** Normalized capability-level scores — all 0-1, cross-query comparable */
export interface NormalizedScores {
  semantic?: number | undefined
  keyword?: number | undefined
  rrf?: number | undefined
  graph?: number | undefined
  memory?: number | undefined
}

export interface d8umResult {
  content: string

  /** Composite score — the final ranking value regardless of mode (0-1) */
  score: number
  /** Algorithm-level raw scores and their normalized 0-1 counterparts */
  scores: {
    raw: RawScores
    normalized: NormalizedScores
  }
  /** Which retrieval systems contributed to this result (e.g. ["indexed"], ["indexed", "graph"]) */
  sources: string[]

  bucket: {
    id: string
    documentId: string
    title: string
    url?: string | undefined
    updatedAt: Date
    status?: string | undefined
    visibility?: string | undefined
    documentType?: string | undefined
    sourceType?: string | undefined
    tenantId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    conversationId?: string | undefined
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
  /** Which retrieval signals to activate. Default: { vector: true } (vector-only search). */
  signals?: QuerySignals | undefined
  buckets?: string[] | undefined
  count?: number | undefined
  filters?: Record<string, unknown> | undefined

  // Identity fields (per-call scoping)
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  /** Filter results by document-level fields (status, scope, type, etc.). */
  documentFilter?: import('./d8um-document.js').DocumentFilter | undefined

  /** Override composite score weights. Keys are signal names; values are 0-1 weights.
   *  When omitted, defaults are derived from active signals. */
  scoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>> | undefined

  /** Controls how graph results interact with indexed results.
   *  - 'only': keep graph results only if they also appear in indexed results (default)
   *  - 'prefer': boost matching results, but keep novel graph results at lower weight
   *  - 'off': include all graph results as-is */
  graphReinforcement?: 'only' | 'prefer' | 'off' | undefined

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

  /** OpenTelemetry trace ID for distributed tracing correlation. */
  traceId?: string | undefined
  /** OpenTelemetry span ID for distributed tracing correlation. */
  spanId?: string | undefined
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
