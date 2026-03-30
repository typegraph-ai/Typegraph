#!/usr/bin/env npx tsx
/**
 * MultiHop-RAG Benchmark — d8um Graph (Neural Search)
 *
 * Runs the yixuantt/MultiHopRAG benchmark (609 docs, ~2556 queries)
 * using d8um graph with neural search (hybrid + memory recall + PPR graph traversal).
 *
 * During ingestion, an LLM extracts S-P-O triples from each chunk, building
 * a knowledge graph that powers Personalized PageRank at query time.
 *
 * Required env vars:
 *   NEON_DATABASE_URL, AI_GATEWAY_API_KEY, BLOB_READ_WRITE_TOKEN
 *
 * Usage:
 *   npx tsx multihop-rag/neural/run.ts           # query-only
 *   npx tsx multihop-rag/neural/run.ts --seed    # re-index
 */

import { d8umCreate, aiSdkLlmProvider } from '@d8um/core'
import { createGraphBridge, PgMemoryStoreAdapter } from '@d8um/graph'
import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { neon } from '@neondatabase/serverless'
import { createBenchmarkAdapter } from '../../lib/adapter.js'
import { loadCorpus, loadQueries, loadQrels, buildQrelsMap, loadAnswers } from '../../lib/datasets.js'
import { scoreAllQueriesExtended, deduplicateToDocuments, substringAccuracy, exactMatch, tokenF1 } from '../../lib/metrics.js'
import { printResults, type BenchmarkResult } from '../../lib/report.js'

// ── Configuration ──

const DATASET = 'multihop-rag'
const BLOB_PREFIX = 'datasets'
const BUCKET_NAME = 'multihop-rag-neural'
const TABLE_PREFIX = 'bench_multihop_neural_'
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const LLM_MODEL = 'google/gemini-3.1-flash-lite-preview'
const CHUNK_SIZE = 2048
const CHUNK_OVERLAP = 256
const K = 10
const QUERY_FETCH = K * 5

const shouldSeed = process.argv.includes('--seed')
const evalAnswers = process.argv.includes('--eval-answers') || process.argv.includes('--eval-answers-only')
const evalAnswersOnly = process.argv.includes('--eval-answers-only')
const evalAnswersLimitArg = process.argv.find(a => a.startsWith('--eval-answers-limit='))
const evalAnswersLimitDefault = evalAnswersOnly ? 100 : Infinity
const evalAnswersLimit = evalAnswersLimitArg ? parseInt(evalAnswersLimitArg.split('=')[1]!, 10) : evalAnswersLimitDefault
const evalModelArg = process.argv.find(a => a.startsWith('--eval-model='))
const EVAL_LLM_MODEL = evalModelArg ? evalModelArg.split('=')[1]! : LLM_MODEL

// ── Main ──

// Catch unhandled errors so we get diagnostics instead of silent death
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err)
  process.exit(1)
})

