#!/usr/bin/env npx tsx
/**
 * seed-datasets.ts
 *
 * Downloads BeIR benchmark datasets from HuggingFace (via Parquet API — single
 * request per split, no pagination, no rate-limit issues) and uploads them to
 * Vercel Blob Storage as JSON files for persistent caching.
 *
 * Required env vars:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob read/write token
 *
 * Optional env vars:
 *   HF_TOKEN               — HuggingFace API token (better rate limits)
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/seed-datasets.ts
 *
 * Blob storage layout:
 *   datasets/beir/nfcorpus/corpus.json    — [{_id, title, text}, ...]
 *   datasets/beir/nfcorpus/queries.json   — [{_id, text}, ...]
 *   datasets/beir/nfcorpus/qrels.json     — [{query-id, corpus-id, score}, ...]
 *   datasets/beir/scifact/...
 *   datasets/beir/arguana/...
 *   datasets/isaacus/australian-tax-guidance-retrieval/...
 *   datasets/isaacus/contractual-clause-retrieval/...
 *   datasets/isaacus/mleb-scalr/...
 *   datasets/isaacus/license-tldr-retrieval/...
 *   datasets/isaacus/legal-rag-bench/corpus.json   — [{id, title, text, footnotes}, ...]
 *   datasets/isaacus/legal-rag-bench/qa.json        — [{id, question, answer, relevant_passage_id}, ...]
 */

import { put, list } from '@vercel/blob'
import { parquetRead } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

// ── Dataset Definitions ──

interface SplitSource {
  hfDataset: string
  config: string
  split: string
  blobName: string
}

interface DatasetDef {
  name: string
  /** Blob storage prefix (e.g. 'datasets/beir' or 'datasets/isaacus') */
  blobPrefix: string
  sources: SplitSource[]
}

// ── BeIR Datasets ──

