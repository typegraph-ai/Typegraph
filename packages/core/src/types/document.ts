export interface EmbeddedChunk {
  idempotencyKey: string
  sourceId: string
  tenantId?: string | undefined
  documentId: string

  content: string
  embedding: number[]
  chunkIndex: number
  totalChunks: number

  metadata: Record<string, unknown>
  indexedAt: Date
}

export interface ChunkFilter {
  sourceId?: string | undefined
  tenantId?: string | undefined
  documentId?: string | undefined
  idempotencyKey?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ScoredChunk extends EmbeddedChunk {
  scores: {
    vector?: number | undefined
    keyword?: number | undefined
    rrf?: number | undefined
  }
}
