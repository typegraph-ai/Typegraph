#!/usr/bin/env npx tsx
/**
 * seed-graphrag-bench.ts
 *
 * Downloads GraphRAG-Bench corpus + questions from HuggingFace and uploads
 * to Vercel Blob Storage in BEIR-like format for benchmark runners.
 *
 * GraphRAG-Bench (arXiv:2506.05690):
 *   - Novel domain: 20 Project Gutenberg novels → ~1,005 chunks at 1200 tokens
 *   - Medical domain: 1 NCCN guidelines document → ~220 chunks at 1200 tokens
 *   - 4,072 questions across 4 types: Fact Retrieval, Complex Reasoning,
 *     Contextual Summarization, Creative Generation
 *
 * The corpus is chunked at upload time (1200 tokens, 128 overlap) to match
 * the benchmark's standard configuration. Each chunk becomes a corpus entry.
 *
 * Blob storage layout:
 *   datasets/graphrag-bench/novel/corpus.json    — [{_id, title, text}, ...]
 *   datasets/graphrag-bench/novel/queries.json   — [{_id, text}, ...]
 *   datasets/graphrag-bench/novel/qrels.json     — [{query-id, corpus-id, score}, ...]
 *   datasets/graphrag-bench/novel/answers.json   — [{_id, answer}, ...]
 *   datasets/graphrag-bench/medical/corpus.json
 *   datasets/graphrag-bench/medical/queries.json
 *   datasets/graphrag-bench/medical/qrels.json
 *   datasets/graphrag-bench/medical/answers.json
 *
 * Required env vars:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob read/write token
 *   HF_TOKEN               — HuggingFace API token (optional, for rate limits)
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/seed-graphrag-bench.ts
 */

import { put, list } from '@vercel/blob'
import { parquetRead } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

// ── Constants ──

const HF_CORPUS_BASE = 'https://huggingface.co/datasets/GraphRAG-Bench/GraphRAG-Bench/resolve/main/Datasets/Corpus'
const HF_PARQUET_API = 'https://datasets-server.huggingface.co/parquet'
const HF_DATASET = 'GraphRAG-Bench/GraphRAG-Bench'
const BLOB_PREFIX = 'datasets/graphrag-bench'

// Chunking config: match benchmark standard (1200 tokens, 128 overlap)
const CHUNK_SIZE_CHARS = 1200 * 4  // ~4800 chars (approx 1200 tokens at 4 chars/token)
const CHUNK_OVERLAP_CHARS = 128 * 4 // ~512 chars

const DOMAINS = ['novel', 'medical'] as const

// ── Helpers ──

function hfHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function blobExists(pathname: string): Promise<boolean> {
  const { blobs } = await list({ prefix: pathname, limit: 1 })
  return blobs.some(b => b.pathname === pathname)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Chunk a long document into overlapping segments.
 * Uses character-based splitting with sentence boundary alignment.
 */
function chunkText(text: string, chunkSize = CHUNK_SIZE_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length)

    // Try to break at sentence boundary (look back up to 200 chars from end)
    if (end < text.length) {
      const lookback = text.slice(Math.max(start, end - 200), end)
      const lastSentenceEnd = Math.max(
        lookback.lastIndexOf('. '),
        lookback.lastIndexOf('.\n'),
        lookback.lastIndexOf('? '),
        lookback.lastIndexOf('! '),
      )
      if (lastSentenceEnd > 0) {
        end = end - 200 + lastSentenceEnd + 2 // +2 to include the period + space
        if (end <= start) end = Math.min(start + chunkSize, text.length)
      }
    }

    const chunk = text.slice(start, end).trim()
    if (chunk.length > 0) {
      chunks.push(chunk)
    }

    start = end - overlap
    if (start >= text.length) break
    // Prevent infinite loop on very short remaining text
    if (end === text.length) break
  }

  return chunks
}

/**
 * Normalize text for evidence matching: collapse whitespace, lowercase
 */
function normalize(s: string): string {
  return s.replace(/[\s\n]+/g, ' ').trim().toLowerCase()
}

