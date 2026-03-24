export interface EmbeddedChunk {
  idempotencyKey: string
  sourceId: string
  tenantId?: string | undefined
  /** UUID referencing d8um_documents.id. */
  documentId: string

  content: string
  embedding: number[]
  embeddingModel: string
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
