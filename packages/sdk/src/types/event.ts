import type { EntityRef } from './identity.js'
import type { DocumentInput, typegraphDocument } from './document.js'

export interface EventInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id?: string | undefined
  name: string
  description?: string | undefined
  occurredAt: Date
  participants?: EntityRef[] | undefined
  documents?: DocumentInput[] | undefined
  content?: string | undefined
  metadata?: TMeta | undefined
}

export interface typegraphEventRecord {
  id: string
  tenantId: string
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphId: string
  name: string
  description?: string | undefined
  occurredAt: Date
  participants: EntityRef[]
  documents?: typegraphDocument[] | undefined
  content?: string | undefined
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface EventFilter {
  eventIds?: string[] | undefined
}

export interface EventStorageFilter extends EventFilter {
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphIds?: string[] | undefined
}

export interface UpsertEventInput extends Omit<typegraphEventRecord, 'createdAt' | 'updatedAt' | 'documents'> {
  documentIds?: string[] | undefined
}
