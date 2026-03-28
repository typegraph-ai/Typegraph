#!/usr/bin/env npx tsx
/**
 * Legal RAG Bench — d8um Core (Hybrid Search)
 *
 * Runs the isaacus/legal-rag-bench benchmark (4,876 passages, 100 questions)
 * using d8um core with hybrid search (vector + BM25, RRF fusion).
 *
 * This dataset uses a custom format (not BEIR):
 * - Corpus: Victorian Criminal Charge Book passages with footnotes
 * - QA: Complex legal questions with relevant_passage_id references
 *
 * Required env vars:
 *   NEON_DATABASE_URL, AI_GATEWAY_API_KEY, BLOB_READ_WRITE_TOKEN
 *
 * Usage:
 *   npx tsx legal-rag-bench/core/run.ts           # query-only
 *   npx tsx legal-rag-bench/core/run.ts --seed    # re-index
 */

import { d8umCreate } from '@d8um/core'
import { gateway } from '@ai-sdk/gateway'
import { createBenchmarkAdapter } from '../../lib/adapter.js'
import { loadLegalRagCorpus, loadLegalRagQa, buildLegalRagQrelsMap } from '../../lib/datasets.js'
import { scoreAllQueries } from '../../lib/metrics.js'
import { printResults, type BenchmarkResult } from '../../lib/report.js'

// ── Configuration ──

const BUCKET_NAME = 'legal-rag-bench'
const TABLE_PREFIX = 'bench_legalrag_core_'
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 64
const K = 10

const shouldSeed = process.argv.includes('--seed')

// ── Main ──

async function main() {
  const totalStart = performance.now()

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  Legal RAG Bench — d8um Core (Hybrid Search)                ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`  Mode: ${shouldSeed ? 'seed + query' : 'query-only (use --seed to re-index)'}`)
  console.log()

  console.log('Phase 1: Initializing d8um with Neon pgvector...')
  const adapter = createBenchmarkAdapter(TABLE_PREFIX)
  const d = await d8umCreate({
    vectorStore: adapter,
    embedding: {
      model: gateway.embeddingModel(EMBEDDING_MODEL),
      dimensions: EMBEDDING_DIMS,
    },
  })

  const existingBuckets = await d.buckets.list()
  let bucket = existingBuckets.find(b => b.name === BUCKET_NAME)
  if (bucket && !shouldSeed) {
    console.log(`  Using existing bucket: ${bucket.name} (${bucket.id})`)
  } else if (!bucket) {
    console.log(`  No existing bucket found, will create and seed`)
  }
  console.log()

  console.log('Phase 2: Loading Legal RAG Bench from Vercel Blob...')
  const [corpus, qa] = await Promise.all([
    loadLegalRagCorpus(),
    loadLegalRagQa(),
  ])

  const qrelsMap = buildLegalRagQrelsMap(qa)
  console.log(`  QA pairs (with passage references): ${qa.length}`)
  console.log()

  let ingestDuration: number | undefined

  if (!bucket || shouldSeed) {
    if (!bucket) {
      bucket = await d.buckets.create({ name: BUCKET_NAME })
    }

    console.log(`Phase 3: Ingesting ${corpus.length} passages...`)
    const ingestStart = performance.now()
    let ingested = 0

    for (const doc of corpus) {
      const docId = String(doc.id)
      const title = String(doc.title ?? '')
      const text = String(doc.text ?? '')
      const footnotes = String(doc.footnotes ?? '')

      // Include footnotes as part of content for richer retrieval
      const content = [
        title ? `${title}\n\n${text}` : text,
        footnotes ? `\n\nFootnotes:\n${footnotes}` : '',
      ].join('')

      await d.ingest(bucket.id, [{
        id: docId, title,
        content,
        updatedAt: new Date(),
        metadata: { corpusId: docId },
      }], { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, deduplicateBy: ['content'] })

      ingested++
      if (ingested % 500 === 0 || ingested === corpus.length) {
        process.stdout.write(`\r  Ingested: ${ingested}/${corpus.length}`)
      }
    }

    ingestDuration = (performance.now() - ingestStart) / 1000
    console.log(`\n  Ingestion complete: ${ingestDuration.toFixed(1)}s (${(ingested / ingestDuration).toFixed(0)} docs/sec)`)
  } else {
    console.log('Phase 3: Skipping ingestion (bucket exists, no --seed flag)')
  }
  console.log()

  console.log(`Phase 4: Running ${qa.length} queries (mode: hybrid)...`)
  const queryStart = performance.now()
  const allResults = new Map<string, string[]>()
  let queriesDone = 0

  for (const q of qa) {
    const queryId = String(q.id)

    const response = await d.query(q.question, {
      mode: 'hybrid', count: K, buckets: [bucket!.id],
    })

    const retrievedIds = response.results
      .map(r => r.metadata['corpusId'] as string)
      .filter(Boolean)

    allResults.set(queryId, retrievedIds)

    queriesDone++
    if (queriesDone % 20 === 0 || queriesDone === qa.length) {
      process.stdout.write(`\r  Queries: ${queriesDone}/${qa.length}`)
    }
  }

  const queryDuration = (performance.now() - queryStart) / 1000
  const avgQueryMs = (queryDuration * 1000) / qa.length
  console.log(`\n  Queries complete: ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(1)}ms/query)`)
  console.log()

  console.log('Phase 5: Computing IR metrics...')
  const { metrics, scored } = scoreAllQueries(allResults, qrelsMap, K)
  const totalDuration = (performance.now() - totalStart) / 1000

  const result: BenchmarkResult = {
    benchmark: 'Legal RAG Bench (isaacus)',
    dataset: 'legal-rag-bench',
    mode: 'hybrid', variant: 'core',
    corpus: corpus.length, queries: scored, k: K, metrics,
    timing: {
      ingestionSeconds: ingestDuration ? Number(ingestDuration.toFixed(1)) : undefined,
      avgQueryMs: Number(avgQueryMs.toFixed(1)),
      totalSeconds: Number(totalDuration.toFixed(1)),
    },
    config: {
      embedding: EMBEDDING_MODEL, embeddingDims: EMBEDDING_DIMS,
      chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP,
      includesFootnotes: true,
    },
  }

  printResults(result)

  console.log('---BENCH_RESULT_JSON---')
  console.log(JSON.stringify(result, null, 2))
  console.log('---END_BENCH_RESULT_JSON---')
  console.log('══════════════════════════════════════════════════════')
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
