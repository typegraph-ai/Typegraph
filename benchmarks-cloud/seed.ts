#!/usr/bin/env npx tsx
/**
 * seed.ts — Cloud benchmark seeder
 *
 * Seeds a d8um cloud instance with a benchmark corpus via the hosted API.
 * Uses the SDK in cloud mode (apiKey) — no local DB, adapters, or graph packages.
 *
 * Usage:
 *   npx tsx --env-file=.env seed.ts <dataset-name>
 *
 * Examples:
 *   npx tsx --env-file=.env seed.ts australian-tax-guidance-retrieval
 *   npx tsx --env-file=.env seed.ts graphrag-bench-novel
 *   npx tsx --env-file=.env seed.ts graphrag-bench-medical
 *
 * Required env vars:
 *   D8UM_API_KEY          — SDK key for the cloud account
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (for loading corpus data)
 *
 * Optional:
 *   D8UM_BASE_URL         — Override cloud API base URL (default: https://api.d8um.dev)
 */

import { d8umCreate } from '@d8um-ai/core'
import type { RawDocument } from '@d8um-ai/core'
import { getCloudConfig, BATCH_SIZE, CLOUD_DATASETS } from './lib/config.js'
import { loadCorpus, loadBlobDirect } from './lib/datasets.js'
import type { BeirCorpusRow } from './lib/datasets.js'

// ── CLI ──

const datasetName = process.argv[2]
if (!datasetName) {
  console.error('Usage: npx tsx --env-file=.env seed.ts <dataset-name>')
  console.error(`Available: ${Object.keys(CLOUD_DATASETS).join(', ')}`)
  process.exit(1)
}

const config = getCloudConfig(datasetName)

// ── Env validation ──

const apiKey = process.env.D8UM_API_KEY
if (!apiKey) {
  console.error('Error: D8UM_API_KEY env var is required.')
  process.exit(1)
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Error: BLOB_READ_WRITE_TOKEN env var is required.')
  process.exit(1)
}

// ── Main ──

async function main() {
  const totalStart = performance.now()
  const baseUrl = process.env.D8UM_BASE_URL || 'https://api.d8um.dev'

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log(`║  Cloud Seed: ${config.displayName}`.padEnd(63) + '║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  // Phase 1: Connect to cloud
  console.log('Phase 1: Connecting to d8um cloud...')
  const d = await d8umCreate({
    apiKey,
    baseUrl,
    timeout: 120_000,
  })
  console.log(`  Connected (baseUrl: ${baseUrl})`)
  console.log()

  // Phase 2: Load corpus from Vercel Blob
  console.log('Phase 2: Loading corpus from Vercel Blob...')
  let corpus: BeirCorpusRow[]
  if (config.loader === 'graphrag-bench') {
    corpus = await loadBlobDirect<BeirCorpusRow[]>(`${config.blobPrefix}/corpus.json`, 'corpus')
  } else {
    corpus = await loadCorpus(config.dataset, config.blobPrefix)
  }
  console.log()

  // Phase 3: Resolve bucket
  console.log('Phase 3: Resolving bucket...')
  const existingBuckets = await d.buckets.list()
  let bucket = existingBuckets.find(b => b.name === config.bucketName)
  if (bucket) {
    console.log(`  Using existing bucket: ${bucket.name} (${bucket.id})`)
  } else {
    bucket = await d.buckets.create({ name: config.bucketName })
    console.log(`  Created bucket: ${bucket.name} (${bucket.id})`)
  }
  console.log()

  // Phase 4: Map corpus to RawDocument[]
  const docs: RawDocument[] = corpus.map(doc => {
    const title = doc.title ?? ''
    const text = doc.text ?? ''
    return {
      id: String(doc._id),
      title,
      content: title ? `${title}\n\n${text}` : text,
      updatedAt: new Date(),
      metadata: { corpusId: String(doc._id) },
    }
  })

  // Phase 5: Batch ingest
  console.log(`Phase 4: Ingesting ${docs.length} docs (batch_size=${BATCH_SIZE})...`)
  const ingestStart = performance.now()
  let ingested = 0
  let totalInserted = 0
  let totalSkipped = 0
  let errors = 0
  const totalBatches = Math.ceil(docs.length / BATCH_SIZE)

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const batch = docs.slice(i, i + BATCH_SIZE)
    const batchStart = performance.now()

    try {
      const result = await d.ingest(bucket!.id, batch, {} as any)
      totalInserted += result.inserted ?? 0
      totalSkipped += result.skipped ?? 0
      ingested += batch.length

      const batchMs = performance.now() - batchStart
      const elapsed = (performance.now() - ingestStart) / 1000
      const docsPerSec = ingested / elapsed
      const eta = (docs.length - ingested) / docsPerSec

      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${batch.length} docs, ` +
        `${result.inserted ?? 0} inserted, ${result.skipped ?? 0} skipped ` +
        `(${batchMs.toFixed(0)}ms) — ${ingested}/${docs.length} total, ` +
        `${docsPerSec.toFixed(1)} docs/s, ETA ${eta.toFixed(0)}s`
      )
    } catch (err) {
      errors++
      ingested += batch.length
      const batchMs = performance.now() - batchStart
      console.error(
        `  Batch ${batchNum}/${totalBatches}: ${batch.length} docs — ` +
        `FAILED (${batchMs.toFixed(0)}ms) — ${err}`
      )
    }
  }

  // Summary
  const ingestSec = (performance.now() - ingestStart) / 1000
  const wallSec = (performance.now() - totalStart) / 1000

  console.log()
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`  Seed complete: ${config.displayName}`)
  console.log(`  Bucket: ${bucket!.name} (${bucket!.id})`)
  console.log(`  Docs: ${ingested}/${docs.length}`)
  console.log(`  Inserted: ${totalInserted}, Skipped: ${totalSkipped}`)
  console.log(`  Ingest time: ${ingestSec.toFixed(1)}s (${(ingested / ingestSec).toFixed(1)} docs/s)`)
  console.log(`  Wall time: ${wallSec.toFixed(1)}s`)
  if (errors > 0) console.log(`  Errors: ${errors}`)
  console.log('══════════════════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
