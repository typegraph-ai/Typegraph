#!/usr/bin/env npx tsx
/**
 * NFCorpus Benchmark — d8um Graph (Neural Search)
 *
 * Runs the full BEIR NFCorpus benchmark (3,633 docs, 323 queries)
 * using d8um graph with neural search (hybrid + memory recall + PPR graph traversal).
 *
 * Usage:
 *   npx tsx --env-file=.env nfcorpus/neural/run.ts              # query-only
 *   npx tsx --env-file=.env nfcorpus/neural/run.ts --seed        # re-index
 *   npx tsx --env-file=.env nfcorpus/neural/run.ts --validate    # smoke test
 *   npx tsx --env-file=.env nfcorpus/neural/run.ts --record      # save to history
 */

import { getConfig, LLM_MODEL, SIGNALS, signalLabel } from '../../lib/config.js'
import {
  parseCliArgs, initNeural, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { runValidation } from '../../lib/validate.js'
import { recordResult } from '../../lib/history.js'

const config = getConfig('nfcorpus/neural')
const cli = parseCliArgs()

async function main() {
  const totalStart = performance.now()
  printBanner(config, cli)

  // Phase 1: Initialize with graph bridge
  console.log('Phase 1: Initializing d8um with graph bridge...')
  const { d, adapter } = await initNeural(config)
  console.log(`  LLM: ${LLM_MODEL} (triple extraction during ingest)`)
  const { bucket } = await resolveBucket(d, config.bucketName, cli.shouldSeed)
  const latency = await measureLatencyProfile(adapter)
  console.log()

  // Phase 2: Load dataset
  console.log('Phase 2: Loading NFCorpus from Vercel Blob...')
  const { corpus, testQueries, qrelsMap } = await loadDataset(config)
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)
  console.log()

  // Validate mode
  if (cli.validate) {
    const ok = await runValidation(d, config.bucketName, corpus, testQueries, config, { concurrency: 5 })
    process.exit(ok ? 0 : 1)
  }

  // Phase 3: Ingest
  let ingestDuration: number | undefined
  let tripleErrors = 0
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} documents (with LLM triple extraction)...`)
    const result = await runIngestion(d, bucket.id, corpus, config, { concurrency: 5 })
    ingestDuration = result.ingestDuration
    tripleErrors = result.tripleErrors
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // Phase 4: Query (neural mode)
  console.log(`Phase 4: Running ${testQueries.length} queries (signals: ${signalLabel(SIGNALS.neural)})...`)
  console.log('  Neural = hybrid + memory recall + PPR graph traversal, merged via RRF')
  const { allResults, avgQueryMs } = await runQueries(d, bucket.id, testQueries, SIGNALS.neural)
  console.log()

  // Phase 5: Score
  console.log('Phase 5: Computing IR metrics...')
  const { metrics, scored } = computeMetrics(config, allResults, qrelsMap)

  const result = buildResult(config, SIGNALS.neural, corpus.length, scored, metrics, {
    ingestDuration,
    avgQueryMs,
    totalStart,
    latency,
  }, { tripleExtractionErrors: tripleErrors })

  emitResults(result)

  if (cli.record) {
    recordResult(result)
  }
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
