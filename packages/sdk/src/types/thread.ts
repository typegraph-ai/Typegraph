import type { EventInput, typegraphEventRecord } from './event.js'

export interface ThreadInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id?: string | undefined
  name: string
  description?: string | undefined
  metadata?: TMeta | undefined
}

export interface typegraphThread {
  id: string
  tenantId: string
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  graphId: string
  name: string
  description?: string | undefined
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface ThreadTurnInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  role: string
  content: string
  timestamp?: Date | undefined
  metadata?: TMeta | undefined
}

export interface ThreadFilter {
  threadIds?: string[] | undefined
}

export interface ThreadStorageFilter extends ThreadFilter {
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphIds?: string[] | undefined
}

export interface UpsertThreadInput extends Omit<typegraphThread, 'createdAt' | 'updatedAt'> {}

export interface ThreadTurnResult {
  thread: typegraphThread
  event: typegraphEventRecord
}

export type ThreadEventInput = EventInput
