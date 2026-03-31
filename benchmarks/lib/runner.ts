/**
 * runner.ts — Shared benchmark runner helpers
 *
 * Composable functions that eliminate boilerplate from individual runners.
 * Each runner still has its own main() — these are helpers, not a framework.
 */

import { d8umCreate, aiSdkLlmProvider } from '@d8um/core'
import { createGraphBridge, PgMemoryStoreAdapter } from '@d8um/graph'
import { gateway } from '@ai-sdk/gateway'
import { neon } from '@neondatabase/serverless'
import { createBenchmarkAdapter } from './adapter.js'
import {
  loadCorpus, loadQueries, loadQrels, buildQrelsMap,
  loadLegalRagCorpus, loadLegalRagQa, buildLegalRagQrelsMap,
  loadAnswers, loadBlobDirect, loadBlobAnswers,
} from './datasets.js'
import { scoreAllQueries, scoreAllQueriesExtended, deduplicateToDocuments } from './metrics.js'
import { printResults, type BenchmarkResult, type BenchmarkMetrics } from './report.js'
import type { BenchmarkConfig } from './config.js'
import {
  EMBEDDING_MODEL, EMBEDDING_DIMS, LLM_MODEL,
  CHUNK_SIZE, CHUNK_OVERLAP, K, QUERY_FETCH, BATCH_SIZE,
  resolveChunkSize, resolveChunkOverlap, resolveEmbeddingModel, resolveEmbeddingDims,
} from './config.js'

// ── CLI Argument Parsing ──

export interface CliArgs {
  shouldSeed: boolean
  evalAnswers: boolean
  evalAnswersOnly: boolean
  evalAnswersLimit: number
  evalLlmModel: string
  record: boolean
  validate: boolean
}

export function parseCliArgs(): CliArgs {
  const args = process.argv
  const evalModelArg = args.find(a => a.startsWith('--eval-model='))
  const evalLimitArg = args.find(a => a.startsWith('--eval-answers-limit='))

  return {
    shouldSeed: args.includes('--seed'),
    evalAnswers: args.includes('--eval-answers'),
    evalAnswersOnly: args.includes('--eval-answers-only'),
    evalAnswersLimit: evalLimitArg ? parseInt(evalLimitArg.split('=')[1]!, 10) : 100,
    evalLlmModel: evalModelArg ? evalModelArg.split('=')[1]! : LLM_MODEL,
    record: args.includes('--record'),
    validate: args.includes('--validate'),
  }
}

// ── Initialization ──

export interface CoreInit {
  d: Awaited<ReturnType<typeof d8umCreate>>
  adapter: ReturnType<typeof createBenchmarkAdapter>
}

export async function initCore(config: BenchmarkConfig): Promise<CoreInit> {
  const adapter = createBenchmarkAdapter(config.tablePrefix)
  const embModel = resolveEmbeddingModel(config)
  const embDims = resolveEmbeddingDims(config)

  const d = await d8umCreate({
    vectorStore: adapter,
    embedding: {
      model: gateway.embeddingModel(embModel),
      dimensions: embDims,
    },
  })

  return { d, adapter }
}

export interface NeuralInit extends CoreInit {
  sql: any  // neon() return type — generic overloads make strict typing impractical
}

export async function initNeural(config: BenchmarkConfig): Promise<NeuralInit> {
  const databaseUrl = process.env.NEON_DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: NEON_DATABASE_URL env var is required.')
    process.exit(1)
  }

  const sql = neon(databaseUrl)
  const adapter = createBenchmarkAdapter(config.tablePrefix)
  const embModel = resolveEmbeddingModel(config)
  const embDims = resolveEmbeddingDims(config)
  const embeddingModel = gateway.embeddingModel(embModel)
  const llmModel = gateway(LLM_MODEL)
  const llm = aiSdkLlmProvider({ model: llmModel })

  const memoryStore = new PgMemoryStoreAdapter({
    sql: (q: string, p?: unknown[]) => sql(q, p as any) as any,
    memoriesTable: `${config.tablePrefix}memories`,
    entitiesTable: `${config.tablePrefix}entities`,
    edgesTable: `${config.tablePrefix}edges`,
    embeddingDimensions: embDims,
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
      dimensions: embDims,
      model: embModel,
    },
    llm,
    scope: { agentId: `${config.dataset}-benchmark` },
  })

  const d = await d8umCreate({
    vectorStore: adapter,
    embedding: { model: embeddingModel, dimensions: embDims },
    llm,
    graph,
  })

  return { d, adapter, sql }
}

// ── Bucket Resolution ──

