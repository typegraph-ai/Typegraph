export interface EmbeddedChunk {
  id: string
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

  /**
   * Denormalized from the parent document. Chunks are the query target, so the
   * visibility gate has to live here or unscoped queries leak narrowly-visible
   * rows. Defaults to 'tenant' when omitted.
   */
  visibility?: import('./typegraph-document.js').Visibility | undefined

  metadata: Record<string, unknown>
  indexedAt: Date
}

export interface ChunkRef {
  bucketId: string
  documentId: string
  chunkIndex: number
  embeddingModel?: string | undefined
  chunkId?: string | undefined
}

export interface ChunkFilter {
  bucketId?: string | undefined
  /** Filter to any of several buckets. Preferred over `bucketId` when searching multiple. */
  bucketIds?: string[] | undefined
  /** Restrict search to exact chunk identities. Empty array intentionally matches nothing. */
  chunkRefs?: ChunkRef[] | undefined
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
