import type { SourceSubject } from './connector.js'

export type SourceStatus = 'pending' | 'processing' | 'complete' | 'failed'

/** Who can access this record. Defines the narrowest identity level that grants access. */
export type Visibility = 'tenant' | 'group' | 'user' | 'agent' | 'conversation'

export interface typegraphSource {
  /** UUID primary key. */
  id: string
  /** The bucket that owns this source. */
  bucketId: string
  /** Multi-tenant isolation. Maps to organization_id in many apps. */
  tenantId?: string | undefined
  /** Team, channel, or project. */
  groupId?: string | undefined
  /** Owner/creator of the source. */
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
  status: SourceStatus
  /**
   * Access visibility. Controls which queries can see this source.
   * `undefined`/NULL means public — visible to any query, including unscoped ones.
   * A value of `'tenant' | 'group' | 'user' | 'agent' | 'conversation'` restricts
   * access to queries that supply a matching identity at that level.
   */
  visibility?: Visibility | undefined
  /**
   * Whether triple extraction was run against this source during ingestion.
   * Reflects "we ran extraction", not "extraction found entities" — partial failures
   * still count as true. See IndexResult.extraction for success/failure breakdown.
   */
  graphExtracted: boolean
  indexedAt: Date
  createdAt: Date
  updatedAt: Date
  metadata: Record<string, unknown>
  /** Optional semantic entity this source is primary evidence for. */
  subject?: SourceSubject | undefined
}

export interface UpsertedSourceRecord extends typegraphSource {
  /** True when the source row was inserted, false when an existing canonical row was updated. */
  wasCreated?: boolean | undefined
}

export interface SourceFilter {
  bucketId?: string | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  status?: SourceStatus | SourceStatus[] | undefined
  visibility?: Visibility | Visibility[] | undefined
  sourceIds?: string[] | undefined
  /** Filter sources by whether triple extraction ran during ingestion. */
  graphExtracted?: boolean | undefined
}

export interface UpsertSourceInput {
  /** Prefixed source ID (e.g. src_550e8400...). Must be provided by caller. */
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
  status: SourceStatus
  visibility?: Visibility | undefined
  /** Whether triple extraction ran against this source. Defaults to false. */
  graphExtracted?: boolean | undefined
  metadata?: Record<string, unknown> | undefined
  subject?: SourceSubject | undefined
}