export async function resolveBucket(
  d: CoreInit['d'],
  bucketName: string,
  shouldSeed: boolean,
): Promise<{ bucket: { id: string; name: string }; existed: boolean }> {
  const existingBuckets = await d.buckets.list()
  let bucket = existingBuckets.find(b => b.name === bucketName)
  const existed = !!bucket

  if (bucket && !shouldSeed) {
    console.log(`  Using existing bucket: ${bucket.name} (${bucket.id})`)
  } else if (bucket && shouldSeed) {
    console.log(`  Bucket exists, will re-index with --seed`)
  } else {
    console.log(`  No existing bucket found, will create and seed`)
    bucket = await d.buckets.create({ name: bucketName })
    console.log(`  Created bucket: ${bucket.name} (${bucket.id})`)
  }

  return { bucket: bucket!, existed }
}

// ── Dataset Loading ──

export interface DatasetBundle {
  corpus: Record<string, unknown>[]
  testQueries: Record<string, unknown>[]
  qrelsMap: Map<string, Map<string, number>>
  goldAnswers?: Map<string, string>
  totalCorpus: number
  totalQueries: number
}

export async function loadDataset(
  config: BenchmarkConfig,
  loadGoldAnswers = false,
): Promise<DatasetBundle> {
  if (config.loader === 'graphrag-bench') {
    // GraphRAG-Bench: answer-generation benchmark. Corpus is pre-chunked in blob.
    // Evidence snippets are abstractive facts, not verbatim passages, so qrels are sparse/empty.
    // Primary evaluation is via answer-gen metrics (ACC/EM/F1), not retrieval metrics.
    // Blob paths: datasets/graphrag-bench/{domain}/corpus.json (blobPrefix IS the full prefix)
    const blobBase = config.blobPrefix
    const [corpus, queries] = await Promise.all([
      loadBlobDirect<any[]>(`${blobBase}/corpus.json`, 'corpus'),
      loadBlobDirect<any[]>(`${blobBase}/queries.json`, 'queries'),
    ])

    // All queries are test queries (no qrels filtering — answer-gen eval uses gold answers)
    const testQueries = queries

    let goldAnswers: Map<string, string> | undefined
    if (loadGoldAnswers) {
      try {
        goldAnswers = await loadBlobAnswers(`${blobBase}/answers.json`)
      } catch {
        console.log('  Warning: Could not load gold answers')
      }
    }

    // Empty qrelsMap — retrieval metrics will be 0, answer-gen metrics are primary
    const qrelsMap = new Map<string, Map<string, number>>()

    return {
      corpus,
      testQueries,
      qrelsMap,
      goldAnswers,
      totalCorpus: corpus.length,
      totalQueries: testQueries.length,
    }
  }

  if (config.loader === 'legal-rag') {
    const [corpus, qa] = await Promise.all([
      loadLegalRagCorpus(),
      loadLegalRagQa(),
    ])
    const qrelsMap = buildLegalRagQrelsMap(qa)
    // Legal RAG QA rows are also the test queries
    const testQueries = qa
      .filter(q => qrelsMap.has(String(q.id)))
      .map(q => ({ '_id': String(q.id), 'text': String(q.question) }))

    return {
      corpus: corpus as unknown as Record<string, unknown>[],
      testQueries,
      qrelsMap,
      totalCorpus: corpus.length,
      totalQueries: testQueries.length,
    }
  }

  // BEIR format (default)
  const [corpus, queries, qrels] = await Promise.all([
    loadCorpus(config.dataset, config.blobPrefix || undefined) as Promise<any[]>,
    loadQueries(config.dataset, config.blobPrefix || undefined) as Promise<any[]>,
    loadQrels(config.dataset, config.blobPrefix || undefined) as Promise<any[]>,
  ])
  const qrelsMap = buildQrelsMap(qrels)
  const testQueries = queries.filter(q => qrelsMap.has(String(q['_id'])))

  let goldAnswers: Map<string, string> | undefined
  if (loadGoldAnswers && config.supportsAnswerEval) {
    try {
      goldAnswers = await loadAnswers(config.dataset, config.blobPrefix || undefined)
    } catch {
      console.log('  Warning: Could not load gold answers')
    }
  }

  return {
    corpus,
    testQueries,
    qrelsMap,
    goldAnswers,
    totalCorpus: corpus.length,
    totalQueries: testQueries.length,
  }
}

// ── Ingestion ──

export interface IngestResult {
  ingestDuration: number
  totalChunks: number
  tripleErrors: number
}

