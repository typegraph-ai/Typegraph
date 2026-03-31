#!/usr/bin/env npx tsx
/**
 * GraphRAG-Bench Novel — d8um Core (Hybrid + Fast)
 *
 * Answer-generation benchmark: 20 Project Gutenberg novels (~1,147 chunks at 1200 tokens),
 * 2,010 questions across 4 types (Fact Retrieval, Complex Reasoning, Contextual Summarize,
 * Creative Generation).
 *
 * Primary evaluation: ACC/EM/F1 via answer generation (no meaningful qrels).
 *
 * Usage:
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts                         # answer eval (100q default)
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --seed                  # ingest corpus
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --validate              # smoke test
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --eval-answers-limit=500 # larger eval
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --record                # save results
 */

import { getConfig } from '../../lib/config.js'
import {
  parseCliArgs, initCore, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { runValidation } from '../../lib/validate.js'
import { recordResults } from '../../lib/history.js'
import type { BenchmarkResult } from '../../lib/report.js'

const config = getConfig('graphrag-bench-novel/core')
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
  console.log('Phase 2: Loading GraphRAG-Bench Novel from Vercel Blob...')
  const { corpus, testQueries, qrelsMap, goldAnswers } = await loadDataset(config, true)
  console.log(`  Test queries: ${testQueries.length}`)
  console.log()

  // Validate mode
  if (cli.validate) {
    const ok = await runValidation(d, config.bucketName, corpus, testQueries, config)
    process.exit(ok ? 0 : 1)
  }

  // Phase 3: Ingest
  let ingestDuration: number | undefined
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} pre-chunked documents...`)
    const result = await runIngestion(d, bucket.id, corpus, config)
    ingestDuration = result.ingestDuration
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // Phase 4: Answer-generation evaluation (primary metric for GraphRAG-Bench)
  // This benchmark has no meaningful qrels — evaluation is ACC/EM/F1 on generated answers
  const benchResults: BenchmarkResult[] = []

  for (const mode of config.modes) {
    console.log(`Running ${testQueries.length} queries (mode: ${mode})...`)
    const { allResults, avgQueryMs } = await runQueries(d, bucket.id, testQueries, mode)
    console.log()

    // Retrieval metrics will be near-zero (no qrels) — that's expected
    const { metrics, scored } = computeMetrics(config, allResults, qrelsMap)

    benchResults.push(buildResult(config, mode, corpus.length, scored, metrics, {
      ingestDuration: mode === config.modes[0] ? ingestDuration : undefined,
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
