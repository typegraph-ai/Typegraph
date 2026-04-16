export type DocumentStatus = 'pending' | 'processing' | 'complete' | 'failed'

/** Who can access this record. Defines the narrowest identity level that grants access. */
export type Visibility = 'tenant' | 'group' | 'user' | 'agent' | 'conversation'

export interface typegraphDocument {
  /** UUID primary key. */
  id: string
  /** The typegraph source that produced this document. */
  bucketId: string
  /** Multi-tenant isolation. Maps to organization_id in many apps. */
  tenantId?: string | undefined
  /** Team, channel, or project. */
  groupId?: string | undefined
  /** Owner/creator of the document. */
  userId?: string | undefined
  /** Specific agent instance. */
  agentId?: string | undefined
  /** Conversation thread. */
  conversationId?: string | undefined
  title: string
  url?: string | undefined
  /** SHA256 of raw content at index time. Used for change detection. */
  contentHash: string
  chunkCount: number
  status: DocumentStatus
  /** Access visibility. Defines who can see this document. Default: 'tenant'. */
  visibility?: Visibility | undefined
  /** App-specific document type (e.g. 'pdf', 'csv', 'webpage'). */
  documentType?: string | undefined
  /** App-specific source type (e.g. 'upload', 'web_scrape', 'api'). */
  sourceType?: string | undefined
  /**
   * Whether triple extraction was run against this document during ingestion.
   * Reflects "we ran extraction", not "extraction found entities" — partial failures
   * still count as true. See IndexResult.extraction for success/failure breakdown.
   */
  graphExtracted: boolean
  indexedAt: Date
  createdAt: Date
  updatedAt: Date
  metadata: Record<string, unknown>
}

export interface DocumentFilter {
  bucketId?: string | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  status?: DocumentStatus | DocumentStatus[] | undefined
  visibility?: Visibility | Visibility[] | undefined
  documentType?: string | string[] | undefined
  sourceType?: string | string[] | undefined
  documentIds?: string[] | undefined
  /** Filter documents by whether triple extraction ran during ingestion. */
  graphExtracted?: boolean | undefined
}

export interface UpsertDocumentInput {
  /** Prefixed document ID (e.g. doc_550e8400...). Must be provided by caller. */
  id: string
  bucketId: string
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  title: string
  url?: string | undefined
  contentHash: string
  chunkCount: number
  status: DocumentStatus
  visibility?: Visibility | undefined
  documentType?: string | undefined
  sourceType?: string | undefined
  /** Whether triple extraction ran against this document. Defaults to false. */
  graphExtracted?: boolean | undefined
  metadata?: Record<string, unknown> | undefined
}