const BEIR_DATASETS: DatasetDef[] = [
  {
    name: 'nfcorpus',
    blobPrefix: 'datasets/beir',
    sources: [
      { hfDataset: 'BeIR/nfcorpus', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'BeIR/nfcorpus', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'BeIR/nfcorpus-qrels', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
  {
    name: 'scifact',
    blobPrefix: 'datasets/beir',
    sources: [
      { hfDataset: 'BeIR/scifact', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'BeIR/scifact', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'BeIR/scifact-qrels', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
  {
    name: 'arguana',
    blobPrefix: 'datasets/beir',
    sources: [
      { hfDataset: 'BeIR/arguana', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'BeIR/arguana', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'BeIR/arguana-qrels', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
]

// ── Isaacus Legal Datasets (BEIR-format) ──

const ISAACUS_BEIR_DATASETS: DatasetDef[] = [
  {
    name: 'australian-tax-guidance-retrieval',
    blobPrefix: 'datasets/isaacus',
    sources: [
      { hfDataset: 'isaacus/australian-tax-guidance-retrieval', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'isaacus/australian-tax-guidance-retrieval', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'isaacus/australian-tax-guidance-retrieval', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
  {
    name: 'contractual-clause-retrieval',
    blobPrefix: 'datasets/isaacus',
    sources: [
      { hfDataset: 'isaacus/contractual-clause-retrieval', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'isaacus/contractual-clause-retrieval', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'isaacus/contractual-clause-retrieval', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
  {
    name: 'mleb-scalr',
    blobPrefix: 'datasets/isaacus',
    sources: [
      { hfDataset: 'isaacus/mleb-scalr', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'isaacus/mleb-scalr', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'isaacus/mleb-scalr', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
  {
    name: 'license-tldr-retrieval',
    blobPrefix: 'datasets/isaacus',
    sources: [
      { hfDataset: 'isaacus/license-tldr-retrieval', config: 'corpus', split: 'corpus', blobName: 'corpus' },
      { hfDataset: 'isaacus/license-tldr-retrieval', config: 'queries', split: 'queries', blobName: 'queries' },
      { hfDataset: 'isaacus/license-tldr-retrieval', config: 'default', split: 'test', blobName: 'qrels' },
    ],
  },
]

// ── Isaacus Legal RAG Bench (custom format) ──

const LEGAL_RAG_BENCH: DatasetDef[] = [
  {
    name: 'legal-rag-bench',
    blobPrefix: 'datasets/isaacus',
    sources: [
      { hfDataset: 'isaacus/legal-rag-bench', config: 'corpus', split: 'test', blobName: 'corpus' },
      { hfDataset: 'isaacus/legal-rag-bench', config: 'qa', split: 'test', blobName: 'qa' },
    ],
  },
]

const DATASETS: DatasetDef[] = [
  ...BEIR_DATASETS,
  ...ISAACUS_BEIR_DATASETS,
  ...LEGAL_RAG_BENCH,
]
const BLOB_PREFIXES = [...new Set(DATASETS.map(d => d.blobPrefix))]
const HF_PARQUET_API = 'https://datasets-server.huggingface.co/parquet'

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hfHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

interface ParquetFileInfo {
  dataset: string
  config: string
  split: string
  url: string
  filename: string
  size: number
}

/**
 * Get parquet file download URLs from the HuggingFace datasets-server API.
 * One API call returns ALL splits for a dataset — vastly cheaper than paginated /rows.
 */
async function getParquetUrls(hfDataset: string): Promise<ParquetFileInfo[]> {
  const url = `${HF_PARQUET_API}?dataset=${encodeURIComponent(hfDataset)}`
  const res = await fetch(url, { headers: hfHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Failed to get parquet info for ${hfDataset}: ${res.status} ${res.statusText}\n${body}`)
  }
  const data = (await res.json()) as { parquet_files: ParquetFileInfo[] }
  return data.parquet_files
}

/**
 * Download a parquet file from HuggingFace CDN with retry.
 * These go through the Resolver path (high limits), not datasets-server.
 */
async function downloadParquet(url: string, maxRetries = 4): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: hfHeaders() })
    if (res.ok) return res.arrayBuffer()

    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const waitMs = Math.min(2000 * 2 ** attempt, 30_000)
      process.stdout.write(` (${res.status}, retry in ${(waitMs / 1000).toFixed(0)}s)`)
      await sleep(waitMs)
      continue
    }

    throw new Error(`Failed to download parquet from ${url}: ${res.status}`)
  }
  throw new Error(`Max retries exceeded for ${url}`)
}

/**
 * Parse a parquet file buffer into an array of row objects.
 * Uses hyparquet (pure JS) with full codec support via hyparquet-compressors.
 */
async function parseParquet(buffer: ArrayBuffer): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = []
  await parquetRead({
    file: buffer,
    rowFormat: 'object',
    compressors,
    onComplete: (data: Record<string, unknown>[]) => {
      rows = data
    },
  })
  return rows
}

/**
 * Check if a blob already exists at the given pathname.
 */
async function blobExists(pathname: string): Promise<boolean> {
  const { blobs } = await list({ prefix: pathname, limit: 1 })
  return blobs.some(b => b.pathname === pathname)
}

// ── Main ──

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Error: BLOB_READ_WRITE_TOKEN env var is required.')
    console.error('Get one from: Vercel Dashboard → Storage → Blob → Tokens')
    process.exit(1)
  }

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  BeIR Dataset Seeder → Vercel Blob Storage       ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log()
  console.log(`  HuggingFace token: ${process.env.HF_TOKEN ? '✓ authenticated' : 'anonymous (set HF_TOKEN for better limits)'}`)
  console.log(`  Blob prefixes:     ${BLOB_PREFIXES.join(', ')}`)
  console.log(`  Datasets:          ${DATASETS.map(d => d.name).join(', ')}`)
  console.log()

  // Cache: parquet URL listings per hfDataset (avoid duplicate API calls)
  const parquetCache = new Map<string, ParquetFileInfo[]>()

  let totalUploaded = 0
  let totalSkipped = 0

  for (const dataset of DATASETS) {
    console.log(`── ${dataset.name} ${'─'.repeat(40 - dataset.name.length)}`)

    for (const source of dataset.sources) {
      const blobPath = `${dataset.blobPrefix}/${dataset.name}/${source.blobName}.json`

      // Idempotent: skip if already uploaded
      if (await blobExists(blobPath)) {
        console.log(`  ${source.blobName.padEnd(8)} skipped (already in blob storage)`)
        totalSkipped++
        continue
      }

      // Get parquet file URLs (cached per hfDataset)
      if (!parquetCache.has(source.hfDataset)) {
        process.stdout.write(`  ${source.blobName.padEnd(8)} fetching parquet index for ${source.hfDataset}...`)
        const files = await getParquetUrls(source.hfDataset)
        parquetCache.set(source.hfDataset, files)
        process.stdout.write('\r' + ' '.repeat(80) + '\r')
        await sleep(300)
      }

      const allParquetFiles = parquetCache.get(source.hfDataset)!
      const matching = allParquetFiles.filter(
        f => f.config === source.config && f.split === source.split,
      )

      if (matching.length === 0) {
        console.log(`  ${source.blobName.padEnd(8)} ⚠ no parquet files for ${source.config}/${source.split}`)
        continue
      }

      // Download + parse all parquet files for this split
      const allRows: Record<string, unknown>[] = []
      for (let i = 0; i < matching.length; i++) {
        const file = matching[i]!
        const sizeKB = (file.size / 1024).toFixed(0)
        const fileLabel = matching.length > 1 ? ` [${i + 1}/${matching.length}]` : ''

        process.stdout.write(`\r  ${source.blobName.padEnd(8)} downloading${fileLabel} (${sizeKB} KB)...`)
        const buffer = await downloadParquet(file.url)

        process.stdout.write(`\r  ${source.blobName.padEnd(8)} parsing${fileLabel}...` + ' '.repeat(20))
        const rows = await parseParquet(buffer)
        allRows.push(...rows)
      }

      // Upload to Vercel Blob
      process.stdout.write(`\r  ${source.blobName.padEnd(8)} uploading ${allRows.length.toLocaleString()} rows...` + ' '.repeat(20))
      const json = JSON.stringify(allRows, (_key, value) =>
        typeof value === 'bigint' ? Number(value) : value,
      )
      const { url } = await put(blobPath, json, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      })

      const jsonKB = (json.length / 1024).toFixed(0)
      console.log(`\r  ${source.blobName.padEnd(8)} ✓ ${allRows.length.toLocaleString()} rows (${jsonKB} KB) → ${blobPath}`)
      totalUploaded++

      await sleep(300)
    }

    console.log()
  }

  // ── MultiHop-RAG: custom BEIR-format transform ──
  // Downloaded raw, then transformed to BEIR format with evidence→document qrels.
  // Separate from the main loop because it needs cross-source post-processing.

  const mhBlobPrefix = 'datasets/multihop-rag'
  const mhCorpusPath = `${mhBlobPrefix}/corpus.json`
  const mhQueriesPath = `${mhBlobPrefix}/queries.json`
  const mhQrelsPath = `${mhBlobPrefix}/qrels.json`

  const mhAllExist = await blobExists(mhCorpusPath)
    && await blobExists(mhQueriesPath)
    && await blobExists(mhQrelsPath)

  if (mhAllExist) {
    console.log(`── multihop-rag ${'─'.repeat(26)}`)
    console.log('  corpus   skipped (already in blob storage)')
    console.log('  queries  skipped (already in blob storage)')
    console.log('  qrels    skipped (already in blob storage)')
    console.log()
    totalSkipped += 3
  } else {
    console.log(`── multihop-rag ${'─'.repeat(26)}`)

    // Fetch parquet index (one API call, cached)
    const mhHfDataset = 'yixuantt/MultiHopRAG'
    if (!parquetCache.has(mhHfDataset)) {
      process.stdout.write('  fetching parquet index...')
      const files = await getParquetUrls(mhHfDataset)
      parquetCache.set(mhHfDataset, files)
      process.stdout.write('\r' + ' '.repeat(60) + '\r')
      await sleep(300)
    }

    const mhParquetFiles = parquetCache.get(mhHfDataset)!

    // Download corpus
    const corpusFiles = mhParquetFiles.filter(f => f.config === 'corpus' && f.split === 'train')
    const rawCorpus: Record<string, unknown>[] = []
    for (const file of corpusFiles) {
      process.stdout.write(`\r  corpus   downloading (${(file.size / 1024).toFixed(0)} KB)...`)
      const buf = await downloadParquet(file.url)
      process.stdout.write(`\r  corpus   parsing...` + ' '.repeat(30))
      rawCorpus.push(...await parseParquet(buf))
    }

    // Download queries
    const queryFiles = mhParquetFiles.filter(f => f.config === 'MultiHopRAG' && f.split === 'train')
    const rawQueries: Record<string, unknown>[] = []
    for (const file of queryFiles) {
      process.stdout.write(`\r  queries  downloading (${(file.size / 1024).toFixed(0)} KB)...`)
      const buf = await downloadParquet(file.url)
      process.stdout.write(`\r  queries  parsing...` + ' '.repeat(30))
      rawQueries.push(...await parseParquet(buf))
    }

    // Transform corpus to BEIR format: {_id, title, text}
    const beirCorpus = rawCorpus.map((doc, i) => ({
      _id: String(i),
      title: String(doc['title'] ?? ''),
      text: String(doc['body'] ?? doc['text'] ?? ''),
    }))

    // Pre-normalize corpus for evidence matching
    const normalize = (s: string) => s.replace(/[\s\n]+/g, '')
    const normalizedDocs = beirCorpus.map(doc => ({
      id: doc._id,
      normalized: normalize(doc.text),
    }))

    // Transform queries + generate qrels via evidence→document substring matching
    const beirQueries: { _id: string; text: string }[] = []
    const beirQrels: { 'query-id': string; 'corpus-id': string; score: number }[] = []
    let nullFiltered = 0
    let unmatchedEvidence = 0

    for (let qi = 0; qi < rawQueries.length; qi++) {
      const q = rawQueries[qi]!
      if (String(q['question_type'] ?? '') === 'null_query') {
        nullFiltered++
        continue
      }

      const queryId = String(beirQueries.length)
      beirQueries.push({ _id: queryId, text: String(q['query'] ?? q['question'] ?? '') })

      // Extract evidence list — handle both array-of-strings and array-of-objects
      const evidenceRaw = q['evidence_list'] ?? q['gold_list'] ?? q['fact_list'] ?? []
      const evidences: string[] = Array.isArray(evidenceRaw)
        ? evidenceRaw.map((e: unknown) =>
            typeof e === 'string' ? e : String((e as Record<string, unknown>)['fact'] ?? (e as Record<string, unknown>)['text'] ?? e),
          )
        : []

      const matchedDocIds = new Set<string>()
      for (const ev of evidences) {
        const normEv = normalize(ev)
        if (!normEv) continue
        for (const doc of normalizedDocs) {
          if (doc.normalized.includes(normEv)) {
            matchedDocIds.add(doc.id)
          }
        }
        if (matchedDocIds.size === 0) unmatchedEvidence++
      }

      for (const docId of matchedDocIds) {
        beirQrels.push({ 'query-id': queryId, 'corpus-id': docId, score: 1 })
      }
    }

    process.stdout.write('\r' + ' '.repeat(60) + '\r')
    console.log(`  corpus   ${beirCorpus.length} docs (transformed to BEIR format)`)
    console.log(`  queries  ${beirQueries.length} queries (${nullFiltered} null_query filtered)`)
    console.log(`  qrels    ${beirQrels.length} relevance judgments`)
    if (unmatchedEvidence > 0) {
      console.log(`  warning  ${unmatchedEvidence} evidence snippets had no corpus match`)
    }

    // Upload all three
    const uploads: [string, unknown[]][] = [
      [mhCorpusPath, beirCorpus],
      [mhQueriesPath, beirQueries],
      [mhQrelsPath, beirQrels],
    ]

    for (const [blobPath, data] of uploads) {
      const label = blobPath.split('/').pop()!.replace('.json', '').padEnd(8)
      if (await blobExists(blobPath)) {
        console.log(`  ${label} skipped (already in blob storage)`)
        totalSkipped++
        continue
      }
      process.stdout.write(`  ${label} uploading...`)
      const json = JSON.stringify(data, (_key, value) =>
        typeof value === 'bigint' ? Number(value) : value,
      )
      await put(blobPath, json, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      })
      const jsonKB = (json.length / 1024).toFixed(0)
      console.log(`\r  ${label} ✓ (${jsonKB} KB) → ${blobPath}`)
      totalUploaded++
      await sleep(300)
    }

    console.log()
  }

  // Summary
  console.log('══════════════════════════════════════════════════')
  console.log(`  Uploaded: ${totalUploaded}  Skipped: ${totalSkipped}`)
  console.log()

  // List all blobs under our prefixes
  console.log('  Blob storage contents:')
  for (const prefix of BLOB_PREFIXES) {
    const { blobs } = await list({ prefix })
    for (const blob of blobs) {
      const sizeKB = (blob.size / 1024).toFixed(0)
      console.log(`    ${blob.pathname} (${sizeKB} KB)`)
    }
  }
  console.log('══════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