async function main() {
  const totalStart = performance.now()

  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  MultiHop-RAG — d8um Graph (Neural Search)                      ║')
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

  const memoryStore = new PgMemoryStoreAdapter({
    sql: (q, p) => sql(q, p as any) as any,
    memoriesTable: `${TABLE_PREFIX}memories`,
    entitiesTable: `${TABLE_PREFIX}entities`,
    edgesTable: `${TABLE_PREFIX}edges`,
    embeddingDimensions: EMBEDDING_DIMS,
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
    scope: { agentId: 'multihop-rag-benchmark' },
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
  console.log('Phase 2: Loading MultiHop-RAG from Vercel Blob...')

  const loadPromises: [Promise<any>, Promise<any>, Promise<any>, Promise<Map<string, string>> | null] = [
    loadCorpus(DATASET, BLOB_PREFIX),
    loadQueries(DATASET, BLOB_PREFIX),
    loadQrels(DATASET, BLOB_PREFIX),
    evalAnswers ? loadAnswers(DATASET, BLOB_PREFIX) : null,
  ]
  const [corpus, queries, qrels, goldAnswers] = await Promise.all(loadPromises.map(p => p ?? Promise.resolve(null))) as [any[], any[], any[], Map<string, string> | null]

  const qrelsMap = buildQrelsMap(qrels)
  const testQueries = queries.filter(q => qrelsMap.has(String(q['_id'])))
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)

  // In eval-answers-only mode, only query the subset with gold answers
  let answerQuerySet: typeof testQueries
  if (evalAnswersOnly && goldAnswers) {
    answerQuerySet = testQueries.filter(q => goldAnswers.has(String(q['_id']))).slice(0, evalAnswersLimit)
    console.log(`  Answer-only mode: ${answerQuerySet.length} queries (of ${goldAnswers.size} with gold answers)`)
  } else {
    answerQuerySet = testQueries
  }
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
        const mem = process.memoryUsage()
        console.log(`  [batch ${batchNum}/${totalBatches}] Starting ${batch.length} docs (heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB / ${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB, rss: ${(mem.rss / 1024 / 1024).toFixed(0)}MB)`)
        const result = await d.ingest(
          bucket.id, docs,
          { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, deduplicateBy: ['content'], propagateMetadata: ['metadata.corpusId'] },
          { concurrency: 5 },
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
      } catch (err) {
        tripleErrors++
        ingested += batch.length
        console.error(`  Batch ${batchNum} error:`, err instanceof Error ? err.message : err)
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

  // ── Answer-only mode: single loop (retrieve → generate → score) ──
  if (evalAnswersOnly) {
    const answers = goldAnswers ?? await loadAnswers(DATASET, BLOB_PREFIX)
    const querySet = answerQuerySet
    console.log(`Phase 4: Answer-only evaluation (${querySet.length} queries, model: ${EVAL_LLM_MODEL})...`)
    console.log('  Single loop: retrieve → generate → score per query')
    const queryStart = performance.now()

    let sumACC = 0, sumEM = 0, sumF1 = 0, answered = 0, errors = 0

    for (const query of querySet) {
      const queryId = String(query['_id'])
      const queryText = String(query['text'])
      const gold = answers.get(queryId)
      if (!gold) continue

      const response = await d.query(queryText, {
        mode: 'neural',
        count: QUERY_FETCH,
        buckets: [bucket!.id],
        mergeWeights: { graph: 0.7 },
      })

      try {
        const chunks = response.results.slice(0, 6).map(r => r.content)
        const context = chunks.join('\n\n---\n\n')
        const { text: predicted } = await generateText({
          model: gateway(EVAL_LLM_MODEL),
          prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
        })

        sumACC += substringAccuracy(predicted, gold)
        sumEM += exactMatch(predicted, gold)
        sumF1 += tokenF1(predicted, gold)
        answered++
      } catch (err) {
        errors++
        console.error(`\n  Answer gen error (query ${queryId}): ${err instanceof Error ? err.message : err}`)
      }

      if ((answered + errors) % 10 === 0 || (answered + errors) === querySet.length) {
        const elapsed = ((performance.now() - queryStart) / 1000).toFixed(0)
        process.stdout.write(`\r  Progress: ${answered + errors}/${querySet.length} (${elapsed}s)`)
      }
    }

    const queryDuration = (performance.now() - queryStart) / 1000
    const avgQueryMs = answered > 0 ? (queryDuration * 1000) / (answered + errors) : 0
    console.log(`\n  Complete: ${answered} answered${errors > 0 ? `, ${errors} errors` : ''} in ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(0)}ms/query)`)
    console.log(`  ACC=${(sumACC / answered).toFixed(4)}, EM=${(sumEM / answered).toFixed(4)}, F1=${(sumF1 / answered).toFixed(4)}`)

    const metrics: Record<string, number | undefined> = {
      ACC: sumACC / answered,
      EM: sumEM / answered,
      F1: sumF1 / answered,
    }
    const totalDuration = (performance.now() - totalStart) / 1000

    const result: BenchmarkResult = {
      benchmark: 'MultiHop-RAG (yixuantt)',
      dataset: DATASET,
      mode: 'neural',
      variant: 'graph',
      corpus: corpus.length,
      queries: answered,
      k: K,
      metrics,
      timing: {
        avgQueryMs: Number(avgQueryMs.toFixed(1)),
        totalSeconds: Number(totalDuration.toFixed(1)),
      },
      config: {
        embedding: EMBEDDING_MODEL,
        embeddingDims: EMBEDDING_DIMS,
        llm: LLM_MODEL,
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
        evalModel: EVAL_LLM_MODEL,
      },
    }

    printResults(result)
    console.log('---BENCH_RESULT_JSON---')
    console.log(JSON.stringify(result, null, 2))
    console.log('---END_BENCH_RESULT_JSON---')
    console.log('══════════════════════════════════════════════════════')
    return
  }

  // ── Phase 4: Run Queries (Neural Mode) — full retrieval ──
  const querySet = testQueries
  console.log(`Phase 4: Running ${querySet.length} queries (mode: neural)...`)
  console.log('  Neural = hybrid + memory recall + PPR graph traversal, merged via RRF')
  const queryStart = performance.now()

  const allResults = new Map<string, string[]>()
  const allChunkResults = new Map<string, string[]>()
  let queriesDone = 0

  for (const query of querySet) {
    const queryId = String(query['_id'])
    const queryText = String(query['text'])

    const response = await d.query(queryText, {
      mode: 'neural',
      count: QUERY_FETCH,
      buckets: [bucket!.id],
      mergeWeights: { graph: 0.7 },
    })

    allResults.set(queryId, deduplicateToDocuments(response.results, K))
    if (evalAnswers) {
      allChunkResults.set(queryId, response.results.slice(0, 6).map(r => r.content))
    }

    queriesDone++
    if (queriesDone % 50 === 0 || queriesDone === querySet.length) {
      process.stdout.write(`\r  Queries: ${queriesDone}/${querySet.length}`)
    }
  }

  const queryDuration = (performance.now() - queryStart) / 1000
  const avgQueryMs = (queryDuration * 1000) / querySet.length
  console.log(`\n  Queries complete: ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(1)}ms/query)`)
  console.log()

  // ── Phase 5: Score ──
  console.log('Phase 5: Computing IR metrics...')
  const irResult = scoreAllQueriesExtended(allResults, qrelsMap, K)
  let metrics = irResult.metrics as Record<string, number | undefined>
  const scored = irResult.scored

  // ── Phase 5b: Answer-generation evaluation (optional, non-fatal) ──
  if (evalAnswers) {
    console.log(`Phase 5b: Evaluating answer generation (neural, model: ${EVAL_LLM_MODEL})...`)
    try {
      const answers = goldAnswers ?? await loadAnswers(DATASET, BLOB_PREFIX)

      let sumACC = 0, sumEM = 0, sumF1 = 0, answered = 0
      const targetCount = Math.min(answers.size, evalAnswersLimit)
      for (const [queryId] of allResults) {
        if (answered >= evalAnswersLimit) break
        const gold = answers.get(queryId)
        if (!gold) continue

        const queryText = querySet.find(q => String(q['_id']) === queryId)?.text ?? ''
        const chunks = allChunkResults.get(queryId) ?? []
        const context = chunks.join('\n\n---\n\n')

        const { text: predicted } = await generateText({
          model: gateway(EVAL_LLM_MODEL),
          prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
        })

        sumACC += substringAccuracy(predicted, gold)
        sumEM += exactMatch(predicted, gold)
        sumF1 += tokenF1(predicted, gold)
        answered++
        if (answered % 50 === 0 || answered === targetCount) {
          process.stdout.write(`\r  Answers: ${answered}/${targetCount}`)
        }
      }
      console.log(`\n  Answer eval complete: ${answered} queries, ACC=${(sumACC / answered).toFixed(4)}, EM=${(sumEM / answered).toFixed(4)}, F1=${(sumF1 / answered).toFixed(4)}`)
      metrics['ACC'] = sumACC / answered
      metrics['EM'] = sumEM / answered
      metrics['F1'] = sumF1 / answered
    } catch (err) {
      console.log(`  Answer eval skipped: ${err instanceof Error ? err.message : err}`)
      console.log('  (Run seed-datasets.ts to upload answers.json, then retry)')
    }
  }

  const totalDuration = (performance.now() - totalStart) / 1000

  // ── Phase 6: Results ──
  const result: BenchmarkResult = {
    benchmark: 'MultiHop-RAG (yixuantt)',
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
      ...(evalAnswers ? { evalModel: EVAL_LLM_MODEL } : {}),
    },
  }

  printResults(result)

  console.log('---BENCH_RESULT_JSON---')
  console.log(JSON.stringify(result, null, 2))
  console.log('---END_BENCH_RESULT_JSON---')
  console.log('══════════════════════════════════════════════════════')
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
