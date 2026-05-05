import type { EntityResult, FactResult, GraphSearchOpts, GraphSearchTrace } from './graph-bridge.js'
import type { MemoryRecord } from '../memory/types/memory.js'
import type { ExternalId } from '../memory/types/memory.js'

export type QueryGraphOptions = GraphSearchOpts

export type ContextFormat = 'xml' | 'markdown' | 'plain'
export type ContextSection = 'facts' | 'entities' | 'chunks' | 'memories'

export interface QueryContextOptions {
  format?: ContextFormat | undefined
  sections?: ContextSection[] | undefined
  includeAttributes?: boolean | undefined
  maxTotalTokens?: number | undefined
  maxChunkTokens?: number | undefined
  maxFactTokens?: number | undefined
  maxEntityTokens?: number | undefined
  maxMemoryTokens?: number | undefined
}

export interface QueryContextStats {
  format: ContextFormat
  totalTokens: number
  truncated: boolean
  sections: Partial<Record<ContextSection, {
    available: number
    included: number
    tokens: number
    truncated: boolean
  }>>
}

/** Which retrieval signals to activate. All fields default to false except `semantic` which defaults to true. */
export interface QuerySignals {
  /** Semantic embedding search against chunk embeddings. Default: true */
  semantic?: boolean | undefined
  /** BM25 keyword search (requires adapter.hybridSearch). Default: false */
  keyword?: boolean | undefined
  /** PPR graph traversal via entity embeddings. Requires graph bridge. Default: false */
  graph?: boolean | undefined
  /** Cognitive memory recall. Requires graph bridge. Default: false */
  memory?: boolean | undefined
}

/** Raw algorithm-level scores — mixed ranges, not normalized */
export interface RawScores {
  cosineSimilarity?: number | undefined
  bm25?: number | undefined
  rrf?: number | undefined
  ppr?: number | undefined
  importance?: number | undefined
  /** Memory sub-signals — exposed for observability when memory signal is active */
  memorySimilarity?: number | undefined
  memoryImportance?: number | undefined
  memoryRecency?: number | undefined
}

/** Normalized capability-level scores — all 0-1, cross-query comparable */
export interface NormalizedScores {
  semantic?: number | undefined
  keyword?: number | undefined
  rrf?: number | undefined
  graph?: number | undefined
  memory?: number | undefined
}

export interface QueryChunkResult {
  content: string

  /** Composite score — the final ranking value regardless of mode (0-1) */
  score: number
  /** Algorithm-level raw scores and their normalized 0-1 counterparts */
  scores: {
    raw: RawScores
    normalized: NormalizedScores
  }
  /** Which retrieval systems contributed to this result (e.g. ["semantic"], ["semantic", "graph"]) */
  sources: string[]

  document: {
    id: string
    bucketId: string
    title: string
    url?: string | undefined
    updatedAt: Date
    status?: string | undefined
    visibility?: string | undefined
    tenantId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    conversationId?: string | undefined
  }

  chunk: {
    index: number
    total: number
  }

  metadata: Record<string, unknown>
  tenantId?: string | undefined
}

export type QueryMemoryRecord = Omit<MemoryRecord, 'embedding'>

export type QueryMemoryResult = QueryMemoryRecord & {
  score: number
  scores: {
    raw: RawScores
    normalized: NormalizedScores
  }
}

export interface QueryResults {
  chunks: QueryChunkResult[]
  facts: FactResult[]
  entities: EntityResult[]
  memories: QueryMemoryResult[]
  graphTrace?: GraphSearchTrace | undefined
}

export interface QueryEntityScope {
  entityIds?: string[] | undefined
  externalIds?: ExternalId[] | undefined
  mode?: 'filter' | 'boost' | undefined
}

export interface QueryOpts {
  /** Which retrieval signals to activate. Default: { semantic: true } (semantic-only search). */
  signals?: QuerySignals | undefined
  buckets?: string[] | undefined
  count?: number | undefined

  // Identity fields (per-call scoping)
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  /** Filter results by document-level fields (status, scope, type, etc.). */
  documentFilter?: import('./typegraph-document.js').DocumentFilter | undefined
  /** Relevance scope by TypeGraph entity IDs or deterministic external IDs. */
  entityScope?: QueryEntityScope | undefined

  /** Override composite score weights. Keys are signal names; values are 0-1 weights.
   *  When omitted, defaults are derived from active signals. */
  scoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>> | undefined

  /** When true, automatically adjust score weights based on query type classification.
   *  Uses pure heuristics (no LLM call) to detect factual-lookup, entity-centric,
   *  relational, temporal, or exploratory queries and applies optimized weight profiles.
   *  This never enables or disables retrieval signals; `signals` remains the source of truth.
   *  User-provided `scoreWeights` always override. Default: false. */
  autoWeights?: boolean | undefined

  /** Controls how graph results interact with indexed results.
   *  - 'off': include all graph results as-is (default)
   *  - 'prefer': boost matching results, but keep novel graph results at lower weight
   *  - 'only': keep graph results only if they also appear in indexed results */
  graphReinforcement?: 'only' | 'prefer' | 'off' | undefined

  /** Heterogeneous graph traversal options. */
  graph?: GraphSearchOpts | undefined

  /** Timeouts per retrieval signal (milliseconds). */
  timeouts?: {
    /** Timeout for semantic/keyword indexed search. Default: 30000. */
    indexed?: number | undefined
    /** Timeout for graph PPR traversal. Default: 30000. */
    graph?: number | undefined
    /** Timeout for memory recall. Default: 10000. */
    memory?: number | undefined
  } | undefined

  /** How to handle errors from individual buckets.
   *  - 'throw': abort query on any bucket error (default)
   *  - 'warn': continue with other buckets, add warning
   *  - 'omit': silently skip failed buckets */
  onBucketError?: 'omit' | 'warn' | 'throw' | undefined

  /** Point-in-time query: only return results indexed before this timestamp. */
  temporalAt?: Date | undefined
  /** Include invalidated/expired results (memories, graph edges). Default: false. */
  includeInvalidated?: boolean | undefined

  /** Build an LLM-ready context string from query results. When set, response includes `context`. */
  context?: true | QueryContextOptions | undefined

  /** OpenTelemetry trace ID for distributed tracing correlation. */
  traceId?: string | undefined
  /** OpenTelemetry span ID for distributed tracing correlation. */
  spanId?: string | undefined
}

export interface QueryResponse {
  results: QueryResults
  buckets: Record<string, {
    mode: 'indexed' | 'memory' | 'graph'
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
  /** Formatted context string. Present when `context` is specified in query opts. */
  context?: string | undefined
  contextStats?: QueryContextStats | undefined
  warnings?: string[] | undefined
}
