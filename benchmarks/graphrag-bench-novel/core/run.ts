#!/usr/bin/env npx tsx
/**
 * GraphRAG-Bench Novel — d8um Core (Hybrid + Fast)
 *
 * Answer-generation benchmark: 20 Project Gutenberg novels (~1,147 chunks at 1200 tokens),
 * 2,010 questions. Single-loop eval: retrieve → generate answer → score vs gold.
 * Runs both hybrid and fast modes for comparison.
 *
 * Usage:
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts                            # answer eval (100q default)
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --eval-answers-limit=500   # larger eval
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --seed                     # ingest corpus
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --validate                 # smoke test
 *   npx tsx --env-file=.env graphrag-bench-novel/core/run.ts --record                   # save results
 */

import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { getConfig } from '../../lib/config.js'
import {
  parseCliArgs, initCore, resolveBucket, loadDataset,
  runIngestion, buildResult, emitResults, printBanner, measureLatencyProfile,
} from '../../lib/runner.js'
import { answerCorrectness } from '../../lib/metrics.js'
import { runValidation } from '../../lib/validate.js'
import { recordResults } from '../../lib/history.js'
import type { BenchmarkResult, BenchmarkMetrics } from '../../lib/report.js'

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
  const { corpus, testQueries, goldAnswers } = await loadDataset(config, true)
  console.log(`  Test queries: ${testQueries.length}`)
  console.log(`  Gold answers: ${goldAnswers?.size ?? 0}`)
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

  // Phase 4: Single-loop answer-generation evaluation for each mode
  // Uses GraphRAG-Bench scoring: 0.75 * factuality_fbeta + 0.25 * semantic_similarity
  const answers = goldAnswers ?? new Map<string, string>()
  const limit = cli.evalAnswersLimit
  const evalQueries = testQueries.filter(q => answers.has(String(q['_id']))).slice(0, limit)
  const evalModel = cli.evalLlmModel
  const benchResults: BenchmarkResult[] = []

  // LLM + embedding for answer correctness scoring (judge model)
  const judgeModel = gateway(evalModel)
  const embModel = gateway.embeddingModel('openai/text-embedding-3-small')
  const judgeLlm = async (prompt: string) => {
    const { text } = await generateText({ model: judgeModel, prompt })
    return text
  }
  const judgeEmbed = async (text: string) => {
    const result = await embModel.doEmbed({ values: [text] })
    return result.embeddings[0]! as number[]
  }

  for (const mode of config.modes) {
    console.log(`Phase 4: Answer-generation eval — ${mode} (${evalQueries.length} queries, model: ${evalModel})...`)
    console.log('  Single loop: retrieve → generate → score (GraphRAG-Bench LLM-as-judge)')
    const queryStart = performance.now()

    let sumACC = 0, answered = 0, errors = 0

    for (const query of evalQueries) {
      const queryId = String(query['_id'])
      const queryText = String(query['text'])
      const gold = answers.get(queryId)
      if (!gold) continue

      try {
        // Retrieve
        const response = await d.query(queryText, {
          mode: mode as any, count: 50, buckets: [bucket.id],
        })
        const chunks = response.results.slice(0, 6).map(r => r.content)
        const context = chunks.join('\n\n---\n\n')

        // Generate answer
        const { text: predicted } = await generateText({
          model: judgeModel,
          prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
        })

        // Score with GraphRAG-Bench methodology (LLM-as-judge)
        const score = await answerCorrectness(queryText, predicted, gold, {
          generateText: judgeLlm,
          embed: judgeEmbed,
        })
        sumACC += score
        answered++
      } catch (err) {
        errors++
        if (errors <= 3) console.error(`\n  Error (query ${queryId}): ${err instanceof Error ? err.message : err}`)
      }

      if ((answered + errors) % 10 === 0 || (answered + errors) === evalQueries.length) {
        const elapsed = ((performance.now() - queryStart) / 1000).toFixed(0)
        process.stdout.write(`\r  Progress: ${answered + errors}/${evalQueries.length} (${elapsed}s) ACC=${answered > 0 ? (sumACC / answered).toFixed(3) : '—'}`)
      }
    }

    const queryDuration = (performance.now() - queryStart) / 1000
    const avgQueryMs = (answered + errors) > 0 ? (queryDuration * 1000) / (answered + errors) : 0
    console.log(`\n  Complete: ${answered} answered${errors > 0 ? `, ${errors} errors` : ''} in ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(0)}ms/query)`)

    const metrics: BenchmarkMetrics = {
      'nDCG@10': undefined as unknown as number,
      'MAP@10': undefined as unknown as number,
      'Recall@10': undefined as unknown as number,
      'Precision@10': undefined as unknown as number,
      ACC: answered > 0 ? sumACC / answered : 0,
    }

    benchResults.push(buildResult(config, mode, corpus.length, answered, metrics, {
      ingestDuration: mode === config.modes[0] ? ingestDuration : undefined,
      avgQueryMs,
      totalStart,
      latency,
    }, { evalModel, evalQueries: evalQueries.length, errors }))
    console.log()
  }

  emitResults(benchResults)
  if (cli.record) recordResults(benchResults)
  process.exit(0)
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
