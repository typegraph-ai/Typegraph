/**
 * adapter.ts — Create a Neon pgvector adapter for benchmarks
 *
 * Uses @neondatabase/serverless which provides an HTTP-based Postgres driver.
 * The neon() function returns a SqlExecutor-compatible function directly.
 */

import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@d8um-ai/adapter-pgvector'

export function createBenchmarkAdapter(tablePrefix?: string) {
  const databaseUrl = process.env.NEON_DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: NEON_DATABASE_URL env var is required.')
    console.error('Get one from: Neon Dashboard → Connection string')
    process.exit(1)
  }

  const sql = neon(databaseUrl)
  return new PgVectorAdapter({
    sql: (q, p) => sql(q, p as any) as any,
    schema: 'bench',
    tablePrefix,
  })
}
