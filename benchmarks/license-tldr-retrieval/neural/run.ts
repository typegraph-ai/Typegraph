#!/usr/bin/env npx tsx
/**
 * License TLDR Retrieval Benchmark — d8um Graph (Neural Search)
 *
 * Runs the isaacus/license-tldr-retrieval benchmark
 * using d8um graph with neural search (hybrid + memory recall + PPR graph traversal).
 *
 * During ingestion, an LLM extracts S-P-O triples from each chunk, building
 * a knowledge graph that powers Personalized PageRank at query time.
 *
 * Uses Neon Postgres (pgvector) for persistent storage and
 * Vercel Blob for cached dataset downloads.
 *
 * Required env vars:
 *   NEON_DATABASE_URL       — Neon Postgres connection string
 *   AI_GATEWAY_API_KEY      — AI Gateway API key (embeddings + LLM)
 *   BLOB_READ_WRITE_TOKEN   — Vercel Blob token (dataset download)
 *
 * Usage:
 *   npx tsx license-tldr-retrieval/neural/run.ts           # query-only (uses existing index)
 *   npx tsx license-tldr-retrieval/neural/run.ts --seed    # re-index corpus, then query
 */

import { d8umCreate, aiSdkLlmProvider } from '@d8um/core'
import { createGraphBridge, PgMemoryStoreAdapter } from '@d8um/graph'
import { gateway } from '@ai-sdk/gateway'
import { neon } from '@neondatabase/serverless'
import { createBenchmarkAdapter } from '../../lib/adapter.js'
import { loadCorpus, loadQueries, loadQrels, buildQrelsMap } from '../../lib/datasets.js'
import { scoreAllQueries } from '../../lib/metrics.js'
import { printResults, type BenchmarkResult } from '../../lib/report.js'

// ── Configuration ──

const DATASET = 'license-tldr-retrieval'
const BLOB_PREFIX = 'datasets/isaacus'
const BUCKET_NAME = 'license-tldr-neural'
const TABLE_PREFIX = 'bench_license_neural_'
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const LLM_MODEL = 'google/gemini-3.1-flash-lite-preview'
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 64
const K = 10

const shouldSeed = process.argv.includes('--seed')

// ── Main ──

