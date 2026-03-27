#!/usr/bin/env npx tsx
/**
 * NFCorpus Benchmark — d8um Graph (Neural Search)
 *
 * Runs the full BEIR NFCorpus benchmark (3,633 docs, 323 queries)
 * using d8um graph with neural search (hybrid + memory recall + PPR graph traversal).
 *
 * During ingestion, an LLM extracts S-P-O triples from each chunk, building
 * a knowledge graph that powers Personalized PageRank at query time.
 *
 * Prerequisites:
 *   npm install @d8um/core @d8um/adapter-sqlite-vec @d8um/graph @ai-sdk/gateway ai
 *   export AI_GATEWAY_API_KEY=your-key
 *
 * Usage:
 *   npx tsx run-neural.ts
 */

import { d8umCreate } from '@d8um/core'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'
import { createGraphBridge } from '@d8um/graph'
import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { existsSync, unlinkSync, writeFileSync } from 'fs'

// ── Configuration ──

const DB_PATH = './nfcorpus-neural.db'
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const LLM_MODEL = 'google/gemini-3.1-flash-lite-preview'
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 64
const K = 10

const HF_BASE = 'https://datasets-server.huggingface.co'

// ── LLM Provider (wraps AI SDK gateway for d8um's LLMProvider interface) ──

function createLLMProvider() {
  const model = gateway(LLM_MODEL)

  return {
    async generateText(prompt: string, systemPrompt?: string): Promise<string> {
      const result = await generateText({
        model,
        prompt,
        ...(systemPrompt ? { system: systemPrompt } : {}),
      })
      return result.text
    },

    async generateJSON<T = unknown>(prompt: string, systemPrompt?: string): Promise<T> {
      const result = await generateText({
        model,
        prompt: prompt + '\n\nRespond with valid JSON only, no markdown fences.',
        ...(systemPrompt ? { system: systemPrompt } : {}),
      })
      // Strip markdown fences if present
      const text = result.text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
      return JSON.parse(text) as T
    },
  }
}

// ── HuggingFace Data Fetching ──

interface HFResponse {
  rows: Array<{ row: Record<string, unknown> }>
  num_rows_total: number
}

async function fetchAllRows(
  dataset: string,
  config: string,
  split: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let offset = 0
  const pageSize = 100

  process.stdout.write(`  Fetching ${dataset} (${config}/${split})...`)

  while (true) {
    const url = `${HF_BASE}/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${pageSize}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HuggingFace API error: ${res.status} ${res.statusText}`)
    const data = (await res.json()) as HFResponse
    rows.push(...data.rows.map(r => r.row))
    if (rows.length >= data.num_rows_total) break
    offset += pageSize
  }

  console.log(` ${rows.length} rows`)
  return rows
}

// ── IR Metrics ──

function dcg(relevances: number[], k: number): number {
  let sum = 0
  for (let i = 0; i < Math.min(relevances.length, k); i++) {
    sum += relevances[i]! / Math.log2(i + 2)
  }
  return sum
}

function ndcg(retrieved: string[], relevant: Map<string, number>, k: number): number {
  const retrievedRels = retrieved.slice(0, k).map(id => relevant.get(id) ?? 0)
  const actualDCG = dcg(retrievedRels, k)
  const idealRels = [...relevant.values()].sort((a, b) => b - a)
  const idealDCG = dcg(idealRels, k)
  return idealDCG === 0 ? 0 : actualDCG / idealDCG
}

function averagePrecision(retrieved: string[], relevant: Set<string>, k: number): number {
  let hits = 0
  let sum = 0
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (relevant.has(retrieved[i]!)) {
      hits++
      sum += hits / (i + 1)
    }
  }
  return relevant.size === 0 ? 0 : sum / relevant.size
}

function recall(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = new Set(retrieved.slice(0, k))
  let hits = 0
  for (const id of relevant) {
    if (topK.has(id)) hits++
  }
  return relevant.size === 0 ? 0 : hits / relevant.size
}

