import type { IndexResult } from './index-types.js'
import type { ThreadTurnResult } from './memory.js'
import type { MemoryRecord } from '../memory/types/memory.js'

export type JobType = 'ingest' | 'remember' | 'thread_turn' | 'correct' | 'forget'
export type JobStatus = 'pending' | 'processing' | 'complete' | 'failed'

/** A tracked async operation (primarily used in cloud mode). */
export interface Job {
  id: string
  tenantId?: string | undefined
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  status: JobStatus
  type: JobType
  bucketId?: string | undefined
  /** Populated on completion. Shape depends on `type`. */
  result?: IndexResult | MemoryRecord | ThreadTurnResult | undefined
  /** Error message if status is 'failed'. */
  error?: string | undefined
  createdAt: Date
  completedAt?: Date | undefined
  progress?: { processed: number; total: number } | undefined
}

export interface JobFilter {
  tenantId?: string | undefined
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  bucketId?: string | undefined
  status?: JobStatus | undefined
  type?: JobType | undefined
}

/** Input for creating or replacing a job row. `id` is caller-provided (e.g. an Inngest run id). */
export interface UpsertJobInput {
  id: string
  tenantId?: string | undefined
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  type: JobType
  status?: JobStatus | undefined
  bucketId?: string | undefined
  progressTotal?: number | undefined
  progressProcessed?: number | undefined
}

/** Partial update applied to an existing job row. `completedAt` is auto-set for terminal statuses when omitted. */
export interface JobStatusPatch {
  status?: JobStatus | undefined
  result?: Job['result'] | undefined
  error?: string | undefined
  progressProcessed?: number | undefined
  progressTotal?: number | undefined
  completedAt?: Date | undefined
}
