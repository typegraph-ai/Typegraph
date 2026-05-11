import type { EntityResult, FactResult, GraphSearchOpts, GraphSearchTrace } from './graph-bridge.js'
import type { ExternalId } from '../memory/types/memory.js'
import type { TypeGraphContext } from './identity.js'
import type { DocumentFilter } from './document.js'

export type QueryGraphOptions = GraphSearchOpts

export type PromptFormat = 'xml' | 'markdown' | 'plain'
export type PromptSection = 'facts' | 'entities' | 'chunks'

export interface PromptBuilderOptions {
  format?: PromptFormat | undefined
  sections?: PromptSection[] | undefined
  includeAttributes?: boolean | undefined
  maxTotalTokens?: number | undefined
  maxChunkTokens?: number | undefined
  maxFactTokens?: number | undefined
  maxEntityTokens?: number | undefined
}

export interface PromptStats {
  format: PromptFormat
  totalTokens: number
  truncated: boolean
  sections: Partial<Record<PromptSection, {
    available: number
    included: number
    tokens: number
    truncated: boolean
  }>>
}

export type SearchResource =
  | 'documents'
  | 'events'
  | 'threads'
  | 'entities'
  | 'facts'

export type SearchWeights = {
  semantic?: number | false | undefined
  bm25?: number | false | undefined
  graph?: number | false | undefined
  recency?: number | false | undefined
}

export type SearchFusion = {
  method?: 'rrf' | undefined
  k?: number | undefined
}

export type SearchRerankOptions =
  | boolean
  | {
      topK?: number | undefined
      domain?: 'general' | 'legal' | 'code' | 'medical' | undefined
    }

export interface SearchExplanation {
  requestedGraph: string
  graphClosure: string[]
  deniedGraphs?: string[] | undefined
  activeResources: SearchResource[]
  activeWeights: Required<Record<keyof SearchWeights, number | false>>
  fusion: Required<SearchFusion>
  candidateCounts: Partial<Record<SearchResource, number>>
  timings: Record<string, number>
  graphTrace?: GraphSearchTrace | undefined
  warnings?: string[] | undefined
  skippedResources?: Partial<Record<SearchResource, string>> | undefined
}

/** Internal retrieval switches derived from public resources/weights. */
export interface RetrievalSwitches {
  /** Semantic embedding search against chunk embeddings. Default: true */
  semantic?: boolean | undefined
  /** BM25 keyword search (requires adapter.hybridSearch). */
  keyword?: boolean | undefined
  /** PPR graph traversal via entity embeddings. Requires graph storage. */
  graph?: boolean | undefined
  /** Recency score. */
  recency?: boolean | undefined
}

/** Raw algorithm-level scores — mixed ranges, not normalized */
export interface RawScores {
  cosineSimilarity?: number | undefined
  bm25?: number | undefined
  rrf?: number | undefined
  ppr?: number | undefined
  importance?: number | undefined
  recency?: number | undefined
}

/** Normalized capability-level scores — all 0-1, cross-query comparable */
export interface NormalizedScores {
  semantic?: number | undefined
  keyword?: number | undefined
  rrf?: number | undefined
  graph?: number | undefined
  recency?: number | undefined
}

export interface OutputScores {
  semantic?: number | undefined
  bm25?: number | undefined
  graph?: number | undefined
  recency?: number | undefined
  fused: number
  reranker?: number | undefined
}

export interface QueryChunkResult {
  content: string

  /** Composite score — the final ranking value regardless of mode (0-1) */
  score: number
  /** Algorithm-level raw scores and their normalized 0-1 counterparts */
  scores: {
    raw: RawScores
    normalized: NormalizedScores
    output: OutputScores
  }
  /** Which retrieval systems contributed to this result (e.g. ["semantic"], ["semantic", "graph"]) */
  matchedBy: string[]

  document: {
    id: string
    bucketId: string
    graph: string
    name: string
    description?: string | undefined
    url?: string | undefined
    updatedAt: Date
    status?: string | undefined
  }

  chunk: {
    index: number
    total: number
  }

  metadata: Record<string, unknown>
}

export interface QueryResults {
  chunks: QueryChunkResult[]
  facts: FactResult[]
  entities: EntityResult[]
  graphTrace?: GraphSearchTrace | undefined
}

export interface QueryEntityScope {
  entityIds?: string[] | undefined
  externalIds?: ExternalId[] | undefined
  mode?: 'filter' | 'boost' | undefined
}

export interface SearchOptions {
  graph?: string | undefined
  /** Internal resolved graph closure. Public callers should pass `graph`, not this field. */
  graphIds?: string[] | undefined
  context?: TypeGraphContext | undefined
  resources?: SearchResource[] | undefined
  weights?: SearchWeights | undefined
  fusion?: SearchFusion | undefined
  rerank?: SearchRerankOptions | undefined
  buckets?: string[] | undefined
  limit?: number | undefined
  offset?: number | undefined
  abortSignal?: AbortSignal | undefined

  /** Filter results by document-level fields. */
  documentFilter?: DocumentFilter | undefined
  /** Relevance scope by TypeGraph entity IDs or deterministic external IDs. */
  entityScope?: QueryEntityScope | undefined

  /** When true, automatically adjust score weights based on query type classification.
   *  Uses pure heuristics (no LLM call) to detect factual-lookup, entity-centric,
   *  relational, temporal, or exploratory queries and applies optimized weight profiles.
   *  This never enables or disables resources; `resources` remains the source of truth.
   *  User-provided `weights` always override. Default: false. */
  autoWeights?: boolean | undefined

  /** Controls how graph results interact with indexed results.
   *  - 'off': include all graph results as-is (default)
   *  - 'prefer': boost matching results, but keep novel graph results at lower weight
   *  - 'only': keep graph results only if they also appear in indexed results */
  graphReinforcement?: 'only' | 'prefer' | 'off' | undefined

  /** Heterogeneous graph traversal options. */
  graphOptions?: GraphSearchOpts | undefined

  /** Timeouts per retrieval path (milliseconds). */
  timeouts?: {
    /** Timeout for semantic/keyword indexed search. Default: 30000. */
    indexed?: number | undefined
    /** Timeout for graph PPR traversal. Default: 30000. */
    graph?: number | undefined
  } | undefined

  /** How to handle errors from individual buckets.
   *  - 'throw': abort query on any bucket error (default)
   *  - 'warn': continue with other buckets, add warning
   *  - 'omit': silently skip failed buckets */
  onBucketError?: 'omit' | 'warn' | 'throw' | undefined

  /** Point-in-time query: only return results indexed before this timestamp. */
  asOf?: Date | 'now' | undefined
  validBetween?: [Date, Date] | undefined
  /** Include invalidated/expired graph edges. Default: false. */
  includeInvalidated?: boolean | undefined

  /** Build an LLM-ready prompt string from query results. When set, response includes `prompt`. */
  promptBuilder?: true | PromptBuilderOptions | undefined
  explain?: boolean | undefined
}

export interface QueryResponse {
  results: QueryResults
  buckets: Record<string, {
    mode: 'indexed' | 'graph'
    resultCount: number
    durationMs: number
    status: 'ok' | 'timeout' | 'error'
    error?: Error | undefined
  }>
  query: {
    text: string
    durationMs: number
    mergeStrategy: string
  }
  /** Formatted prompt string. Present when `promptBuilder` is specified in search opts. */
  prompt?: string | undefined
  promptStats?: PromptStats | undefined
  explanation?: SearchExplanation | undefined
  warnings?: string[] | undefined
}
