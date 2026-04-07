#!/usr/bin/env npx tsx
/**
 * MultiHop-RAG Benchmark — d8um Core (Hybrid + Fast)
 *
 * Multi-hop QA over 609 news articles, ~2556 queries.
 * Single unified eval loop: retrieve → compute IR metrics → generate answer → score.
 *
 * Usage:
 *   npx tsx --env-file=.env multihop-rag/core/run.ts                            # retrieval only
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --eval-answers             # retrieval + answers
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --eval-answers-limit=100   # limit answer eval queries
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --seed                     # re-index
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --validate                 # smoke test
 *   npx tsx --env-file=.env multihop-rag/core/run.ts --record                   # save to history
 */

import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { getConfig, K, signalLabel } from '../../lib/config.js'
import {
  parseCliArgs, initCore, resolveBucket, loadDataset,
  runIngestion, buildResult, emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import {
  wordIntersectionAccuracy,
  deduplicateToDocuments, scoreAllQueriesExtended,
} from '../../lib/metrics.js'
import { runValidation } from '../../lib/validate.js'
import { recordResults } from '../../lib/history.js'
import type { BenchmarkResult, BenchmarkMetrics } from '../../lib/report.js'

const config = getConfig('multihop-rag/core')
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
  if (cli.shouldSeed) {
    console.log(`Phase 3: Ingesting ${corpus.length} documents...`)
    const result = await runIngestion(d, bucket.id, corpus, config)
    ingestDuration = result.ingestDuration
  } else {
    console.log('Phase 3: Skipping ingestion (no --seed flag)')
  }
  console.log()

  // Phase 4: Single unified eval loop per mode
  const benchResults: BenchmarkResult[] = []
  const doIR = !cli.evalAnswersOnly  // skip IR metrics in answer-only mode
  const answers = goldAnswers ?? new Map<string, string>()
  const answerLimit = cli.evalAnswersLimit
  const evalModel = cli.evalLlmModel

  for (const signals of config.signals) {
    // Determine which queries to run
    let queries = testQueries
    if (cli.evalAnswersOnly) {
      queries = testQueries.filter(q => answers.has(String(q['_id']))).slice(0, answerLimit)
    }

    const flags = [
      doIR ? 'IR metrics' : null,
      doAnswerEval ? `answers (limit ${Math.min(answerLimit, queries.length)}, model: ${evalModel})` : null,
    ].filter(Boolean).join(' + ')
    console.log(`Phase 4: Eval — ${signalLabel(signals)} (${queries.length} queries, ${flags})...`)

    const queryStart = performance.now()
    const allResults = new Map<string, string[]>()
    let sumACC = 0, answered = 0, answerErrors = 0

    for (const query of queries) {
      const queryId = String(query['_id'])
      const queryText = String(query['text'])

      // Retrieve
      const response = await d.query(queryText, {
        signals, count: 50, buckets: [bucket.id],
      })

      // IR: accumulate document-level results for scoring
      if (doIR) {
        allResults.set(queryId, deduplicateToDocuments(response.results, K))
      }

      // Answer eval: generate + score (if this query has a gold answer and we're under the limit)
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

    benchResults.push(buildResult(config, signals, corpus.length, scored, metrics as BenchmarkMetrics, {
      ingestDuration: signals === config.signals[0] ? ingestDuration : undefined,
      avgQueryMs,
      totalStart,
      latency,
    }, doAnswerEval ? { evalModel } : undefined))
    console.log()
  }

  emitResults(benchResults)
  if (cli.record) recordResults(benchResults)
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