// ── Main ──

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Error: BLOB_READ_WRITE_TOKEN env var is required.')
    process.exit(1)
  }

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  GraphRAG-Bench Dataset Seeder → Vercel Blob     ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log()
  console.log(`  HF token: ${process.env.HF_TOKEN ? '✓ authenticated' : 'anonymous'}`)
  console.log(`  Chunk config: ${CHUNK_SIZE_CHARS} chars (~1200 tokens), ${CHUNK_OVERLAP_CHARS} char overlap`)
  console.log()

  // ── Get question data via parquet API ──

  process.stdout.write('  Fetching parquet index...')
  const parquetRes = await fetch(`${HF_PARQUET_API}?dataset=${encodeURIComponent(HF_DATASET)}`, { headers: hfHeaders() })
  const parquetData = (await parquetRes.json()) as { parquet_files: { config: string; split: string; url: string; size: number }[] }
  console.log(' done')

  for (const domain of DOMAINS) {
    console.log()
    console.log(`── ${domain} ${'─'.repeat(40 - domain.length)}`)

    const corpusPath = `${BLOB_PREFIX}/${domain}/corpus.json`
    const queriesPath = `${BLOB_PREFIX}/${domain}/queries.json`
    const qrelsPath = `${BLOB_PREFIX}/${domain}/qrels.json`
    const answersPath = `${BLOB_PREFIX}/${domain}/answers.json`

    // Check if already uploaded
    if (await blobExists(corpusPath) && await blobExists(queriesPath) && await blobExists(qrelsPath)) {
      console.log('  All files exist in blob storage, skipping')
      continue
    }

    // ── Download corpus ──

    process.stdout.write(`  Downloading ${domain} corpus...`)
    const corpusUrl = `${HF_CORPUS_BASE}/${domain}.json`
    const corpusRes = await fetch(corpusUrl, { headers: hfHeaders() })
    if (!corpusRes.ok) throw new Error(`Failed to download corpus: ${corpusRes.status}`)
    const rawCorpus = (await corpusRes.json()) as { corpus_name: string; context: string }[]
    console.log(` ${rawCorpus.length} documents`)

    // ── Chunk corpus into BEIR format ──

    process.stdout.write('  Chunking corpus...')
    const beirCorpus: { _id: string; title: string; text: string; metadata: { source: string; chunkIndex: number } }[] = []
    let chunkId = 0

    for (const doc of rawCorpus) {
      const chunks = chunkText(doc.context)
      for (let i = 0; i < chunks.length; i++) {
        beirCorpus.push({
          _id: String(chunkId),
          title: `${doc.corpus_name} [${i + 1}/${chunks.length}]`,
          text: chunks[i]!,
          metadata: { source: doc.corpus_name, chunkIndex: i },
        })
        chunkId++
      }
    }
    console.log(` ${beirCorpus.length} chunks from ${rawCorpus.length} docs`)

    // Pre-normalize corpus for evidence matching
    const normalizedChunks = beirCorpus.map(c => ({
      id: c._id,
      normalized: normalize(c.text),
    }))

    // ── Download questions ──

    process.stdout.write('  Downloading questions...')
    const questionFiles = parquetData.parquet_files.filter(f => f.config === domain && f.split === 'train')
    if (questionFiles.length === 0) throw new Error(`No parquet files for ${domain}/train`)

    const allQuestions: Record<string, unknown>[] = []
    for (const file of questionFiles) {
      const buf = await (await fetch(file.url, { headers: hfHeaders() })).arrayBuffer()
      await parquetRead({
        file: buf,
        rowFormat: 'object',
        compressors,
        onComplete: (data: Record<string, unknown>[]) => { allQuestions.push(...data) },
      })
    }
    console.log(` ${allQuestions.length} questions`)

    // ── Build queries, qrels, answers ──

    process.stdout.write('  Building qrels via evidence matching...')
    const beirQueries: { _id: string; text: string }[] = []
    const beirQrels: { 'query-id': string; 'corpus-id': string; score: number }[] = []
    const beirAnswers: { _id: string; answer: string }[] = []
    let unmatchedEvidence = 0

    for (let qi = 0; qi < allQuestions.length; qi++) {
      const q = allQuestions[qi]!
      const queryId = String(qi)
      beirQueries.push({ _id: queryId, text: String(q['question'] ?? '') })

      const answer = String(q['answer'] ?? '')
      if (answer) {
        beirAnswers.push({ _id: queryId, answer })
      }

      // Match evidence snippets to corpus chunks
      const evidenceList = (q['evidence'] ?? []) as string[]
      const matchedChunkIds = new Set<string>()

      for (const ev of evidenceList) {
        const normEv = normalize(ev)
        if (!normEv || normEv.length < 10) continue

        for (const chunk of normalizedChunks) {
          if (chunk.normalized.includes(normEv)) {
            matchedChunkIds.add(chunk.id)
          }
        }
      }

      if (matchedChunkIds.size === 0 && evidenceList.length > 0) {
        unmatchedEvidence++
      }

      for (const chunkId of matchedChunkIds) {
        beirQrels.push({ 'query-id': queryId, 'corpus-id': chunkId, score: 1 })
      }
    }
    console.log(' done')

    console.log(`  Stats: ${beirQueries.length} queries, ${beirQrels.length} qrels, ${beirAnswers.length} answers`)
    const queriesWithQrels = new Set(beirQrels.map(q => q['query-id'])).size
    console.log(`  Queries with matches: ${queriesWithQrels}/${beirQueries.length} (${(queriesWithQrels/beirQueries.length*100).toFixed(1)}%)`)
    if (unmatchedEvidence > 0) {
      console.log(`  Warning: ${unmatchedEvidence} questions had evidence but no chunk matches`)
    }

    // ── Upload to Blob ──

    const uploads: [string, unknown[]][] = [
      [corpusPath, beirCorpus],
      [queriesPath, beirQueries],
      [qrelsPath, beirQrels],
      [answersPath, beirAnswers],
    ]

    for (const [blobPath, data] of uploads) {
      const label = blobPath.split('/').pop()!.replace('.json', '').padEnd(8)
      if (await blobExists(blobPath)) {
        console.log(`  ${label} skipped (already exists)`)
        continue
      }
      process.stdout.write(`  ${label} uploading...`)
      const json = JSON.stringify(data)
      await put(blobPath, json, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      })
      console.log(`\r  ${label} ✓ ${(data as unknown[]).length.toLocaleString()} items (${(json.length / 1024).toFixed(0)} KB)`)
      await sleep(300)
    }
  }

  // ── Summary ──

  console.log()
  console.log('══════════════════════════════════════════════════')
  console.log('  Blob contents:')
  const { blobs } = await list({ prefix: BLOB_PREFIX })
  for (const blob of blobs) {
    console.log(`    ${blob.pathname} (${(blob.size / 1024).toFixed(0)} KB)`)
  }
  console.log('══════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
