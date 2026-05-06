import { describe, expect, it, vi } from 'vitest'
import type { ExternalId, SemanticFactRecord, SemanticGraphEdge } from '@typegraph-ai/sdk'
import { PgJobStore } from '../src/job-store.js'
import { PgMemoryStoreAdapter } from '../src/memory-store.js'
import { PgSourceStore } from '../src/source-store.js'

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
    weight: params[10],
    evidence_count: params[11],
    tenant_id: params[13],
    group_id: params[14],
    user_id: params[15],
    agent_id: params[16],
    conversation_id: params[17],
    visibility: params[18],
    created_at: '2026-04-16T00:00:00Z',
    updated_at: params[20],
  }
}

type SqlCall = { query: string; params: unknown[] }

function placeholderIndexes(query: string): number[] {
  return [...query.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
}

function expectBoundPlaceholders(calls: SqlCall[]): void {
  for (const { query, params } of calls) {
    const indexes = placeholderIndexes(query)
    if (indexes.length === 0) continue
    const unique = new Set(indexes)
    const max = Math.max(...indexes)
    expect(max).toBeLessThanOrEqual(params.length)
    for (let i = 1; i <= max; i++) {
      expect(unique.has(i)).toBe(true)
    }
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
    expect(ddl).not.toMatch(/\bscope\s+JSONB\b/)
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
    expect(capturedParams[13]).toBe('bucket-1')
    expect(capturedParams[14]).toBe('doc-1')
    expect(capturedParams[15]).toBe(2)
    expect(capturedParams[16]).toBe('mock-embed')
    expect(capturedParams[17]).toBe('chunk_pat')
    expect(capturedParams[18]).toBe('tenant-1')
    expect(capturedParams[23]).toBe('tenant')
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
    }

    await store.upsertEntityExternalIds('ent_alice', [externalId], { tenantId: 'tenant-1' })

    expect(capturedQuery).toContain('ON CONFLICT')
    expect(capturedQuery).toContain('WHERE typegraph_entity_external_ids.entity_id = EXCLUDED.entity_id')
    expect(capturedParams[1]).toBe('ent_alice')
    expect(capturedParams[2]).toBe('email')
    expect(capturedParams[3]).toBe('Alice@Example.com')
    expect(capturedParams[4]).toBe('alice@example.com')
    expect(capturedParams[5]).toBe('none')
    expect(capturedParams[7]).toBe('tenant-1')
  })

  it('looks up scoped external IDs without skipping SQL parameter positions', async () => {
    let capturedQuery = ''
    let capturedParams: unknown[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      capturedQuery = query
      capturedParams = params ?? []
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    const result = await store.findEntityByExternalId(
      { type: 'crm_account_id', id: '001ACME' },
      { groupId: 'customer_acme_corp' },
    )

    expect(result).toBeNull()
    expect(capturedQuery).toContain('xid.type = $1')
    expect(capturedQuery).toContain('xid.normalized_value = $2')
    expect(capturedQuery).toContain('xid.encoding = $3')
    expect(capturedQuery).toContain('e.group_id = $4')
    expect(capturedQuery).not.toContain('$5')
    expect(capturedParams).toEqual([
      'crm_account_id',
      '001ACME',
      'none',
      'customer_acme_corp',
    ])
  })

  it('binds contiguous placeholders across high-risk dynamic SQL paths', async () => {
    const calls: SqlCall[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      calls.push({ query, params: params ?? [] })
      return []
    })
    const identity = {
      tenantId: 'tenant-1',
      groupId: 'group-1',
      userId: 'user-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
    }
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    await store.findEntityByExternalId({ type: 'crm_account_id', id: '001ACME' }, identity)
    await store.searchEntitiesHybrid('Acme SSO Marcus Priya', [0.1, 0.2, 0.3, 0.4], identity, 7)
    await store.searchFactsHybrid('Acme SSO token refresh Marcus Priya', [0.1, 0.2, 0.3, 0.4], identity, 7)
    await store.getChunkEdgesForEntities(['ent_acme', 'ent_bug'], { scope: identity, bucketIds: ['bkt_acme'], limit: 25 })
    await store.getChunksByRefs(
      [{ bucketId: 'bkt_acme', sourceId: 'src_slack', chunkIndex: 2 }],
      { chunksTable: 'typegraph_chunks', scope: identity, bucketIds: ['bkt_acme'] },
    )
    await store.searchChunks(
      [0.1, 0.2, 0.3, 0.4],
      identity,
      {
        chunksTable: 'typegraph_chunks',
        bucketIds: ['bkt_acme'],
        limit: 20,
        chunkRefs: [{ bucketId: 'bkt_acme', sourceId: 'src_slack', chunkIndex: 2 }],
      },
    )
    await store.listChunkBackfillRecords({
      chunksTable: 'typegraph_chunks',
      scope: identity,
      bucketIds: ['bkt_acme'],
      limit: 10,
      offset: 5,
    })
    await store.listChunkMentionBackfillRows({
      chunksTable: 'typegraph_chunks',
      scope: identity,
      bucketIds: ['bkt_acme'],
      limit: 10,
      offset: 5,
    })
    await store.listSemanticEdgesForBackfill({ scope: identity, limit: 10, offset: 5 })
    await store.search([0.1, 0.2, 0.3, 0.4], {
      count: 5,
      temporalAt: new Date('2026-04-16T00:00:00Z'),
      filter: {
        scope: identity,
        category: 'episodic',
        visibility: 'group',
        activeAt: new Date('2026-04-16T00:00:00Z'),
      },
    })
    await store.hybridSearch([0.1, 0.2, 0.3, 0.4], 'Acme auth risk', {
      count: 5,
      temporalAt: new Date('2026-04-16T00:00:00Z'),
      filter: {
        tenantId: identity.tenantId,
        groupId: identity.groupId,
        userId: identity.userId,
        agentId: identity.agentId,
        conversationId: identity.conversationId,
        category: ['episodic', 'semantic'],
        visibility: ['group', 'user'],
        activeAt: new Date('2026-04-16T00:00:00Z'),
      },
    })

    const sourceStore = new PgSourceStore(sql, 'typegraph_sources')
    await sourceStore.list({
      bucketId: 'bkt_acme',
      tenantId: identity.tenantId,
      groupId: identity.groupId,
      userId: identity.userId,
      agentId: identity.agentId,
      conversationId: identity.conversationId,
      status: ['complete', 'processing'],
      visibility: ['group', 'user'],
      sourceIds: ['src_slack'],
      graphExtracted: false,
    }, { limit: 10, offset: 5 })
    await sourceStore.update('src_slack', {
      title: 'Slack export',
      url: 'https://demo.slack.local/thread',
      visibility: 'group',
      metadata: { source: 'slack' },
      subject: { externalIds: [{ type: 'slack_conversation_id', id: 'C123' }] },
    })

    const jobStore = new PgJobStore(sql, 'typegraph_jobs')
    await jobStore.list({
      bucketId: 'bkt_acme',
      status: 'processing',
      type: 'ingest',
    }, { limit: 10, offset: 5 })
    await jobStore.updateStatus('job_1', {
      status: 'complete',
      completedAt: new Date('2026-04-16T00:00:00Z'),
      result: { ok: true } as never,
      error: 'none',
      progressProcessed: 10,
      progressTotal: 10,
    })

    expectBoundPlaceholders(calls)
  })
})
