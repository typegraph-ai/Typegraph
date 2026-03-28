#!/usr/bin/env npx tsx
/**
 * NFCorpus Benchmark — d8um Core (Hybrid Search)
 *
 * Runs the full BEIR NFCorpus benchmark (3,633 docs, 323 queries)
 * using d8um core with hybrid search (vector + BM25, RRF fusion).
 *
 * Uses Neon Postgres (pgvector) for persistent storage and
 * Vercel Blob for cached dataset downloads.
 *
 * Required env vars:
 *   NEON_DATABASE_URL       — Neon Postgres connection string
 *   AI_GATEWAY_API_KEY      — AI Gateway API key (embeddings)
 *   BLOB_READ_WRITE_TOKEN   — Vercel Blob token (dataset download)
 *
 * Usage:
 *   npx tsx nfcorpus/core/run.ts           # query-only (uses existing index)
 *   npx tsx nfcorpus/core/run.ts --seed    # re-index corpus, then query
 */

import { d8umCreate } from '@d8um/core'
import { gateway } from '@ai-sdk/gateway'
import { createBenchmarkAdapter } from '../../lib/adapter.js'
import { loadCorpus, loadQueries, loadQrels, buildQrelsMap } from '../../lib/datasets.js'
import { scoreAllQueries } from '../../lib/metrics.js'
import { printResults, type BenchmarkResult } from '../../lib/report.js'

// ── Configuration ──

const DATASET = 'nfcorpus'
const BUCKET_NAME = 'nfcorpus'
const TABLE_PREFIX = 'bench_nfcorpus_core_'
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 64
const K = 10

const shouldSeed = process.argv.includes('--seed')

// ── Main ──

