#!/usr/bin/env npx tsx
/**
 * MultiHop-RAG Benchmark — d8um Neural (Hybrid + Graph PPR)
 *
 * Multi-hop QA over 609 news articles, ~2556 queries.
 * Single unified eval loop: retrieve → compute IR metrics → generate answer → score.
 *
 * Usage:
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts                            # retrieval only
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --eval-answers             # retrieval + answers
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --eval-answers-limit=100   # limit answer eval queries
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --seed                     # re-index + graph build
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --validate                 # smoke test
 *   npx tsx --env-file=.env multihop-rag/neural/run.ts --record                   # save to history
 */

import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { getConfig, LLM_MODEL, K, SIGNALS, signalLabel } from '../../lib/config.js'
import {
  parseCliArgs, initNeural, resolveBucket, loadDataset,
  runIngestion, buildResult, emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import {
  wordIntersectionAccuracy,
  deduplicateToDocuments, scoreAllQueriesExtended,
} from '../../lib/metrics.js'
import { runValidation } from '../../lib/validate.js'
import { recordResult } from '../../lib/history.js'
import type { BenchmarkMetrics } from '../../lib/report.js'

const config = getConfig('multihop-rag/neural')
const cli = parseCliArgs()

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason)
  process.exit(1)
})

async function main() {
  const totalStart = performance.now()
  printBanner(config, cli)

  // Phase 1: Initialize
  console.log('Phase 1: Initializing d8um with graph bridge...')
  console.log(`  LLM: ${LLM_MODEL} (triple extraction during ingest)`)
  const { d, adapter } = await initNeural(config)
  const { bucket } = await resolveBucket(d, config.bucketName, cli.shouldSeed)
  const latency = await measureLatencyProfile(adapter)
  console.log()

  // Phase 2: Load dataset
  const doAnswerEval = cli.evalAnswers || cli.evalAnswersOnly
  console.log('Phase 2: Loading MultiHop-RAG from Vercel Blob...')
  const { corpus, testQueries, qrelsMap, goldAnswers } = await loadDataset(config, doAnswerEval)
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)
  if (goldAnswers) console.log(`  Gold answers: ${goldAnswers.size}`)
  console.log()

  // Validate mode
  if (cli.validate) {
    const ok = await runValidation(d, config.bucketName, corpus, testQueries, config)
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

  // Phase 4: Single unified eval loop
  const doIR = !cli.evalAnswersOnly
  const answers = goldAnswers ?? new Map<string, string>()
  const answerLimit = cli.evalAnswersLimit
  const evalModel = cli.evalLlmModel

  let queries = testQueries
  if (cli.evalAnswersOnly) {
    queries = testQueries.filter(q => answers.has(String(q['_id']))).slice(0, answerLimit)
  }

  const flags = [
    doIR ? 'IR metrics' : null,
    doAnswerEval ? `answers (limit ${Math.min(answerLimit, queries.length)}, model: ${evalModel})` : null,
  ].filter(Boolean).join(' + ')
  console.log(`Phase 4: Eval — ${signalLabel(SIGNALS.neural)} (${queries.length} queries, ${flags})...`)

  const queryStart = performance.now()
  const allResults = new Map<string, string[]>()
  let sumACC = 0, answered = 0, answerErrors = 0

  for (const query of queries) {
    const queryId = String(query['_id'])
    const queryText = String(query['text'])

    // Retrieve with 90s timeout (neural can hang on DB stalls)
    let response: Awaited<ReturnType<typeof d.query>>
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      response = await Promise.race([
        d.query(queryText, { signals: SIGNALS.neural, count: 50, buckets: [bucket.id] }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('query timeout (90s)')), 90_000) }),
      ])
    } catch {
      // On timeout, skip this query
      const done = allResults.size || (answered + answerErrors)
      if (done % 20 === 0) process.stdout.write(`\r  Progress: ${done}/${queries.length}`)
      continue
    } finally {
      clearTimeout(timer)
    }

    // IR: accumulate
    if (doIR) {
      allResults.set(queryId, deduplicateToDocuments(response.results, K))
    }

    // Answer eval
    if (doAnswerEval && answered < answerLimit) {
      const gold = answers.get(queryId)
      if (gold) {
        try {
          const chunks = response.results.slice(0, 6).map(r => r.content)
          const context = chunks.join('\n\n---\n\n')
          const { text: predicted } = await generateText({
            model: gateway(evalModel),
            prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
          })
          // Paper uses word-intersection accuracy (has_intersection in qa_evaluate.py)
          sumACC += wordIntersectionAccuracy(predicted, gold)
          answered++
        } catch {
          answerErrors++
        }
      }
    }

    const done = allResults.size || (answered + answerErrors)
    if (done % 20 === 0 || done === queries.length) {
      process.stdout.write(`\r  Progress: ${done}/${queries.length}`)
    }
  }

  const queryDuration = (performance.now() - queryStart) / 1000
  const avgQueryMs = queries.length > 0 ? (queryDuration * 1000) / queries.length : 0
  console.log(`\n  Complete: ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(0)}ms/query)`)

  // Compute IR metrics
  const metrics: Record<string, number | undefined> = {}
  let scored = queries.length
  if (doIR) {
    const ir = scoreAllQueriesExtended(allResults, qrelsMap, K)
    Object.assign(metrics, ir.metrics)
    scored = ir.scored
  }

  // Add answer metrics (word-intersection ACC, matching paper's qa_evaluate.py)
  if (doAnswerEval && answered > 0) {
    metrics['ACC'] = sumACC / answered
    console.log(`  Answers: ${answered}${answerErrors > 0 ? ` (${answerErrors} errors)` : ''} — ACC=${metrics['ACC']!.toFixed(4)} (word-intersection)`)
  }

  const result = buildResult(config, SIGNALS.neural, corpus.length, scored, metrics as BenchmarkMetrics, {
    ingestDuration,
    avgQueryMs,
    totalStart,
    latency,
  }, {
    tripleExtractionErrors: tripleErrors,
    ...(doAnswerEval ? { evalModel } : {}),
  })

  emitResults(result)
  if (cli.record) recordResult(result)
  process.exit(0)
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
