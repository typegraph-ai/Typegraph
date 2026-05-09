import type { AccessScope } from './identity.js'

export type DocumentStatus = 'pending' | 'processing' | 'complete' | 'failed'

export interface DocumentInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id?: string | undefined
  name: string
  description?: string | undefined
  content: string
  updatedAt?: Date | undefined
  url?: string | null | undefined
  createdAt?: Date | undefined
  mimeType?: string | undefined
  language?: string | undefined
  metadata?: TMeta | undefined
}

export interface Chunk {
  content: string
  chunkIndex: number
  metadata?: Record<string, unknown> | undefined
}

export interface ChunkOpts {
  chunkSize: number
  chunkOverlap: number
}

export interface typegraphDocument {
  id: string
  bucketId: string
  tenantId: string
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  name: string
  description?: string | undefined
  url?: string | undefined
  contentHash: string
  chunkCount: number
  status: DocumentStatus
  accessScope?: AccessScope | undefined
  indexedAt: Date
  createdAt: Date
  updatedAt: Date
  metadata: Record<string, unknown>
}

export interface UpsertedDocumentRecord extends typegraphDocument {
  wasCreated?: boolean | undefined
}

export interface DocumentFilter {
  bucketId?: string | undefined
  status?: DocumentStatus | DocumentStatus[] | undefined
  documentIds?: string[] | undefined
}

export interface DocumentStorageFilter extends DocumentFilter {
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  accessScope?: AccessScope | undefined
}

export interface UpsertDocumentInput {
  id: string
  bucketId: string
  tenantId: string
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  name: string
  description?: string | undefined
  url?: string | undefined
  contentHash: string
  chunkCount: number
  status: DocumentStatus
  accessScope?: AccessScope | undefined
  metadata?: Record<string, unknown> | undefined
}
