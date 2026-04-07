#!/usr/bin/env npx tsx
/**
 * Legal RAG Bench — d8um Graph (Neural Search)
 *
 * Runs the isaacus/legal-rag-bench benchmark (4,876 passages, 100 questions)
 * using d8um graph with neural search (hybrid + memory recall + PPR graph traversal).
 *
 * During ingestion, an LLM extracts S-P-O triples from each chunk, building
 * a knowledge graph that powers Personalized PageRank at query time.
 *
 * This dataset uses a custom format (not BEIR):
 * - Corpus: Victorian Criminal Charge Book passages with footnotes
 * - QA: Complex legal questions with relevant_passage_id references
 *
 * Usage:
 *   npx tsx --env-file=.env legal-rag-bench/neural/run.ts              # query-only
 *   npx tsx --env-file=.env legal-rag-bench/neural/run.ts --seed        # re-index
 *   npx tsx --env-file=.env legal-rag-bench/neural/run.ts --validate    # smoke test
 *   npx tsx --env-file=.env legal-rag-bench/neural/run.ts --record      # save to history
 */

import { getConfig, LLM_MODEL, SIGNALS, signalLabel } from '../../lib/config.js'
import {
  parseCliArgs, initNeural, resolveBucket, loadDataset,
  runIngestion, runQueries, computeMetrics, buildResult,
  emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { runValidation } from '../../lib/validate.js'
import { recordResult } from '../../lib/history.js'

const config = getConfig('legal-rag-bench/neural')
const cli = parseCliArgs()

/** Map legal-rag corpus docs (id, title, text, footnotes) to ingest format */
function legalRagDocMapper(doc: Record<string, unknown>) {
  const docId = String(doc['id'])
  const title = String(doc['title'] ?? '')
  const text = String(doc['text'] ?? '')
  const footnotes = String(doc['footnotes'] ?? '')
  const content = [
    title ? `${title}\n\n${text}` : text,
    footnotes ? `\n\nFootnotes:\n${footnotes}` : '',
  ].join('')
  return {
    id: docId, title, content,
    updatedAt: new Date(),
    metadata: { corpusId: docId },
  }
}

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
  console.log('Phase 2: Loading Legal RAG Bench from Vercel Blob...')
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
    const result = await runIngestion(d, bucket.id, corpus, config, {
      concurrency: 5,
      docMapper: legalRagDocMapper,
    })
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
  }, { includesFootnotes: true, tripleExtractionErrors: tripleErrors })

  emitResults(result)

  if (cli.record) {
    recordResult(result)
  }
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
