export interface EmbeddedChunk {
  idempotencyKey: string
  bucketId: string
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  /** UUID referencing typegraph_documents.id. */
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
  bucketId?: string | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  documentId?: string | undefined
  idempotencyKey?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ScoredChunk extends EmbeddedChunk {
  scores: {
    semantic?: number | undefined
    keyword?: number | undefined
    rrf?: number | undefined
  }
}
