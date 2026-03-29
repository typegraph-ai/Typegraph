#!/usr/bin/env npx tsx
/**
 * seed-multihop-answers.ts
 *
 * Downloads gold answers from the yixuantt/MultiHopRAG HuggingFace dataset
 * and uploads them to Vercel Blob as answers.json.
 *
 * This is a one-time script — once answers.json exists, the benchmark
 * --eval-answers flag can compute EM/F1 metrics.
 *
 * Required env vars:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob read/write token
 *
 * Optional env vars:
 *   HF_TOKEN               — HuggingFace API token (better rate limits)
 *
 * Usage:
 *   npx tsx scripts/seed-multihop-answers.ts
 */

import { put, list } from '@vercel/blob'
import { parquetRead } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

const BLOB_PATH = 'datasets/multihop-rag/answers.json'
const HF_DATASET = 'yixuantt/MultiHopRAG'
const HF_PARQUET_API = 'https://datasets-server.huggingface.co/parquet'

function hfHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function blobExists(pathname: string): Promise<boolean> {
  const { blobs } = await list({ prefix: pathname, limit: 1 })
  return blobs.some(b => b.pathname === pathname)
}

async function parseParquet(buffer: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  await parquetRead({
    file: buffer,
    compressors,
    onComplete: (data: Record<string, unknown>[]) => rows.push(...data),
  })
  return rows
}

async function main() {
  console.log('Seed MultiHop-RAG answers.json')
  console.log()

  if (await blobExists(BLOB_PATH)) {
    console.log(`  ${BLOB_PATH} already exists in blob storage — skipping`)
    return
  }

  // Fetch parquet index
  console.log('  Fetching parquet index...')
  const url = `${HF_PARQUET_API}?dataset=${encodeURIComponent(HF_DATASET)}`
  const res = await fetch(url, { headers: hfHeaders() })
  if (!res.ok) throw new Error(`HF API error: ${res.status}`)
  const data = (await res.json()) as { parquet_files: { config: string; split: string; url: string }[] }

  // Find query parquet files (queries contain the 'answer' field)
  // MultiHopRAG uses config='MultiHopRAG' (not 'queries') for the QA split
  const queryFiles = data.parquet_files.filter(f => f.config === 'MultiHopRAG' && f.split === 'train')
  if (queryFiles.length === 0) {
    const configs = [...new Set(data.parquet_files.map(f => f.config))].join(', ')
    throw new Error(`No query parquet files found (available configs: ${configs})`)
  }
  console.log(`  Found ${queryFiles.length} query parquet file(s)`)

  // Download and parse
  const rawQueries: Record<string, unknown>[] = []
  for (const file of queryFiles) {
    console.log(`  Downloading ${file.url.split('/').pop()}...`)
    const parquetRes = await fetch(file.url, { headers: hfHeaders() })
    if (!parquetRes.ok) throw new Error(`Download failed: ${parquetRes.status}`)
    rawQueries.push(...await parseParquet(await parquetRes.arrayBuffer()))
  }
  console.log(`  Parsed ${rawQueries.length} raw queries`)

  // Extract answers (same ID assignment as seed-datasets.ts)
  const answers: { _id: string; answer: string }[] = []
  let idx = 0
  for (const q of rawQueries) {
    if (String(q['question_type'] ?? '') === 'null_query') continue
    const answer = String(q['answer'] ?? '')
    if (answer) {
      answers.push({ _id: String(idx), answer })
    }
    idx++
  }
  console.log(`  ${answers.length} answers extracted (${rawQueries.length - answers.length} null/empty filtered)`)

  // Upload
  const json = JSON.stringify(answers)
  console.log(`  Uploading ${(json.length / 1024).toFixed(0)} KB to ${BLOB_PATH}...`)
  await put(BLOB_PATH, json, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
  })
  console.log(`  Done.`)
}

main().catch(err => { console.error('Failed:', err); process.exit(1) })
