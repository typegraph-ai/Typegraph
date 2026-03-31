#!/usr/bin/env npx tsx
/**
 * GraphRAG-Bench Novel — d8um Neural (Hybrid + Graph PPR)
 *
 * Answer-generation benchmark: 20 Project Gutenberg novels (~1,147 chunks at 1200 tokens),
 * 2,010 questions. Neural mode adds LLM triple extraction during ingest and PPR graph
 * traversal during query.
 *
 * Usage:
 *   npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts                         # answer eval
 *   npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --seed                  # ingest + graph build
 *   npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --validate              # smoke test
 *   npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --record                # save results
 */

import { getConfig } from '../../lib/config.js'
import {
  parseCliArgs, initNeural, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { runValidation } from '../../lib/validate.js'
import { recordResults } from '../../lib/history.js'
import type { BenchmarkResult } from '../../lib/report.js'

const config = getConfig('graphrag-bench-novel/neural')
const cli = parseCliArgs()

async function main() {
  const totalStart = performance.now()
  printBanner(config, cli)

  // Phase 1: Initialize
  console.log('Phase 1: Initializing d8um with graph bridge...')
  console.log(`  LLM: google/gemini-3.1-flash-lite-preview (triple extraction during ingest)`)
  const { d, adapter } = await initNeural(config)
  const { bucket } = await resolveBucket(d, config.bucketName, cli.shouldSeed)
  const latency = await measureLatencyProfile(adapter)
  console.log()

  // Phase 2: Load dataset
  console.log('Phase 2: Loading GraphRAG-Bench Novel from Vercel Blob...')
  const { corpus, testQueries, qrelsMap, goldAnswers } = await loadDataset(config, true)
  console.log(`  Test queries: ${testQueries.length}`)
  console.log()

  // Validate mode
  if (cli.validate) {
    const ok = await runValidation(d, config.bucketName, corpus, testQueries, config)
    process.exit(ok ? 0 : 1)
  }

  // Phase 3: Ingest with triple extraction
  let ingestDuration: number | undefined
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} documents (with LLM triple extraction)...`)
    const result = await runIngestion(d, bucket.id, corpus, config, { concurrency: 5 })
    ingestDuration = result.ingestDuration
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // Phase 4: Query + metrics
  console.log(`Phase 4: Running ${testQueries.length} queries (mode: neural)...`)
  console.log('  Neural = hybrid + memory recall + PPR graph traversal, merged via RRF')
  const { allResults, avgQueryMs } = await runQueries(d, bucket.id, testQueries, 'neural')
  console.log()

  console.log('Phase 5: Computing IR metrics...')
  const { metrics, scored } = computeMetrics(config, allResults, qrelsMap)

  const result = buildResult(config, 'neural', corpus.length, scored, metrics, {
    ingestDuration,
    avgQueryMs,
    totalStart,
    latency,
  }, { tripleExtractionErrors: 0 })

  emitResults(result)

  if (cli.record) {
    recordResults([result])
  }
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