async function main() {
  const totalStart = performance.now()

  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  License TLDR Retrieval — d8um Graph (Neural Search)            ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`  Mode: ${shouldSeed ? 'seed + query' : 'query-only (use --seed to re-index)'}`)
  console.log()

  // ── Phase 1: Initialize d8um with graph bridge ──
  console.log('Phase 1: Initializing d8um with graph bridge...')

  const databaseUrl = process.env.NEON_DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: NEON_DATABASE_URL env var is required.')
    process.exit(1)
  }

  const sql = neon(databaseUrl)
  const adapter = createBenchmarkAdapter(TABLE_PREFIX)
  const embeddingModel = gateway.embeddingModel(EMBEDDING_MODEL)
  const llmModel = gateway(LLM_MODEL)
  const llm = aiSdkLlmProvider({ model: llmModel })

  const embeddingConfig = { model: embeddingModel, dimensions: EMBEDDING_DIMS }

  // Graph bridge needs its own memory store adapter (for entities/edges)
  const memoryStore = new PgMemoryStoreAdapter({
    sql: (q, p) => sql(q, p as any) as any,
    memoriesTable: `${TABLE_PREFIX}memories`,
    entitiesTable: `${TABLE_PREFIX}entities`,
    edgesTable: `${TABLE_PREFIX}edges`,
  })
  await memoryStore.initialize()

  const graph = createGraphBridge({
    memoryStore,
    embedding: {
      embed: async (text: string) => {
        const result = await embeddingModel.doEmbed({ values: [text] })
        return result.embeddings[0]!
      },
      embedBatch: async (texts: string[]) => {
        if (texts.length === 0) return []
        const result = await embeddingModel.doEmbed({ values: texts })
        return result.embeddings
      },
      dimensions: EMBEDDING_DIMS,
      model: EMBEDDING_MODEL,
    },
    llm,
    scope: { agentId: 'license-tldr-benchmark' },
  })

  const d = await d8umCreate({
    vectorStore: adapter,
    embedding: embeddingConfig,
    llm,
    graph,
  })

  console.log('  d8um initialized with graph bridge + neural search')
  console.log(`  LLM: ${LLM_MODEL} (triple extraction during ingest)`)
  console.log()

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
  console.log('Phase 2: Loading License TLDR Retrieval from Vercel Blob...')

  const [corpus, queries, qrels] = await Promise.all([
    loadCorpus(DATASET, BLOB_PREFIX),
    loadQueries(DATASET, BLOB_PREFIX),
    loadQrels(DATASET, BLOB_PREFIX),
  ])

  const qrelsMap = buildQrelsMap(qrels)
  const testQueries = queries.filter(q => qrelsMap.has(String(q['_id'])))
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)
  console.log()

  // ── Phase 3: Ingest (if needed) ──
  let ingestDuration: number | undefined
  let tripleErrors = 0

  if (!bucket || shouldSeed) {
    if (!bucket) {
      bucket = await d.buckets.create({ name: BUCKET_NAME })
      console.log(`  Created bucket: ${bucket.name} (${bucket.id})`)
    }

    console.log(`Phase 3: Ingesting ${corpus.length} documents (with LLM triple extraction)...`)
    console.log(`  Config: chunk_size=${CHUNK_SIZE}, chunk_overlap=${CHUNK_OVERLAP}, embedding=${EMBEDDING_MODEL}`)
    console.log('  Note: This is slower than core due to LLM calls per chunk.')
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
          id: docId, title,
          content: title ? `${title}\n\n${text}` : text,
          updatedAt: new Date(),
          metadata: { corpusId: docId },
        }
      })

      try {
        const result = await d.ingest(
          bucket.id, docs,
          { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, deduplicateBy: ['content'], propagateMetadata: ['metadata.corpusId'] },
        )
        totalChunks += result.inserted

        ingested += batch.length
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
      } catch {
        tripleErrors++
        ingested += batch.length
        console.log(
          `  Batch ${batchNum}/${totalBatches}: ${batch.length} docs — FAILED (triple extraction error)`
        )
      }
    }

    ingestDuration = (performance.now() - ingestStart) / 1000
    console.log(`  Ingestion complete: ${ingestDuration.toFixed(1)}s, ${ingested} docs, ${totalChunks} chunks (${(ingested / ingestDuration).toFixed(0)} docs/sec)`)
    if (tripleErrors > 0) {
      console.log(`  Triple extraction errors (non-blocking): ${tripleErrors}`)
    }
  } else {
    console.log('Phase 3: Skipping ingestion (bucket exists, no --seed flag)')
  }
  console.log()

  // ── Phase 4: Run Queries (Neural Mode) ──
  console.log(`Phase 4: Running ${testQueries.length} queries (mode: neural)...`)
  console.log('  Neural = hybrid + memory recall + PPR graph traversal, merged via RRF')
  const queryStart = performance.now()

  const allResults = new Map<string, string[]>()
  let queriesDone = 0

  for (const query of testQueries) {
    const queryId = String(query['_id'])
    const queryText = String(query['text'])

    const response = await d.query(queryText, {
      mode: 'neural',
      count: K,
      buckets: [bucket!.id],
    })

    const retrievedIds = response.results
      .map(r => r.metadata['corpusId'] as string)
      
      .filter(Boolean)
      .filter((id, i, arr) => arr.indexOf(id) === i)

    allResults.set(queryId, retrievedIds)

    queriesDone++
    if (queriesDone % 20 === 0 || queriesDone === testQueries.length) {
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
    benchmark: 'License TLDR Retrieval (isaacus)',
    dataset: DATASET,
    mode: 'neural',
    variant: 'graph',
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
      llm: LLM_MODEL,
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
      tripleExtractionErrors: tripleErrors,
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
