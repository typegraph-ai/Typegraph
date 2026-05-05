export interface EmbeddedChunk {
  id: string
  idempotencyKey: string
  bucketId: string
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  /** ID referencing typegraph_sources.id. */
  sourceId: string

  content: string
  embedding: number[]
  embeddingModel: string
  chunkIndex: number
  totalChunks: number

  /**
   * Denormalized from the parent source. Chunks are the query target, so the
   * visibility gate has to live here or unscoped queries leak narrowly-visible
   * rows. Defaults to 'tenant' when omitted.
   */
  visibility?: import('./source.js').Visibility | undefined

  metadata: Record<string, unknown>
  indexedAt: Date
}

export interface ChunkRef {
  bucketId: string
  sourceId: string
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
  sourceId?: string | undefined
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
