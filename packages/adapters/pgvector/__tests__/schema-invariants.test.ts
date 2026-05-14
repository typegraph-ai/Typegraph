import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BUCKETS_TABLE_SQL,
  BUSINESS_EVENTS_TABLE_SQL,
  DOCUMENTS_TABLE_SQL,
  HASH_TABLE_SQL,
  JOBS_TABLE_SQL,
  LINKS_TABLE_SQL,
  MODEL_TABLE_SQL,
  POLICIES_TABLE_SQL,
  THREADS_TABLE_SQL,
} from '../src/migrations.js'
import { PgMemoryStoreAdapter } from '../src/memory-store.js'

const staleTerms = [
  ['vis', 'ibility'].join(''),
  ['access', '_scope'].join(''),
  ['access', '_scope', '_ids'].join(''),
  ['conver', 'sation'].join(''),
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  })
}

describe('pgvector schema invariants', () => {
  it('renders fresh DDL without removed record-level access columns and with halfvec embeddings', async () => {
    const memoryQueries: string[] = []
    const sql = vi.fn(async (query: string) => {
      memoryQueries.push(query)
      return []
    })
    const memory = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })
    await memory.initialize()

    const ddl = [
      MODEL_TABLE_SQL('typegraph_document_chunks_mock', 4),
      HASH_TABLE_SQL('typegraph_hashes'),
      DOCUMENTS_TABLE_SQL('typegraph_documents'),
      BUCKETS_TABLE_SQL('typegraph_buckets'),
      BUSINESS_EVENTS_TABLE_SQL('typegraph_events'),
      THREADS_TABLE_SQL('typegraph_threads'),
      LINKS_TABLE_SQL('typegraph_links'),
      POLICIES_TABLE_SQL('typegraph_policies'),
      JOBS_TABLE_SQL('typegraph_jobs'),
      ...memoryQueries,
    ].join('\n')

    for (const term of staleTerms) {
      expect(ddl).not.toContain(term)
    }
    expect(ddl).toContain('PRIMARY KEY (tenant_id, id)')
    expect(ddl).toContain('PRIMARY KEY (tenant_id, graph_id, id)')
    expect(ddl).toContain('(tenant_id, bucket_id, idempotency_key, chunk_index)')
    expect(ddl).toContain('url              TEXT')
    expect(ddl).toContain('ALTER TABLE typegraph_events\n    ADD COLUMN IF NOT EXISTS url TEXT')
    expect(ddl).toContain('ALTER TABLE typegraph_threads\n    ADD COLUMN IF NOT EXISTS url TEXT')
    expect(ddl).not.toContain("metadata->>'url'")
    expect(ddl).not.toContain("metadata ->> 'url'")
    expect(ddl).toContain('embedding       HALFVEC(4)')
    expect(ddl).toContain('embedding        HALFVEC(4)')
    expect(ddl).toContain('description_embedding HALFVEC(4)')
    expect(ddl).toContain('halfvec_cosine_ops')
    expect(ddl).not.toMatch(/\bVECTOR\s*\(/)
    expect(ddl).not.toContain('vector_cosine_ops')
  })

  it('keeps stale storage terms and vector casts out of pgadapter source files', () => {
    const srcDir = join(process.cwd(), 'src')
    const combined = sourceFiles(srcDir)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    for (const term of staleTerms) {
      expect(combined).not.toContain(term)
    }
    expect(combined).not.toMatch(/\bVECTOR\s*\(/)
    expect(combined).not.toContain('::vector')
    expect(combined).not.toContain('vector_cosine_ops')
  })
})
