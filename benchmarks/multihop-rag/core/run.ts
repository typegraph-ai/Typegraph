#!/usr/bin/env npx tsx
/**
 * MultiHop-RAG Benchmark — d8um Core (Hybrid + Fast)
 *
 * Runs the yixuantt/MultiHopRAG benchmark (609 docs, ~2556 queries)
 * using d8um core with both hybrid search and fast (pure vector) search.
 * Multi-hop question answering over news articles.
 *
 * Required env vars:
 *   NEON_DATABASE_URL, AI_GATEWAY_API_KEY, BLOB_READ_WRITE_TOKEN
 *
 * Usage:
 *   npx tsx multihop-rag/core/run.ts           # query-only
 *   npx tsx multihop-rag/core/run.ts --seed    # re-index
 */

import { d8umCreate } from '@d8um/core'
import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { createBenchmarkAdapter } from '../../lib/adapter.js'
import { loadCorpus, loadQueries, loadQrels, buildQrelsMap, loadAnswers } from '../../lib/datasets.js'
import { scoreAllQueriesExtended, deduplicateToDocuments, substringAccuracy, exactMatch, tokenF1 } from '../../lib/metrics.js'
import { printResults, type BenchmarkResult } from '../../lib/report.js'

// ── Configuration ──

const DATASET = 'multihop-rag'
const BLOB_PREFIX = 'datasets'
const BUCKET_NAME = 'multihop-rag'
const TABLE_PREFIX = 'bench_multihop_core_'
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const CHUNK_SIZE = 2048
const CHUNK_OVERLAP = 256
const K = 10
const QUERY_FETCH = K * 5
const LLM_MODEL = 'google/gemini-3.1-flash-lite-preview'

const shouldSeed = process.argv.includes('--seed')
const evalAnswers = process.argv.includes('--eval-answers') || process.argv.includes('--eval-answers-only')
const evalAnswersOnly = process.argv.includes('--eval-answers-only')
const evalAnswersLimitArg = process.argv.find(a => a.startsWith('--eval-answers-limit='))
const evalAnswersLimitDefault = evalAnswersOnly ? 100 : Infinity
const evalAnswersLimit = evalAnswersLimitArg ? parseInt(evalAnswersLimitArg.split('=')[1]!, 10) : evalAnswersLimitDefault
const evalModelArg = process.argv.find(a => a.startsWith('--eval-model='))
const EVAL_LLM_MODEL = evalModelArg ? evalModelArg.split('=')[1]! : LLM_MODEL

// ── Main ──

async function main() {
  const totalStart = performance.now()

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  MultiHop-RAG Benchmark — d8um Core (Hybrid + Fast)         ║')
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

  console.log('Phase 2: Loading dataset from Vercel Blob...')
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

  let ingestDuration: number | undefined

  if (!bucket || shouldSeed) {
    if (!bucket) {
      bucket = await d.buckets.create({ name: BUCKET_NAME })
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
          id: docId, title,
          content: title ? `${title}\n\n${text}` : text,
          updatedAt: new Date(),
          metadata: { corpusId: docId },
        }
      })

      const result = await d.ingest(
        bucket.id, docs,
        { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, deduplicateBy: ['content'], propagateMetadata: ['metadata.corpusId'] },
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

  // ── Answer-only mode: single loop (retrieve → generate → score) ──
  if (evalAnswersOnly) {
    const answers = goldAnswers ?? await loadAnswers(DATASET, BLOB_PREFIX)
    const querySet = answerQuerySet
    console.log(`Phase 4: Answer-only evaluation (${querySet.length} queries, mode: hybrid, model: ${EVAL_LLM_MODEL})...`)
    console.log('  Single loop: retrieve → generate → score per query')
    const queryStart = performance.now()

    let sumACC = 0, sumEM = 0, sumF1 = 0, answered = 0, errors = 0

    for (const query of querySet) {
      const queryId = String(query['_id'])
      const queryText = String(query['text'])
      const gold = answers.get(queryId)
      if (!gold) continue

      const response = await d.query(queryText, {
        mode: 'hybrid',
        count: QUERY_FETCH,
        buckets: [bucket!.id],
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

    const benchResult: BenchmarkResult = {
      benchmark: 'MultiHop-RAG (yixuantt)',
      dataset: DATASET, mode: 'hybrid', variant: 'core',
      corpus: corpus.length, queries: answered, k: K, metrics,
      timing: {
        avgQueryMs: Number(avgQueryMs.toFixed(1)),
        totalSeconds: Number(((performance.now() - totalStart) / 1000).toFixed(1)),
      },
      config: {
        embedding: EMBEDDING_MODEL, embeddingDims: EMBEDDING_DIMS,
        chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, queryFetch: QUERY_FETCH,
        evalModel: EVAL_LLM_MODEL,
      },
    }

    printResults(benchResult)
    console.log('---BENCH_RESULT_JSON---')
    console.log(JSON.stringify([benchResult], null, 2))
    console.log('---END_BENCH_RESULT_JSON---')
    console.log('══════════════════════════════════════════════════════')
    return
  }

  // ── Query in both modes (full retrieval) ──
  const modes = ['hybrid', 'fast'] as const
  const benchResults: BenchmarkResult[] = []
  let phaseNum = 4

  for (const mode of modes) {
    const querySet = testQueries
    console.log(`Phase ${phaseNum}: Running ${querySet.length} queries (mode: ${mode})...`)
    const queryStart = performance.now()
    const allResults = new Map<string, string[]>()
    const allChunkResults = new Map<string, string[]>()
    let queriesDone = 0

    for (const query of querySet) {
      const queryId = String(query['_id'])
      const response = await d.query(String(query['text']), {
        mode, count: QUERY_FETCH, buckets: [bucket!.id],
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

    phaseNum++
    console.log(`Phase ${phaseNum}: Computing IR metrics (${mode})...`)
    const irResult = scoreAllQueriesExtended(allResults, qrelsMap, K)
    let metrics = irResult.metrics as Record<string, number | undefined>
    const scored = irResult.scored

    // ── Answer-generation evaluation (optional, non-fatal) ──
    if (evalAnswers) {
      phaseNum++
      console.log(`Phase ${phaseNum}: Evaluating answer generation (${mode}, model: ${EVAL_LLM_MODEL})...`)
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

    benchResults.push({
      benchmark: 'MultiHop-RAG (yixuantt)',
      dataset: DATASET, mode, variant: 'core',
      corpus: corpus.length, queries: scored, k: K, metrics,
      timing: {
        ingestionSeconds: mode === 'hybrid' && ingestDuration ? Number(ingestDuration.toFixed(1)) : undefined,
        avgQueryMs: Number(avgQueryMs.toFixed(1)),
        totalSeconds: Number(((performance.now() - totalStart) / 1000).toFixed(1)),
      },
      config: {
        embedding: EMBEDDING_MODEL, embeddingDims: EMBEDDING_DIMS,
        chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, queryFetch: QUERY_FETCH,
        ...(evalAnswers ? { evalModel: EVAL_LLM_MODEL } : {}),
      },
    })

    printResults(benchResults[benchResults.length - 1]!)
    phaseNum++
    console.log()
  }

  console.log('---BENCH_RESULT_JSON---')
  console.log(JSON.stringify(benchResults, null, 2))
  console.log('---END_BENCH_RESULT_JSON---')
  console.log('══════════════════════════════════════════════════════')
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
