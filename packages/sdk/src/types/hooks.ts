import type { typegraphResult } from './query.js'
import type { IngestOptions, IndexResult } from './index-types.js'

export interface typegraphHooks {
  /** Fired after query() returns results. Use for citation tracking. */
  onQueryResults?: ((query: string, results: typegraphResult[]) => void | Promise<void>) | undefined
  /** Fired before indexing starts for a bucket. */
  onIndexStart?: ((bucketId: string, opts: IngestOptions) => void | Promise<void>) | undefined
  /** Fired after indexing completes for a bucket. */
  onIndexComplete?: ((bucketId: string, result: IndexResult) => void | Promise<void>) | undefined
  /** Fired after memory extraction produces results. */
  onMemoryExtracted?: ((result: { episodicCount: number; factsExtracted: number; operationsCount: number }) => void | Promise<void>) | undefined
  /** Fired when contradictions are detected between memory records. */
  onContradictionDetected?: ((contradictions: { existingId: string; newId: string; conflictType: string; reasoning: string }[]) => void | Promise<void>) | undefined
}
