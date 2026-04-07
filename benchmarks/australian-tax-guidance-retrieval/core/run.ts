#!/usr/bin/env npx tsx
/**
 * Australian Tax Guidance Retrieval Benchmark — d8um Core (Hybrid + Fast)
 *
 * Runs the isaacus/australian-tax-guidance-retrieval benchmark (105 docs, 112 queries)
 * using d8um core with both hybrid search and fast (pure vector) search.
 *
 * Usage:
 *   npx tsx --env-file=.env australian-tax-guidance-retrieval/core/run.ts              # query-only
 *   npx tsx --env-file=.env australian-tax-guidance-retrieval/core/run.ts --seed        # re-index
 *   npx tsx --env-file=.env australian-tax-guidance-retrieval/core/run.ts --validate    # smoke test
 *   npx tsx --env-file=.env australian-tax-guidance-retrieval/core/run.ts --record      # save to history
 */

import { getConfig, signalLabel } from '../../lib/config.js'
import {
  parseCliArgs, initCore, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { runValidation } from '../../lib/validate.js'
import { recordResults } from '../../lib/history.js'
import type { BenchmarkResult } from '../../lib/report.js'

const config = getConfig('australian-tax-guidance-retrieval/core')
const cli = parseCliArgs()

async function main() {
  const totalStart = performance.now()
  printBanner(config, cli)

  // Phase 1: Initialize
  console.log('Phase 1: Initializing d8um with Neon pgvector...')
  const { d, adapter } = await initCore(config)
  const { bucket } = await resolveBucket(d, config.bucketName, cli.shouldSeed)
  const latency = await measureLatencyProfile(adapter)
  console.log()

  // Phase 2: Load dataset
  console.log('Phase 2: Loading dataset from Vercel Blob...')
  const { corpus, testQueries, qrelsMap } = await loadDataset(config)
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)
  console.log()

  // Validate mode: smoke test and exit
  if (cli.validate) {
    const ok = await runValidation(d, config.bucketName, corpus, testQueries, config)
    process.exit(ok ? 0 : 1)
  }

  // Phase 3: Ingest (if needed)
  let ingestDuration: number | undefined
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} documents...`)
    const result = await runIngestion(d, bucket.id, corpus, config)
    ingestDuration = result.ingestDuration
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // Phase 4+: Query in both modes
  const benchResults: BenchmarkResult[] = []

  for (const signals of config.signals) {
    console.log(`Running ${testQueries.length} queries (signals: ${signalLabel(signals)})...`)
    const { allResults, avgQueryMs } = await runQueries(d, bucket.id, testQueries, signals)
    console.log()

    console.log(`Computing IR metrics (${signalLabel(signals)})...`)
    const { metrics, scored } = computeMetrics(config, allResults, qrelsMap)

    benchResults.push(buildResult(config, signals, corpus.length, scored, metrics, {
      ingestDuration: signals === config.signals[0] ? ingestDuration : undefined,
      avgQueryMs,
      totalStart,
      latency,
    }))
    console.log()
  }

  emitResults(benchResults)

  if (cli.record) {
    recordResults(benchResults)
  }
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