export async function runIngestion(
  d: CoreInit['d'],
  bucketId: string,
  corpus: Record<string, unknown>[],
  config: BenchmarkConfig,
  opts?: {
    concurrency?: number
    docMapper?: (doc: Record<string, unknown>) => { id: string; title: string; content: string; updatedAt: Date; metadata: Record<string, unknown> }
  },
): Promise<IngestResult> {
  const chunkSize = resolveChunkSize(config)
  const chunkOverlap = resolveChunkOverlap(config)
  const embModel = resolveEmbeddingModel(config)
  const batchSize = BATCH_SIZE

  console.log(`  Config: chunk_size=${chunkSize}, chunk_overlap=${chunkOverlap}, embedding=${embModel}`)
  if (config.variant === 'neural') {
    console.log('  Note: Neural mode — LLM triple extraction per chunk (slower)')
  }

  const ingestStart = performance.now()
  let ingested = 0
  let totalChunks = 0
  let tripleErrors = 0
  let batchNum = 0
  const totalBatches = Math.ceil(corpus.length / batchSize)

  const defaultDocMapper = (doc: Record<string, unknown>) => {
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
  }

  const mapDoc = opts?.docMapper ?? defaultDocMapper

  for (let i = 0; i < corpus.length; i += batchSize) {
    batchNum++
    const batch = corpus.slice(i, i + batchSize)
    const batchStart = performance.now()
    const docs = batch.map(mapDoc)

    try {
      const ingestOpts: any = {
        chunkSize, chunkOverlap,
        deduplicateBy: ['content'],
        propagateMetadata: ['metadata.corpusId'],
      }
      const indexOpts = opts?.concurrency ? { concurrency: opts.concurrency } : undefined

      const result = await d.ingest(bucketId, docs, ingestOpts, indexOpts)
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
        `  Batch ${batchNum}/${totalBatches}: ${batch.length} docs — FAILED (error)`
      )
    }
  }

  const ingestDuration = (performance.now() - ingestStart) / 1000
  console.log(`  Ingestion complete: ${ingestDuration.toFixed(1)}s, ${ingested} docs, ${totalChunks} chunks (${(ingested / ingestDuration).toFixed(0)} docs/sec)`)
  if (tripleErrors > 0) {
    console.log(`  Errors (non-blocking): ${tripleErrors}`)
  }

  return { ingestDuration, totalChunks, tripleErrors }
}

// ── Latency Profiling ──

export interface LatencyProfile {
  dbRoundTripMs: number
  embeddingRoundTripMs: number
  environment: 'ci' | 'local'
}

/**
 * Measures baseline network latency to Neon DB and embedding API.
 * Runs a few probe calls (adds ~2-3s) to establish a latency baseline
 * that separates network overhead from actual query processing time.
 */
export async function measureLatencyProfile(
  adapter: CoreInit['adapter'],
): Promise<LatencyProfile> {
  const probeSql = (adapter as any).sql as (q: string, p?: unknown[]) => Promise<unknown[]>

  // Warm up
  await probeSql('SELECT 1')

  // DB round-trip: median of 5 calls
  const dbTimes: number[] = []
  for (let i = 0; i < 5; i++) {
    const s = performance.now()
    await probeSql('SELECT 1')
    dbTimes.push(performance.now() - s)
  }
  dbTimes.sort((a, b) => a - b)
  const dbRoundTripMs = dbTimes[Math.floor(dbTimes.length / 2)]!

  // Embedding API round-trip: median of 3 calls
  const embModel = resolveEmbeddingModel({ embeddingModel: undefined } as any)
  const embTimes: number[] = []
  for (let i = 0; i < 3; i++) {
    const s = performance.now()
    const model = gateway.embeddingModel(embModel)
    await model.doEmbed({ values: [`latency probe ${i}`] })
    embTimes.push(performance.now() - s)
  }
  embTimes.sort((a, b) => a - b)
  const embeddingRoundTripMs = embTimes[Math.floor(embTimes.length / 2)]!

  // Heuristic: CI typically has <40ms DB round-trip
  const environment = dbRoundTripMs < 40 ? 'ci' : 'local' as const

  console.log(`  Latency baseline: db=${dbRoundTripMs.toFixed(0)}ms, embedding=${embeddingRoundTripMs.toFixed(0)}ms (${environment})`)

  return { dbRoundTripMs, embeddingRoundTripMs, environment }
}

// ── Query Execution ──

export interface QueryResult {
  allResults: Map<string, string[]>
  allChunkResults?: Map<string, Array<{ content: string; score: number; metadata: Record<string, unknown> }>>
  queryDuration: number
  avgQueryMs: number
}

