import { describe, expect, it, vi } from 'vitest'
import type { EmbeddedChunk } from '@typegraph-ai/sdk'
import { PgVectorAdapter } from '../src/adapter.js'

describe('PgVectorAdapter graph records', () => {
  it('maps public graph access when Postgres returns a jsonb scalar as a string', async () => {
    const sql = vi.fn(async (_query: string, params?: unknown[]) => [{
      id: params?.[0],
      tenant_id: params?.[1],
      name: params?.[2],
      description: params?.[3],
      extends: params?.[4],
      access: 'public',
      metadata: {},
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T00:00:00.000Z',
    }])
    const adapter = new PgVectorAdapter({ sql })

    const graph = await adapter.upsertGraphRecord({
      id: 'public',
      tenantId: 'public',
      name: 'Public',
      access: 'public',
      metadata: {},
    })

    expect(graph.access).toBe('public')
    expect(sql.mock.calls[0]?.[1]?.[5]).toBe('"public"')
  })

  it('scopes bucket writes and reads by tenant id', async () => {
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      if (query.startsWith('INSERT INTO typegraph_buckets')) {
        return [{
          id: params?.[0],
          name: params?.[1],
          description: params?.[2],
          status: params?.[3],
          tenant_id: params?.[4],
          graph_id: params?.[5],
          group_id: params?.[6],
          user_id: params?.[7],
          agent_id: params?.[8],
          thread_id: params?.[9],
          index_defaults: params?.[14],
          created_at: '2026-05-11T00:00:00.000Z',
          updated_at: '2026-05-11T00:00:00.000Z',
        }]
      }
      return [{
        id: 'public',
        name: 'Public',
        status: 'active',
        tenant_id: params?.[0],
        graph_id: 'public',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T00:00:00.000Z',
      }]
    })
    const adapter = new PgVectorAdapter({ sql })

    await adapter.upsertBucket({
      id: 'public',
      name: 'Public',
      status: 'active',
      tenantId: 'tenant_a',
      graph: 'public',
    })
    await adapter.getBucket('public', 'tenant_a')
    await adapter.getBuckets(['public'], 'tenant_a')

    expect(sql.mock.calls[0]?.[0]).toContain('ON CONFLICT (tenant_id, id)')
    expect(sql.mock.calls[1]?.[0]).toContain('WHERE tenant_id = $1 AND id = $2')
    expect(sql.mock.calls[1]?.[1]).toEqual(['tenant_a', 'public'])
    expect(sql.mock.calls[2]?.[0]).toContain('WHERE tenant_id = $1 AND id = ANY($2::text[])')
    expect(sql.mock.calls[2]?.[1]).toEqual(['tenant_a', ['public']])
  })

  it('bulk-upserts chunks without record-level access scope columns', async () => {
    let capturedQuery = ''
    let capturedParams: unknown[] | undefined
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      if (query.includes('SELECT table_name FROM')) {
        return [{ table_name: 'typegraph_document_chunks_mock' }]
      }
      if (query.startsWith('INSERT INTO typegraph_document_chunks_mock')) {
        capturedQuery = query
        capturedParams = params
      }
      return []
    })
    const adapter = new PgVectorAdapter({ sql })
    const chunk: EmbeddedChunk = {
      id: 'chunk_1',
      idempotencyKey: 'doc_1',
      bucketId: 'bucket_1',
      tenantId: 'tenant_1',
      graphId: 'public',
      documentId: 'document_1',
      content: 'hello world',
      embedding: [0.1, 0.2],
      embeddingModel: 'mock',
      chunkIndex: 0,
      totalChunks: 1,
      metadata: {},
      indexedAt: new Date('2026-05-12T00:00:00.000Z'),
    }

    await adapter.upsertDocumentChunks('mock', [chunk])

    expect(capturedQuery).toContain('$13::halfvec[]')
    expect(capturedQuery).toContain('$17::jsonb[]')
    expect(capturedQuery).toContain('ON CONFLICT (tenant_id, bucket_id, idempotency_key, chunk_index)')
    expect(capturedParams?.[16]).toEqual(['{}'])
  })
})
