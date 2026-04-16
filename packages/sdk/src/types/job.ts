import type { typegraphIdentity } from './identity.js'
import type { IndexResult } from './index-types.js'
import type { ConversationTurnResult } from './memory.js'
import type { MemoryRecord } from '../memory/types/memory.js'

export type JobType = 'ingest' | 'remember' | 'conversation_turn' | 'correct' | 'forget'
export type JobStatus = 'pending' | 'processing' | 'complete' | 'failed'

/** A tracked async operation (primarily used in cloud mode). */
export interface Job {
  id: string
  status: JobStatus
  type: JobType
  bucketId?: string | undefined
  identity?: typegraphIdentity | undefined
  /** Populated on completion. Shape depends on `type`. */
  result?: IndexResult | MemoryRecord | ConversationTurnResult | undefined
  /** Error message if status is 'failed'. */
  error?: string | undefined
  createdAt: Date
  completedAt?: Date | undefined
  progress?: { processed: number; total: number } | undefined
}

export interface JobFilter {
  bucketId?: string | undefined
  status?: JobStatus | undefined
  type?: JobType | undefined
  identity?: typegraphIdentity | undefined
}
