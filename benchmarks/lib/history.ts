/**
 * history.ts — Local benchmark history recording
 *
 * Records benchmark results to history-{signals}.json files,
 * matching the format CI uses for auto-committed history.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import type { BenchmarkResult } from './report.js'

interface HistoryEntry {
  commit: string
  date: string
  metrics: Record<string, number | null>
  avgQueryMs: number
  timing?: {
    ingestionSeconds: number | null
    avgQueryMs: number
    totalSeconds: number
  }
  signals: string
  config: Record<string, unknown>
}

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'local'
  }
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Record a benchmark result to its signal-specific history file.
 *
 * File: benchmarks/{dataset}/{variant}/history-{signals}.json
 */
export function recordResult(result: BenchmarkResult): void {
  const variant = result.variant === 'neural' || result.variant === 'graph' ? 'neural' : 'core'
  const historyDir = join(dirname(new URL(import.meta.url).pathname), '..', result.dataset, variant)
  const historyFile = join(historyDir, `history-${result.signals}.json`)

  // Read existing history or start fresh
  let history: HistoryEntry[] = []
  if (existsSync(historyFile)) {
    try {
      const raw = readFileSync(historyFile, 'utf-8')
      history = JSON.parse(raw)
    } catch {
      console.log(`  Warning: Could not parse ${historyFile}, starting fresh`)
    }
  }

  // Build entry matching CI format
  const entry: HistoryEntry = {
    commit: getCommitHash(),
    date: getToday(),
    metrics: Object.fromEntries(
      Object.entries(result.metrics).map(([k, v]) => [k, v ?? null])
    ),
    avgQueryMs: result.timing.avgQueryMs,
    timing: {
      ingestionSeconds: result.timing.ingestionSeconds ?? null,
      avgQueryMs: result.timing.avgQueryMs,
      totalSeconds: result.timing.totalSeconds,
    },
    signals: result.signals,
    config: result.config,
  }

  history.push(entry)
  writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n')
  console.log(`  Recorded to ${historyFile}`)
}

/**
 * Record an array of benchmark results.
 */
export function recordResults(results: BenchmarkResult[]): void {
  for (const result of results) {
    recordResult(result)
  }
}