function precision(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k)
  let hits = 0
  for (const id of topK) {
    if (relevant.has(id)) hits++
  }
  return topK.length === 0 ? 0 : hits / topK.length
}

// ── Main ──

async function main() {
  const totalStart = performance.now()

  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  NFCorpus Benchmark — d8um Graph (Neural Search)    ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log()

  // Clean up any previous run
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH)

  // ── Phase 1: Initialize d8um with graph bridge ──
  console.log('Phase 1: Initializing d8um with graph bridge...')

  const adapter = new SqliteVecAdapter({ dbPath: DB_PATH })
  const llm = createLLMProvider()
  const embeddingModel = gateway.textEmbeddingModel(EMBEDDING_MODEL)

  // The embedding config used by d8um core
  const embeddingConfig = { model: embeddingModel, dimensions: EMBEDDING_DIMS }

  // Create graph bridge — implements all GraphBridge methods including
  // addTriple, searchEntities, getAdjacencyList, getChunksForEntities
  // which enable the full neural query pipeline (PPR graph traversal).
  const graph = createGraphBridge({
    memoryStore: adapter as any, // SqliteVecAdapter implements MemoryStoreAdapter methods
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
    scope: { agentId: 'nfcorpus-benchmark' },
  })

  const d = await d8umCreate({
    vectorStore: adapter,
    embedding: embeddingConfig,
    llm,
    graph,
  })

  console.log('  d8um initialized with graph bridge + neural search')
  console.log('  LLM: ' + LLM_MODEL + ' (triple extraction during ingest)')
  console.log()

  // ── Phase 2: Download NFCorpus ──
  console.log('Phase 2: Downloading NFCorpus from HuggingFace...')

  const [corpus, queries, qrels] = await Promise.all([
    fetchAllRows('BeIR/nfcorpus', 'corpus', 'corpus'),
    fetchAllRows('BeIR/nfcorpus', 'queries', 'queries'),
    fetchAllRows('BeIR/nfcorpus-qrels', 'default', 'test'),
  ])

  // Build qrels lookup: queryId → Map<corpusId, relevance>
  const qrelsMap = new Map<string, Map<string, number>>()
  for (const qrel of qrels) {
    const queryId = String(qrel['query-id'])
    const corpusId = String(qrel['corpus-id'])
    const score = Number(qrel['score'])
    if (!qrelsMap.has(queryId)) qrelsMap.set(queryId, new Map())
    qrelsMap.get(queryId)!.set(corpusId, score)
  }

  const testQueries = queries.filter(q => qrelsMap.has(String(q['_id'])))
  console.log(`  Test queries with relevance judgments: ${testQueries.length}`)
  console.log()

  // ── Phase 3: Ingest Corpus (with triple extraction) ──
  console.log(`Phase 3: Ingesting ${corpus.length} documents (with LLM triple extraction)...`)
  console.log('  Note: This is slower than core due to LLM calls per chunk.')
  const ingestStart = performance.now()

  const bucket = await d.buckets.create({ name: 'nfcorpus' })

  let ingested = 0
  let tripleErrors = 0

  for (const doc of corpus) {
    const docId = String(doc['_id'])
    const title = String(doc['title'] ?? '')
    const text = String(doc['text'] ?? '')

    try {
      await d.ingest(
        bucket.id,
        [{
          id: docId,
          title,
          content: title ? `${title}\n\n${text}` : text,
          updatedAt: new Date(),
          metadata: { corpusId: docId },
        }],
        {
          chunkSize: CHUNK_SIZE,
          chunkOverlap: CHUNK_OVERLAP,
          deduplicateBy: ['content'],
        },
      )
    } catch {
      tripleErrors++
    }

    ingested++
    if (ingested % 100 === 0 || ingested === corpus.length) {
      const elapsed = (performance.now() - ingestStart) / 1000
      const rate = ingested / elapsed
      const eta = (corpus.length - ingested) / rate
      process.stdout.write(
        `\r  Ingested: ${ingested}/${corpus.length} (${rate.toFixed(0)} docs/sec, ETA: ${Math.ceil(eta)}s)`,
      )
    }
  }

  const ingestDuration = (performance.now() - ingestStart) / 1000
  console.log(`\n  Ingestion complete: ${ingestDuration.toFixed(1)}s (${(ingested / ingestDuration).toFixed(0)} docs/sec)`)
  if (tripleErrors > 0) {
    console.log(`  Triple extraction errors (non-blocking): ${tripleErrors}`)
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
      buckets: [bucket.id],
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

  let sumNDCG = 0
  let sumAP = 0
  let sumRecall = 0
  let sumPrecision = 0
  let scored = 0

  for (const [queryId, retrieved] of allResults) {
    const rels = qrelsMap.get(queryId)
    if (!rels) continue

    const relevantSet = new Set(
      [...rels.entries()].filter(([, score]) => score > 0).map(([id]) => id),
    )

    sumNDCG += ndcg(retrieved, rels, K)
    sumAP += averagePrecision(retrieved, relevantSet, K)
    sumRecall += recall(retrieved, relevantSet, K)
    sumPrecision += precision(retrieved, relevantSet, K)
    scored++
  }

  const metrics = {
    'nDCG@10': sumNDCG / scored,
    'MAP@10': sumAP / scored,
    'Recall@10': sumRecall / scored,
    'Precision@10': sumPrecision / scored,
  }

  const totalDuration = (performance.now() - totalStart) / 1000

  // ── Phase 6: Results ──
  console.log()
  console.log('══════════════════════════════════════════════════════')
  console.log('  NFCorpus Benchmark — d8um Graph (Neural Search)')
  console.log('══════════════════════════════════════════════════════')
  console.log()
  console.log(`  Corpus:        ${corpus.length.toLocaleString()} documents ingested`)
  console.log(`  Queries:       ${scored} (full BEIR test set)`)
  console.log(`  Mode:          neural (hybrid + memory + PPR graph, RRF fusion)`)
  console.log(`  LLM:           ${LLM_MODEL} (ingest only)`)
  console.log()
  console.log('  ── Retrieval Scores ──')
  console.log(`  nDCG@10:       ${metrics['nDCG@10'].toFixed(4)}`)
  console.log(`  MAP@10:        ${metrics['MAP@10'].toFixed(4)}`)
  console.log(`  Recall@10:     ${metrics['Recall@10'].toFixed(4)}`)
  console.log(`  Precision@10:  ${metrics['Precision@10'].toFixed(4)}`)
  console.log()
  console.log('  ── Reference Baselines ──')
  console.log('  BM25:          nDCG@10 = 0.325')
  console.log()
  console.log('  ── Timing ──')
  console.log(`  Ingestion:     ${ingestDuration.toFixed(1)}s (${(ingested / ingestDuration).toFixed(0)} docs/sec)`)
  console.log(`  Avg Query:     ${avgQueryMs.toFixed(1)}ms`)
  console.log(`  Total:         ${Math.floor(totalDuration / 60)}m ${(totalDuration % 60).toFixed(0)}s`)
  console.log()

  // Save results
  const resultsFile = './nfcorpus-results-neural.json'
  const output = {
    benchmark: 'NFCorpus (BEIR)',
    mode: 'neural',
    variant: 'graph',
    corpus: corpus.length,
    queries: scored,
    k: K,
    metrics,
    timing: {
      ingestionSeconds: Number(ingestDuration.toFixed(1)),
      avgQueryMs: Number(avgQueryMs.toFixed(1)),
      totalSeconds: Number(totalDuration.toFixed(1)),
    },
    config: {
      embedding: EMBEDDING_MODEL,
      embeddingDims: EMBEDDING_DIMS,
      llm: LLM_MODEL,
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    },
    tripleExtractionErrors: tripleErrors,
  }
  writeFileSync(resultsFile, JSON.stringify(output, null, 2))
  console.log(`  Results: ${resultsFile}`)
  console.log('══════════════════════════════════════════════════════')
  console.log()

  // ── Phase 7: Cleanup ──
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH)
  console.log('Cleanup complete. Database removed.')
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
