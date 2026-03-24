export interface d8umQuery {
  text: string
  sources?: string[] | undefined
  topK?: number | undefined
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

  source: {
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
    folderId?: string | undefined
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
  sources?: string[] | undefined
  topK?: number | undefined
  tenantId?: string | undefined
  filters?: Record<string, unknown> | undefined
  /** Filter results by document-level fields (status, scope, type, etc.). */
  documentFilter?: import('./d8um-document.js').DocumentFilter | undefined

  mergeStrategy?: 'rrf' | 'linear' | 'custom' | undefined
  mergeWeights?: {
    indexed?: number | undefined
    live?: number | undefined
    cached?: number | undefined
  } | undefined

  timeouts?: {
    indexed?: number | undefined
    live?: number | undefined
    cached?: number | undefined
  } | undefined

  onSourceError?: 'omit' | 'warn' | 'throw' | undefined
}

export interface QueryResponse {
  results: d8umResult[]
  sources: Record<string, {
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
  citeSources?: boolean | undefined
  groupBySource?: boolean | undefined
  neighborJoining?: boolean | undefined
}
