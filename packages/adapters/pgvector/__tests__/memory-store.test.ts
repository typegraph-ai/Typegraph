import { describe, expect, it, vi } from 'vitest'
import type { ExternalId, SemanticFactRecord } from '@typegraph-ai/sdk'
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