async function main() {
  const totalStart = performance.now()

  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  NFCorpus Benchmark — d8um Core (Hybrid Search)      ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log()
  console.log(`  Mode: ${shouldSeed ? 'seed + query' : 'query-only (use --seed to re-index)'}`)
  console.log()

  // ── Phase 1: Initialize d8um with Neon pgvector ──
  console.log('Phase 1: Initializing d8um with Neon pgvector...')

  const adapter = createBenchmarkAdapter(TABLE_PREFIX)
  const d = await d8umCreate({
    vectorStore: adapter,
    embedding: {
      model: gateway.embeddingModel(EMBEDDING_MODEL),
      dimensions: EMBEDDING_DIMS,
    },
  })

  // Find or create bucket
  const existingBuckets = await d.buckets.list()
  let bucket = existingBuckets.find(b => b.name === BUCKET_NAME)

  if (bucket && !shouldSeed) {
    console.log(`  Using existing bucket: ${bucket.name} (${bucket.id})`)
  } else if (bucket && shouldSeed) {
    console.log(`  Bucket exists, will re-index with --seed`)
  } else {
    console.log(`  No existing bucket found, will create and seed`)
  }
  console.log()

  // ── Phase 2: Load Dataset from Vercel Blob ──
  console.log('Phase 2: Loading NFCorpus from Vercel Blob...')

  const [corpus, queries, qrels] = await Promise.all([
    loadCorpus(DATASET),
    loadQueries(DATASET),
    loadQrels(DATASET),
  ])

  const qrelsMap = buildQrelsMap(qrels)
  const testQueries = queries.filter(q => qrelsMap.has(String(q['_id'])))
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)
  console.log()

  // ── Phase 3: Ingest (if needed) ──
  let ingestDuration: number | undefined

  if (!bucket || shouldSeed) {
    if (!bucket) {
      bucket = await d.buckets.create({ name: BUCKET_NAME })
      console.log(`  Created bucket: ${bucket.name} (${bucket.id})`)
    }

    console.log(`Phase 3: Ingesting ${corpus.length} documents...`)
    console.log(`  Config: chunk_size=${CHUNK_SIZE}, chunk_overlap=${CHUNK_OVERLAP}, embedding=${EMBEDDING_MODEL}`)
    const ingestStart = performance.now()

    const BATCH_SIZE = 30
    let ingested = 0
    let totalChunks = 0
    let batchNum = 0
    const totalBatches = Math.ceil(corpus.length / BATCH_SIZE)

    for (let i = 0; i < corpus.length; i += BATCH_SIZE) {
      batchNum++
      const batch = corpus.slice(i, i + BATCH_SIZE)
      const batchStart = performance.now()

      const docs = batch.map(doc => {
        const docId = String(doc['_id'])
        const title = String(doc['title'] ?? '')
        const text = String(doc['text'] ?? '')
        return {
          id: docId,
          title,
          content: title ? `${title}\n\n${text}` : text,
          updatedAt: new Date(),
          metadata: { corpusId: docId },
        }
      })

      const result = await d.ingest(
        bucket.id,
        docs,
        {
          chunkSize: CHUNK_SIZE,
          chunkOverlap: CHUNK_OVERLAP,
          deduplicateBy: ['content'],
        },
      )

      ingested += batch.length
      totalChunks += result.inserted
      const batchMs = performance.now() - batchStart
      const elapsed = (performance.now() - ingestStart) / 1000
      const docsPerSec = ingested / elapsed
      const eta = (corpus.length - ingested) / docsPerSec

      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${batch.length} docs, ` +
        `${result.inserted} chunks inserted, ${result.skipped} skipped ` +
        `(${batchMs.toFixed(0)}ms) — ${ingested}/${corpus.length} total, ` +
        `${docsPerSec.toFixed(0)} docs/s, ETA ${eta.toFixed(0)}s`
      )
    }

    ingestDuration = (performance.now() - ingestStart) / 1000
    console.log(`  Ingestion complete: ${ingestDuration.toFixed(1)}s, ${ingested} docs, ${totalChunks} chunks (${(ingested / ingestDuration).toFixed(0)} docs/sec)`)
  } else {
    console.log('Phase 3: Skipping ingestion (bucket exists, no --seed flag)')
  }
  console.log()

  // ── Phase 4: Run Queries ──
  console.log(`Phase 4: Running ${testQueries.length} queries (mode: hybrid)...`)
  const queryStart = performance.now()

  const allResults = new Map<string, string[]>()
  let queriesDone = 0

  for (const query of testQueries) {
    const queryId = String(query['_id'])
    const queryText = String(query['text'])

    const response = await d.query(queryText, {
      mode: 'hybrid',
      count: K,
      buckets: [bucket!.id],
    })

    const retrievedIds = response.results
      .map(r => r.metadata['corpusId'] as string)
      .filter(Boolean)

    allResults.set(queryId, retrievedIds)

    queriesDone++
    if (queriesDone % 50 === 0 || queriesDone === testQueries.length) {
      process.stdout.write(`\r  Queries: ${queriesDone}/${testQueries.length}`)
    }
  }

  const queryDuration = (performance.now() - queryStart) / 1000
  const avgQueryMs = (queryDuration * 1000) / testQueries.length
  console.log(`\n  Queries complete: ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(1)}ms/query)`)
  console.log()

  // ── Phase 5: Score ──
  console.log('Phase 5: Computing IR metrics...')

  const { metrics, scored } = scoreAllQueries(allResults, qrelsMap, K)
  const totalDuration = (performance.now() - totalStart) / 1000

  // ── Phase 6: Results ──
  const result: BenchmarkResult = {
    benchmark: 'NFCorpus (BEIR)',
    dataset: DATASET,
    mode: 'hybrid',
    variant: 'core',
    corpus: corpus.length,
    queries: scored,
    k: K,
    metrics,
    timing: {
      ingestionSeconds: ingestDuration ? Number(ingestDuration.toFixed(1)) : undefined,
      avgQueryMs: Number(avgQueryMs.toFixed(1)),
      totalSeconds: Number(totalDuration.toFixed(1)),
    },
    config: {
      embedding: EMBEDDING_MODEL,
      embeddingDims: EMBEDDING_DIMS,
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    },
  }

  printResults(result)

  console.log('---BENCH_RESULT_JSON---')
  console.log(JSON.stringify(result, null, 2))
  console.log('---END_BENCH_RESULT_JSON---')
  console.log('══════════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
