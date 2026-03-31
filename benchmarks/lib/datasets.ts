/**
 * datasets.ts — Download benchmark datasets from Vercel Blob Storage
 *
 * Datasets are seeded once via scripts/seed-datasets.ts (HF Parquet → Blob).
 * These helpers fetch the cached JSON for use in benchmark scripts.
 *
 * Supports both BEIR-format datasets and custom formats (legal-rag-bench).
 */

import { list } from '@vercel/blob'

// ── BEIR Format Types ──

export interface BeirCorpusRow {
  _id: string
  title: string
  text: string
}

export interface BeirQueryRow {
  _id: string
  text: string
}

export interface BeirQrelRow {
  'query-id': string | number
  'corpus-id': string | number
  score: number
}

// ── Legal RAG Bench Types ──

export interface LegalRagCorpusRow {
  id: string
  title: string
  text: string
  footnotes: string
}

export interface LegalRagQaRow {
  id: number
  question: string
  answer: string
  relevant_passage_id: string
}

// ── Generic Blob Fetcher ──

async function fetchBlobJson<T>(blobPath: string): Promise<T> {
  const { blobs } = await list({ prefix: blobPath, limit: 1 })
  const blob = blobs.find(b => b.pathname === blobPath)
  if (!blob) {
    throw new Error(`Dataset not found in blob storage: ${blobPath}\nRun: npx tsx scripts/seed-datasets.ts`)
  }
  const res = await fetch(blob.downloadUrl, {
    headers: process.env.BLOB_READ_WRITE_TOKEN
      ? { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
      : {},
  })
  if (!res.ok) {
    throw new Error(`Failed to download ${blobPath}: ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Answer Types ──

export interface AnswerRow {
  _id: string
  answer: string
}

// ── BEIR Dataset Loaders ──

export async function loadCorpus(dataset: string, blobPrefix = 'datasets/beir'): Promise<BeirCorpusRow[]> {
  console.log(`  Loading ${dataset}/corpus from blob storage...`)
  const rows = await fetchBlobJson<BeirCorpusRow[]>(`${blobPrefix}/${dataset}/corpus.json`)
  console.log(`  ✓ ${rows.length.toLocaleString()} corpus documents`)
  return rows
}

export async function loadQueries(dataset: string, blobPrefix = 'datasets/beir'): Promise<BeirQueryRow[]> {
  console.log(`  Loading ${dataset}/queries from blob storage...`)
  const rows = await fetchBlobJson<BeirQueryRow[]>(`${blobPrefix}/${dataset}/queries.json`)
  console.log(`  ✓ ${rows.length.toLocaleString()} queries`)
  return rows
}

export async function loadQrels(dataset: string, blobPrefix = 'datasets/beir'): Promise<BeirQrelRow[]> {
  console.log(`  Loading ${dataset}/qrels from blob storage...`)
  const rows = await fetchBlobJson<BeirQrelRow[]>(`${blobPrefix}/${dataset}/qrels.json`)
  console.log(`  ✓ ${rows.length.toLocaleString()} relevance judgments`)
  return rows
}

export async function loadAnswers(dataset: string, blobPrefix = 'datasets/beir'): Promise<Map<string, string>> {
  console.log(`  Loading ${dataset}/answers from blob storage...`)
  const rows = await fetchBlobJson<AnswerRow[]>(`${blobPrefix}/${dataset}/answers.json`)
  const map = new Map<string, string>()
  for (const row of rows) map.set(row._id, row.answer)
  console.log(`  \u2713 ${map.size.toLocaleString()} gold answers`)
  return map
}

/**
 * Build the standard qrels lookup: queryId → Map<corpusId, relevance>
 */
export function buildQrelsMap(qrels: BeirQrelRow[]): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>()
  for (const qrel of qrels) {
    const queryId = String(qrel['query-id'])
    const corpusId = String(qrel['corpus-id'])
    const score = Number(qrel['score'])
    if (!map.has(queryId)) map.set(queryId, new Map())
    map.get(queryId)!.set(corpusId, score)
  }
  return map
}

// ── Direct Blob Loaders (for datasets with full blob path in config) ──

export async function loadBlobDirect<T>(blobPath: string, label: string): Promise<T> {
  console.log(`  Loading ${label} from ${blobPath}...`)
  const data = await fetchBlobJson<T>(blobPath)
  const count = Array.isArray(data) ? data.length : 0
  console.log(`  ✓ ${count.toLocaleString()} ${label}`)
  return data
}

export async function loadBlobAnswers(blobPath: string): Promise<Map<string, string>> {
  console.log(`  Loading answers from ${blobPath}...`)
  const rows = await fetchBlobJson<AnswerRow[]>(blobPath)
  const map = new Map<string, string>()
  for (const row of rows) map.set(row._id, row.answer)
  console.log(`  ✓ ${map.size.toLocaleString()} gold answers`)
  return map
}

// ── Legal RAG Bench Loaders ──

export async function loadLegalRagCorpus(): Promise<LegalRagCorpusRow[]> {
  console.log(`  Loading legal-rag-bench/corpus from blob storage...`)
  const rows = await fetchBlobJson<LegalRagCorpusRow[]>(`datasets/isaacus/legal-rag-bench/corpus.json`)
  console.log(`  ✓ ${rows.length.toLocaleString()} corpus passages`)
  return rows
}

export async function loadLegalRagQa(): Promise<LegalRagQaRow[]> {
  console.log(`  Loading legal-rag-bench/qa from blob storage...`)
  const rows = await fetchBlobJson<LegalRagQaRow[]>(`datasets/isaacus/legal-rag-bench/qa.json`)
  console.log(`  ✓ ${rows.length.toLocaleString()} QA pairs`)
  return rows
}

/**
 * Build qrels from Legal RAG Bench QA data.
 * Each QA pair has a single relevant_passage_id with score 1.
 */
export function buildLegalRagQrelsMap(qa: LegalRagQaRow[]): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>()
  for (const row of qa) {
    const queryId = String(row.id)
    map.set(queryId, new Map([[row.relevant_passage_id, 1]]))
  }
  return map
}
