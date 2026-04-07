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
  /** Active signal label (e.g. "vector", "vector+keyword", "vector+keyword+graph+memory") */
  signals: string
  variant: string
  corpus: number
  queries: number
  k: number
  metrics: BenchmarkMetrics
  timing: {
    ingestionSeconds?: number
    avgQueryMs: number
    totalSeconds: number
    latency?: {
      dbRoundTripMs: number
      embeddingRoundTripMs: number
      environment: 'ci' | 'local'
    }
  }
  config: Record<string, unknown>
}

export function formatMarkdown(result: BenchmarkResult): string {
  const lines: string[] = []

  lines.push(`## ${result.benchmark} — ${result.variant} (${result.signals})`)
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  for (const [name, value] of Object.entries(result.metrics)) {
    if (value != null) lines.push(`| ${name} | ${value.toFixed(4)} |`)
  }
  lines.push('')
  lines.push(`**Corpus:** ${result.corpus.toLocaleString()} docs | **Queries:** ${result.queries} | **Signals:** ${result.signals}`)
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
  console.log(`  ${result.benchmark} — ${result.variant} (${result.signals})`)
  console.log('══════════════════════════════════════════════════════')
  console.log()
  console.log(`  Corpus:        ${result.corpus.toLocaleString()} documents`)
  console.log(`  Queries:       ${result.queries} (full BEIR test set)`)
  console.log(`  Signals:       ${result.signals}`)
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
  if (result.timing.latency) {
    const l = result.timing.latency
    const networkMs = l.dbRoundTripMs + l.embeddingRoundTripMs
    const overheadMs = result.timing.avgQueryMs - networkMs
    console.log(`  ── Latency Breakdown ──`)
    console.log(`  DB round-trip: ${l.dbRoundTripMs.toFixed(0)}ms`)
    console.log(`  Embed API:     ${l.embeddingRoundTripMs.toFixed(0)}ms`)
    console.log(`  SDK + other:   ${Math.max(0, overheadMs).toFixed(0)}ms`)
    console.log(`  Environment:   ${l.environment}`)
  }
  console.log(`  Total:         ${Math.floor(result.timing.totalSeconds / 60)}m ${(result.timing.totalSeconds % 60).toFixed(0)}s`)
  console.log()
}
