export type DocumentStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type DocumentScope = 'tenant' | 'folder' | 'user'

export interface d8umDocument {
  /** UUID primary key. */
  id: string
  /** The d8um source that produced this document. */
  sourceId: string
  /** Multi-tenant isolation. Maps to organization_id in many apps. */
  tenantId?: string | undefined
  title: string
  url?: string | undefined
  /** SHA256 of raw content at index time. Used for change detection. */
  contentHash: string
  chunkCount: number
  status: DocumentStatus
  /** Access scope. Optional — not all apps need scoped access. */
  scope?: DocumentScope | undefined
  /** UUID. For folder-scoped documents. */
  folderId?: string | undefined
  /** UUID. Owner/creator of the document. */
  userId?: string | undefined
  /** App-specific document type (e.g. 'pdf', 'csv', 'webpage'). */
  documentType?: string | undefined
  /** App-specific source type (e.g. 'upload', 'web_scrape', 'api'). */
  sourceType?: string | undefined
  indexedAt: Date
  createdAt: Date
  updatedAt: Date
  metadata: Record<string, unknown>
}

export interface DocumentFilter {
  sourceId?: string | undefined
  tenantId?: string | undefined
  status?: DocumentStatus | DocumentStatus[] | undefined
  scope?: DocumentScope | DocumentScope[] | undefined
  userId?: string | undefined
  folderId?: string | undefined
  documentType?: string | string[] | undefined
  sourceType?: string | string[] | undefined
  documentIds?: string[] | undefined
}

export interface UpsertDocumentInput {
  sourceId: string
  tenantId?: string | undefined
  title: string
  url?: string | undefined
  contentHash: string
  chunkCount: number
  status: DocumentStatus
  scope?: DocumentScope | undefined
  folderId?: string | undefined
  userId?: string | undefined
  documentType?: string | undefined
  sourceType?: string | undefined
  metadata?: Record<string, unknown> | undefined
}
