/**
 * eval-cache.ts — Resumable eval run persistence
 *
 * Writes scored query results to a JSONL file as they complete.
 * On resume with the same run ID, already-scored queries are skipped.
 *
 * Usage:
 *   --run-id=UUID    Resume a specific run (reads existing results, skips scored queries)
 *   (no flag)        Starts a fresh run with an auto-generated UUID
 *
 * Files are stored at: benchmarks/{dataset}/{variant}/runs/{runId}.jsonl
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'

export interface EvalEntry {
  queryId: string
  questionType: string
  score: number
  error?: boolean
}

export interface EvalRunMeta {
  runId: string
  dataset: string
  variant: string
  signals: string
  evalModel: string
  startedAt: string
  totalQueries: number
}

export class EvalCache {
  readonly runId: string
  readonly filePath: string
  private scored: Map<string, EvalEntry>
  private isResumed: boolean

  constructor(opts: {
    dataset: string
    variant: string
    runId?: string
  }) {
    this.runId = opts.runId ?? randomUUID()
    const runsDir = join(process.cwd(), opts.dataset, opts.variant, 'runs')
    mkdirSync(runsDir, { recursive: true })
    this.filePath = join(runsDir, `${this.runId}.jsonl`)

    // Load existing results if resuming
    this.scored = new Map()
    this.isResumed = false
    if (existsSync(this.filePath)) {
      const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          // Skip the metadata line (first line)
          if (parsed.queryId !== undefined) {
            this.scored.set(parsed.queryId, parsed as EvalEntry)
          }
        } catch {
          // Skip malformed lines
        }
      }
      if (this.scored.size > 0) {
        this.isResumed = true
      }
    }
  }

  /** Write run metadata as the first line (only on fresh runs) */
  writeMeta(meta: Omit<EvalRunMeta, 'runId'>): void {
    if (!this.isResumed) {
      appendFileSync(this.filePath, JSON.stringify({ ...meta, runId: this.runId }) + '\n')
    }
  }

  /** Check if a query has already been scored */
  has(queryId: string): boolean {
    return this.scored.has(queryId)
  }

  /** Get a previously scored entry */
  get(queryId: string): EvalEntry | undefined {
    return this.scored.get(queryId)
  }

  /** Record a scored query (persists immediately) */
  record(entry: EvalEntry): void {
    this.scored.set(entry.queryId, entry)
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n')
  }

  /** Number of queries already scored */
  get size(): number {
    return this.scored.size
  }

  /** Whether this is a resumed run */
  get resumed(): boolean {
    return this.isResumed
  }

  /** Get all scored entries */
  entries(): EvalEntry[] {
    return [...this.scored.values()]
  }

  /** Compute aggregate ACC from all entries */
  computeACC(): { overall: number; byType: Map<string, { sum: number; count: number }> } {
    let sum = 0, count = 0
    const byType = new Map<string, { sum: number; count: number }>()

    for (const entry of this.scored.values()) {
      if (entry.error) continue
      sum += entry.score
      count++

      if (!byType.has(entry.questionType)) byType.set(entry.questionType, { sum: 0, count: 0 })
      const t = byType.get(entry.questionType)!
      t.sum += entry.score
      t.count++
    }

    return { overall: count > 0 ? sum / count : 0, byType }
  }
}

/** Parse --run-id=UUID from CLI args */
export function parseRunId(): string | undefined {
  const arg = process.argv.find(a => a.startsWith('--run-id='))
  return arg ? arg.split('=')[1] : undefined
}
