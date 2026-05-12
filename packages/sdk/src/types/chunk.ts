export interface EmbeddedChunk {
  id: string
  idempotencyKey: string
  bucketId: string
  tenantId: string
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphId: string
  /** ID referencing typegraph_documents.id. */
  documentId: string

  content: string
  embedding: number[]
  embeddingModel: string
  chunkIndex: number
  totalChunks: number

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
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphIds?: string[] | undefined
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