export async function runQueries(
  d: CoreInit['d'],
  bucketId: string,
  testQueries: Record<string, unknown>[],
  mode: string,
  opts?: {
    queryFetch?: number
    returnChunks?: boolean
    timeoutMs?: number
  },
): Promise<QueryResult> {
  const queryFetch = opts?.queryFetch ?? QUERY_FETCH
  const queryStart = performance.now()
  const allResults = new Map<string, string[]>()
  const allChunkResults = opts?.returnChunks
    ? new Map<string, Array<{ content: string; score: number; metadata: Record<string, unknown> }>>()
    : undefined

  let queriesDone = 0

  for (const query of testQueries) {
    const queryId = String(query['_id'])
    const queryText = String(query['text'])

    const response = await d.query(queryText, {
      mode: mode as any,
      count: queryFetch,
      buckets: [bucketId],
    })

    allResults.set(queryId, deduplicateToDocuments(response.results, K))

    if (allChunkResults) {
      allChunkResults.set(queryId, response.results.map(r => ({
        content: r.content,
        score: r.score,
        metadata: r.metadata,
      })))
    }

    queriesDone++
    if (queriesDone % 20 === 0 || queriesDone === testQueries.length) {
      process.stdout.write(`\r  Queries: ${queriesDone}/${testQueries.length}`)
    }
  }

  const queryDuration = (performance.now() - queryStart) / 1000
  const avgQueryMs = (queryDuration * 1000) / testQueries.length
  console.log(`\n  Queries complete: ${queryDuration.toFixed(1)}s (avg ${avgQueryMs.toFixed(1)}ms/query)`)

  return { allResults, allChunkResults, queryDuration, avgQueryMs }
}

// ── Metrics ──

export function computeMetrics(
  config: BenchmarkConfig,
  allResults: Map<string, string[]>,
  qrelsMap: Map<string, Map<string, number>>,
): { metrics: BenchmarkMetrics; scored: number } {
  if (config.scorer === 'extended') {
    return scoreAllQueriesExtended(allResults, qrelsMap, K)
  }
  return scoreAllQueries(allResults, qrelsMap, K)
}

// ── Result Construction ──

export function buildResult(
  config: BenchmarkConfig,
  mode: string,
  corpusSize: number,
  scored: number,
  metrics: BenchmarkMetrics,
  timing: { ingestDuration?: number; avgQueryMs: number; totalStart: number; latency?: LatencyProfile },
  extraConfig?: Record<string, unknown>,
): BenchmarkResult {
  const embModel = resolveEmbeddingModel(config)
  const embDims = resolveEmbeddingDims(config)
  const chunkSize = resolveChunkSize(config)
  const chunkOverlap = resolveChunkOverlap(config)

  const baseConfig: Record<string, unknown> = {
    embedding: embModel,
    embeddingDims: embDims,
    chunkSize,
    chunkOverlap,
    queryFetch: QUERY_FETCH,
  }

  if (config.variant === 'neural') {
    baseConfig.llm = LLM_MODEL
  }

  return {
    benchmark: config.displayName,
    dataset: config.dataset,
    mode,
    variant: config.variant,
    corpus: corpusSize,
    queries: scored,
    k: K,
    metrics,
    timing: {
      ingestionSeconds: timing.ingestDuration ? Number(timing.ingestDuration.toFixed(1)) : undefined,
      avgQueryMs: Number(timing.avgQueryMs.toFixed(1)),
      totalSeconds: Number(((performance.now() - timing.totalStart) / 1000).toFixed(1)),
      ...(timing.latency ? {
        latency: {
          dbRoundTripMs: Number(timing.latency.dbRoundTripMs.toFixed(0)),
          embeddingRoundTripMs: Number(timing.latency.embeddingRoundTripMs.toFixed(0)),
          environment: timing.latency.environment,
        },
      } : {}),
    },
    config: { ...baseConfig, ...extraConfig },
  }
}

// ── Output ──

export function emitResults(results: BenchmarkResult | BenchmarkResult[]): void {
  const arr = Array.isArray(results) ? results : [results]
  for (const r of arr) {
    printResults(r)
  }

  console.log('---BENCH_RESULT_JSON---')
  console.log(JSON.stringify(arr.length === 1 ? arr[0] : arr, null, 2))
  console.log('---END_BENCH_RESULT_JSON---')
  console.log('══════════════════════════════════════════════════════')
}

// ── Banner ──

export function printBanner(config: BenchmarkConfig, cliArgs: CliArgs): void {
  const modeLabel = config.variant === 'neural'
    ? 'Graph (Neural Search)'
    : 'Core (Hybrid + Fast)'

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log(`║  ${config.displayName} — d8um ${modeLabel}`.padEnd(63) + '║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  if (cliArgs.validate) {
    console.log('  Mode: VALIDATE (smoke test — 5 docs, 5 queries)')
  } else if (cliArgs.shouldSeed) {
    console.log('  Mode: seed + query')
  } else if (cliArgs.evalAnswersOnly) {
    console.log(`  Mode: answer-only eval (limit=${cliArgs.evalAnswersLimit}, model=${cliArgs.evalLlmModel})`)
  } else {
    console.log('  Mode: query-only (use --seed to re-index)')
  }
  console.log()
}
