/**
 * validate.ts — Benchmark smoke test / validation
 *
 * Runs a minimal subset (5 docs, 5 queries) to verify the full pipeline
 * works before committing to expensive seed/query operations.
 *
 * MANDATORY before:
 *   - Any --seed on a new or cleared dataset
 *   - After refactoring a runner
 *   - When onboarding a new benchmark
 *   - After SDK changes touching ingestion or query paths
 */

import type { BenchmarkConfig } from './config.js'
import type { CoreInit } from './runner.js'
import { CHUNK_SIZE, CHUNK_OVERLAP, K, QUERY_FETCH, resolveChunkSize, resolveChunkOverlap } from './config.js'
import { deduplicateToDocuments } from './metrics.js'

const VALIDATE_COUNT = 5

/**
 * Run a smoke test: load small subset, ingest, query, verify results.
 * Returns true if validation passed, false otherwise.
 */
export async function runValidation(
  d: CoreInit['d'],
  bucketName: string,
  corpus: Record<string, unknown>[],
  testQueries: Record<string, unknown>[],
  config: BenchmarkConfig,
  opts?: { concurrency?: number },
): Promise<boolean> {
  const validationBucketName = `__validate_${bucketName}_${Date.now()}`
  const chunkSize = resolveChunkSize(config)
  const chunkOverlap = resolveChunkOverlap(config)

  console.log('══════════════════════════════════════════════════════')
  console.log('  VALIDATION MODE — smoke test with small subset')
  console.log('══════════════════════════════════════════════════════')
  console.log()
  console.log(`  Dataset: ${config.displayName}`)
  console.log(`  Total corpus: ${corpus.length} docs, ${testQueries.length} queries`)
  console.log(`  Validating with: ${VALIDATE_COUNT} docs, ${Math.min(VALIDATE_COUNT, testQueries.length)} queries`)
  console.log()

  try {
    // Step 1: Create temporary validation bucket
    console.log('  [1/4] Creating temporary validation bucket...')
    const bucket = await d.buckets.create({ name: validationBucketName })
    console.log(`    Created: ${bucket.name} (${bucket.id})`)

    // Step 2: Ingest 5 docs
    console.log(`  [2/4] Ingesting ${VALIDATE_COUNT} docs...`)
    const subCorpus = corpus.slice(0, VALIDATE_COUNT)
    const docs = subCorpus.map(doc => {
      const docId = String(doc['_id'] ?? doc['id'] ?? '')
      const title = String(doc['title'] ?? '')
      const text = String(doc['text'] ?? doc['content'] ?? '')
      return {
        id: docId,
        title,
        content: title ? `${title}\n\n${text}` : text,
        updatedAt: new Date(),
        metadata: { corpusId: docId },
      }
    })

    const ingestOpts: any = {
      chunkSize, chunkOverlap,
      deduplicateBy: ['content'],
      propagateMetadata: ['metadata.corpusId'],
    }
    const indexOpts = opts?.concurrency ? { concurrency: opts.concurrency } : undefined
    const result = await d.ingest(bucket.id, docs, ingestOpts, indexOpts)
    console.log(`    Ingested: ${result.inserted} chunks, ${result.skipped} skipped`)

    if (result.inserted === 0) {
      console.log('    WARNING: 0 chunks inserted — check embedding/chunking config')
    }

    // Step 3: Run 5 queries
    const queryCount = Math.min(VALIDATE_COUNT, testQueries.length)
    console.log(`  [3/4] Running ${queryCount} queries...`)
    const signals = config.signals[0] ?? { vector: true }
    let totalResults = 0
    let totalMs = 0

    for (let i = 0; i < queryCount; i++) {
      const query = testQueries[i]!
      const queryText = String(query['text'])
      const start = performance.now()

      const response = await d.query(queryText, {
        signals,
        count: QUERY_FETCH,
        buckets: [bucket.id],
      })

      const ms = performance.now() - start
      totalMs += ms
      const dedupResults = deduplicateToDocuments(response.results, K)
      totalResults += dedupResults.length
    }

    const avgMs = totalMs / queryCount
    console.log(`    ${queryCount} queries returned ${totalResults} total results (avg ${avgMs.toFixed(0)}ms)`)

    // Step 4: Cleanup
    console.log('  [4/4] Cleaning up validation data...')
    try {
      await d.buckets.delete(bucket.id)
      console.log('    Validation bucket deleted')
    } catch {
      console.log(`    Warning: Could not delete validation bucket ${validationBucketName}`)
      console.log('    You may need to clean it up manually')
    }

    // Summary
    console.log()
    console.log('  ══════════════════════════════════════════════════')
    if (result.inserted > 0 && totalResults > 0) {
      console.log('  ✓ VALIDATION PASSED')
      console.log(`    Ingestion: ${result.inserted} chunks from ${VALIDATE_COUNT} docs`)
      console.log(`    Queries: ${totalResults} results from ${queryCount} queries (${avgMs.toFixed(0)}ms avg)`)
      console.log()
      console.log('  Safe to proceed with --seed or full benchmark run.')
    } else if (result.inserted > 0 && totalResults === 0) {
      console.log('  ⚠ VALIDATION PARTIAL — ingestion OK but queries returned 0 results')
      console.log('    This may be expected if validation docs don\'t match validation queries.')
      console.log('    Proceed with caution.')
    } else {
      console.log('  ✗ VALIDATION FAILED')
      console.log('    No chunks were inserted. Check your config and database access.')
      return false
    }
    console.log('  ══════════════════════════════════════════════════')
    console.log()

    return true
  } catch (err) {
    console.error()
    console.error('  ✗ VALIDATION FAILED with error:')
    console.error('   ', err instanceof Error ? err.message : String(err))
    console.error()
    return false
  }
}
