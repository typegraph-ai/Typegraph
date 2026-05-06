import { describe, expect, it, vi } from 'vitest'
import type { ExternalId, SemanticFactRecord, SemanticGraphEdge } from '@typegraph-ai/sdk'
import { PgMemoryStoreAdapter } from '../src/memory-store.js'

function makeFact(): SemanticFactRecord {
  return {
    id: 'fact-stable',
    edgeId: 'edge-new',
    sourceEntityId: 'entity-a',
    targetEntityId: 'entity-b',
    relation: 'KNOWS',
    factText: 'Entity A knows Entity B',
    weight: 0.8,
    evidenceCount: 1,
    embedding: [1, 0, 0, 0],
    scope: { tenantId: 'tenant-1' },
    createdAt: new Date('2026-04-16T00:00:00Z'),
    updatedAt: new Date('2026-04-16T00:00:00Z'),
  }
}

function rowFromParams(params: unknown[] = []): Record<string, unknown> {
  return {
    id: params[0],
    edge_id: params[1],
    source_entity_id: params[2],
    target_entity_id: params[3],
    relation: params[4],
    fact_text: params[5],
    weight: params[6],
    evidence_count: params[7],
    tenant_id: params[10],
    group_id: params[11],
    user_id: params[12],
    agent_id: params[13],
    conversation_id: params[14],
    visibility: params[15],
    created_at: '2026-04-16T00:00:00Z',
    updated_at: params[16],
  }
}

describe('PgMemoryStoreAdapter', () => {
  it('initializes the canonical graph-edge pattern without creating legacy passage tables', async () => {
    const queries: string[] = []
    const sql = vi.fn(async (query: string) => {
      queries.push(query)
      if (query.includes('FROM pg_constraint')) return []
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    await store.initialize()

    const ddl = queries.join('\n')
    expect(ddl).toContain('typegraph_graph_edges')
    expect(ddl).toContain('source_type')
    expect(ddl).toContain('target_type')
    expect(ddl).toContain("CHECK (source_type IN ('entity', 'chunk', 'memory'))")
    expect(ddl).toContain('typegraph_entity_chunk_mentions')
    expect(ddl).not.toContain('typegraph_passage_nodes')
    expect(ddl).not.toContain('typegraph_passage_entity_edges')
  })

  it('upserts entity-to-chunk associations as typed graph edges with chunk refs', async () => {
    let capturedQuery = ''
    let capturedParams: unknown[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      capturedQuery = query
      capturedParams = params ?? []
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })
    const edge: SemanticGraphEdge = {
      id: 'edge_chunk_1',
      sourceType: 'entity',
      sourceId: 'ent_pat',
      targetType: 'chunk',
      targetId: 'chunk_pat',
      relation: 'MENTIONED_IN',
      weight: 1.5,
      properties: { mentionCount: 1 },
      scope: { tenantId: 'tenant-1' },
      targetChunkRef: {
        bucketId: 'bucket-1',
        sourceId: 'doc-1',
        chunkIndex: 2,
        embeddingModel: 'mock-embed',
        chunkId: 'chunk_pat',
      },
      visibility: 'tenant',
      evidence: ['chunk_pat'],
      temporal: {
        validAt: new Date('2026-04-16T00:00:00Z'),
        createdAt: new Date('2026-04-16T00:00:00Z'),
      },
    }

    await store.upsertGraphEdges([edge])

    expect(capturedQuery).toContain('INSERT INTO typegraph_graph_edges')
    expect(capturedQuery).toContain('ON CONFLICT (source_type, source_id, target_type, target_id, relation)')
    expect(capturedParams[1]).toBe('entity')
    expect(capturedParams[2]).toBe('ent_pat')
    expect(capturedParams[3]).toBe('chunk')
    expect(capturedParams[4]).toBe('chunk_pat')
    expect(capturedParams[14]).toBe('bucket-1')
    expect(capturedParams[15]).toBe('doc-1')
    expect(capturedParams[16]).toBe(2)
    expect(capturedParams[17]).toBe('mock-embed')
    expect(capturedParams[18]).toBe('chunk_pat')
    expect(capturedParams[19]).toBe('tenant-1')
    expect(capturedParams[24]).toBe('tenant')
  })

  it('retries fact record upsert on duplicate deterministic fact id', async () => {
    const queries: string[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      queries.push(query)
      if (query.includes('ON CONFLICT (edge_id)')) {
        const err = new Error('duplicate key value violates unique constraint "typegraph_fact_records_pkey"')
        Object.assign(err, { code: '23505', constraint: 'typegraph_fact_records_pkey' })
        throw err
      }
      return [rowFromParams(params)]
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    const result = await store.upsertFactRecord(makeFact())

    expect(sql).toHaveBeenCalledTimes(2)
    expect(queries[0]).toContain('ON CONFLICT (edge_id)')
    expect(queries[1]).toContain('ON CONFLICT (id)')
    expect(queries[1]).toContain('edge_id = EXCLUDED.edge_id')
    expect(result.id).toBe('fact-stable')
    expect(result.edgeId).toBe('edge-new')
  })

  it('stores scoped deterministic entity external IDs with normalized lookup values', async () => {
    let capturedQuery = ''
    let capturedParams: unknown[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      capturedQuery = query
      capturedParams = params ?? []
      return [{ id: 'xid_1' }]
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })
    const externalId: ExternalId = {
      id: 'Alice@Example.com',
      type: 'EMAIL',
      identityType: 'user',
    }

    await store.upsertEntityExternalIds('ent_alice', [externalId], { tenantId: 'tenant-1' })

    expect(capturedQuery).toContain('ON CONFLICT')
    expect(capturedQuery).toContain('WHERE typegraph_entity_external_ids.entity_id = EXCLUDED.entity_id')
    expect(capturedParams[1]).toBe('ent_alice')
    expect(capturedParams[2]).toBe('user')
    expect(capturedParams[3]).toBe('email')
    expect(capturedParams[4]).toBe('Alice@Example.com')
    expect(capturedParams[5]).toBe('alice@example.com')
    expect(capturedParams[6]).toBe('none')
    expect(capturedParams[9]).toBe('tenant-1')
  })
})
