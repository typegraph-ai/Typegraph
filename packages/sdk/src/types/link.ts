export type LinkKind = 'bucket' | 'document' | 'chunk' | 'event' | 'thread' | 'entity' | 'fact'

export interface typegraphLink {
  id: string
  tenantId: string
  graphId: string
  fromKind: LinkKind
  fromId: string
  toKind: LinkKind
  toId: string
  relation: string
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface UpsertLinkInput {
  id?: string | undefined
  tenantId: string
  graphId?: string | undefined
  fromKind: LinkKind
  fromId: string
  toKind: LinkKind
  toId: string
  relation: string
  metadata?: Record<string, unknown> | undefined
}
