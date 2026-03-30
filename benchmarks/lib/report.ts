/**
 * report.ts — Format benchmark results as markdown
 */

export interface BenchmarkMetrics {
  'nDCG@10': number
  'MAP@10': number
  'Recall@10': number
  'Precision@10': number
  'MRR@10'?: number
  'Hit@10'?: number
  'ACC'?: number     // Substring Accuracy (paper-comparable)
  'EM'?: number      // Exact Match (answer generation)
  'F1'?: number      // Token F1 (answer generation)
  [key: string]: number | undefined
}

export interface BenchmarkResult {
  benchmark: string
  dataset: string
  mode: string
  variant: string
  corpus: number
  queries: number
  k: number
  metrics: BenchmarkMetrics
  timing: {
    ingestionSeconds?: number
    avgQueryMs: number
    totalSeconds: number
  }
  config: Record<string, unknown>
}

export function formatMarkdown(result: BenchmarkResult): string {
  const lines: string[] = []

  lines.push(`## ${result.benchmark} — ${result.variant} (${result.mode})`)
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  for (const [name, value] of Object.entries(result.metrics)) {
    if (value != null) lines.push(`| ${name} | ${value.toFixed(4)} |`)
  }
  lines.push('')
  lines.push(`**Corpus:** ${result.corpus.toLocaleString()} docs | **Queries:** ${result.queries} | **Mode:** ${result.mode}`)
  lines.push('')

  if (result.timing.ingestionSeconds != null) {
    lines.push(`**Timing:** ingest ${result.timing.ingestionSeconds.toFixed(1)}s, avg query ${result.timing.avgQueryMs.toFixed(1)}ms, total ${Math.floor(result.timing.totalSeconds / 60)}m${(result.timing.totalSeconds % 60).toFixed(0)}s`)
  } else {
    lines.push(`**Timing:** avg query ${result.timing.avgQueryMs.toFixed(1)}ms, total ${Math.floor(result.timing.totalSeconds / 60)}m${(result.timing.totalSeconds % 60).toFixed(0)}s`)
  }

  lines.push('')

  return lines.join('\n')
}

export function printResults(result: BenchmarkResult): void {
  console.log()
  console.log('══════════════════════════════════════════════════════')
  console.log(`  ${result.benchmark} — ${result.variant} (${result.mode})`)
  console.log('══════════════════════════════════════════════════════')
  console.log()
  console.log(`  Corpus:        ${result.corpus.toLocaleString()} documents`)
  console.log(`  Queries:       ${result.queries} (full BEIR test set)`)
  console.log(`  Mode:          ${result.mode}`)
  console.log()
  console.log('  ── Retrieval Scores ──')
  for (const [name, value] of Object.entries(result.metrics)) {
    if (value != null) console.log(`  ${name.padEnd(14)} ${value.toFixed(4)}`)
  }
  console.log()
  console.log('  ── Timing ──')
  if (result.timing.ingestionSeconds != null) {
    console.log(`  Ingestion:     ${result.timing.ingestionSeconds.toFixed(1)}s`)
  }
  console.log(`  Avg Query:     ${result.timing.avgQueryMs.toFixed(1)}ms`)
  console.log(`  Total:         ${Math.floor(result.timing.totalSeconds / 60)}m ${(result.timing.totalSeconds % 60).toFixed(0)}s`)
  console.log()
}
