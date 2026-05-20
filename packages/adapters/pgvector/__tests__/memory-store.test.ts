import { describe, expect, it, vi } from 'vitest'
import type { ExternalId, SemanticFactRecord, SemanticGraphEdge } from '@typegraph-ai/sdk'
import { PgDocumentStore } from '../src/document-store.js'
import { PgJobStore } from '../src/job-store.js'
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
    validAt: new Date('2026-04-16T00:00:00Z'),
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
    organization_id: params[14],
    group_id: params[15],
    user_id: params[16],
    agent_id: params[17],
    thread_id: params[18],
    graph_id: params[19],
    valid_at: params[20],
    invalid_at: params[21],
    expired_at: params[22],
    supersession_key: params[23],
    superseded_by_id: params[24],
    superseded_at: params[25],
    created_at: params[26],
    updated_at: params[27],
  }
}

type SqlCall = { query: string; params: unknown[] }

function factRowKey(row: Record<string, unknown>): string {
  return [row.tenant_id, row.graph_id, row.id].join('|')
}

function sameFactTimeline(row: Record<string, unknown>, tenantId: unknown, graphId: unknown, supersessionKey: unknown): boolean {
  return row.tenant_id === tenantId && row.graph_id === graphId && row.supersession_key === supersessionKey
}

function createFactTimelineSql() {
  const rows = new Map<string, Record<string, unknown>>()
  const updates: SqlCall[] = []
  const calls: SqlCall[] = []

  const upsertRow = (row: Record<string, unknown>) => {
    const key = factRowKey(row)
    const existing = rows.get(key)
    const merged = existing
      ? {
          ...existing,
          ...row,
          weight: Math.max(Number(existing.weight ?? 0), Number(row.weight ?? 0)),
          evidence_count: Math.max(Number(existing.evidence_count ?? 0), Number(row.evidence_count ?? 0)),
          created_at: existing.created_at,
        }
      : row
    rows.set(key, merged)
    return merged
  }

  const updateRow = (tenantId: unknown, graphId: unknown, id: unknown, patch: Record<string, unknown>) => {
    const key = [tenantId, graphId, id].join('|')
    const row = rows.get(key)
    if (!row) return
    rows.set(key, { ...row, ...patch, updated_at: '2026-04-16T00:00:00.000Z' })
  }

  const sql = vi.fn(async (query: string, params?: unknown[]) => {
    const bound = params ?? []
    calls.push({ query, params: bound })
    if (query.includes('INSERT INTO typegraph_fact_records')) {
      return [upsertRow(rowFromParams(bound))]
    }
    if (query.includes('AND valid_at >')) {
      const [tenantId, graphId, supersessionKey, id, validAt] = bound
      return [...rows.values()]
        .filter(row => sameFactTimeline(row, tenantId, graphId, supersessionKey) && row.id !== id && new Date(row.valid_at as string) > new Date(validAt as string))
        .sort((a, b) => new Date(a.valid_at as string).getTime() - new Date(b.valid_at as string).getTime())
        .slice(0, 1)
        .map(row => ({ id: row.id, valid_at: row.valid_at }))
    }
    if (query.includes('AND valid_at <')) {
      const [tenantId, graphId, supersessionKey, id, validAt] = bound
      return [...rows.values()]
        .filter(row => sameFactTimeline(row, tenantId, graphId, supersessionKey) && row.id !== id && new Date(row.valid_at as string) < new Date(validAt as string))
        .sort((a, b) => new Date(b.valid_at as string).getTime() - new Date(a.valid_at as string).getTime())
        .slice(0, 1)
        .map(row => ({ id: row.id, invalid_at: row.invalid_at }))
    }
    if (query.includes('UPDATE typegraph_fact_records')) {
      updates.push({ query, params: bound })
      if (query.includes('SET invalid_at = CASE')) {
        const [tenantId, graphId, , id, invalidAt, supersededById] = bound
        const row = rows.get([tenantId, graphId, id].join('|'))
        const currentInvalidAt = row?.invalid_at ? new Date(row.invalid_at as string) : null
        if (!currentInvalidAt || currentInvalidAt > new Date(invalidAt as string)) {
          updateRow(tenantId, graphId, id, {
            invalid_at: invalidAt,
            expired_at: row?.expired_at ?? '2026-04-16T00:00:00.000Z',
            superseded_by_id: row?.superseded_by_id ?? supersededById,
            superseded_at: row?.superseded_at ?? '2026-04-16T00:00:00.000Z',
          })
        }
      } else if (query.includes('SET invalid_at = $5')) {
        const [tenantId, graphId, , supersededById, invalidAt, id] = bound
        const row = rows.get([tenantId, graphId, id].join('|'))
        const currentInvalidAt = row?.invalid_at ? new Date(row.invalid_at as string) : null
        if (!currentInvalidAt || currentInvalidAt > new Date(invalidAt as string)) {
          updateRow(tenantId, graphId, id, {
            invalid_at: invalidAt,
            expired_at: row?.expired_at ?? '2026-04-16T00:00:00.000Z',
            superseded_by_id: supersededById,
            superseded_at: '2026-04-16T00:00:00.000Z',
          })
        }
      }
      return []
    }
    if (query.includes('WHERE tenant_id = $1 AND graph_id = $2 AND id = $3')) {
      const [tenantId, graphId, id] = bound
      const row = rows.get([tenantId, graphId, id].join('|'))
      return row ? [row] : []
    }
    return []
  })

  return {
    sql,
    calls,
    updates,
    rows: () => [...rows.values()].sort((a, b) => new Date(a.valid_at as string).getTime() - new Date(b.valid_at as string).getTime()),
  }
}

function makeStageFact(stage: string, validAt: string, overrides: Partial<SemanticFactRecord> = {}): SemanticFactRecord {
  return {
    ...makeFact(),
    id: `fact-stage-${stage.toLowerCase()}`,
    edgeId: `edge-stage-${stage.toLowerCase()}`,
    targetEntityId: `stage-${stage.toLowerCase()}`,
    relation: 'DEAL_STAGE',
    description: `Deal stage ${stage}`,
    evidenceText: `Deal stage ${stage}`,
    validAt: new Date(validAt),
    createdAt: new Date('2026-04-16T00:00:00Z'),
    updatedAt: new Date('2026-04-16T00:00:00Z'),
    supersessionKey: 'hubspot:12345:deal:222:deal_stage',
    ...overrides,
  }
}

function timeline(rows: Record<string, unknown>[]) {
  return rows.map(row => ({
    id: row.id,
    validAt: new Date(row.valid_at as string).toISOString(),
    invalidAt: row.invalid_at ? new Date(row.invalid_at as string).toISOString() : null,
    supersededById: row.superseded_by_id ?? null,
  }))
}

function activeTimelineRows(rows: Record<string, unknown>[], asOf: string, includeInvalidated = false) {
  if (includeInvalidated) return timeline(rows)
  const at = new Date(asOf)
  return timeline(rows.filter(row =>
    new Date(row.valid_at as string) <= at
    && (!row.invalid_at || new Date(row.invalid_at as string) > at)
    && (!row.expired_at || new Date(row.expired_at as string) > at)
  ))
}

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
    expect(ddl).toContain('valid_at')
    expect(ddl).toContain('invalid_at')
    expect(ddl).toContain('expired_at')
    expect(ddl).toContain('supersession_key')
    expect(ddl).toContain('superseded_by_id')
    expect(ddl).toContain('superseded_at')
    expect(ddl).toContain('supersession_idx')
    expect(ddl).toContain("CHECK (source_type IN ('entity', 'chunk', 'memory'))")
    expect(ddl).toContain('typegraph_entity_chunk_mentions')
    expect(ddl).toContain('typegraph_memory_artifacts')
    expect(ddl).toContain('PRIMARY KEY (tenant_id, graph_id, layout_id, path)')
    expect(ddl).toContain('content_hash')
    expect(ddl).toContain("CHECK (kind IN ('summary', 'handbook', 'raw_memory', 'raw_memories', 'rollout_summary', 'phase_two_selection', 'skill', 'other'))")
    expect(ddl).not.toMatch(/\bscope\s+JSONB\b/)
    expect(ddl).not.toContain('typegraph_passage_nodes')
    expect(ddl).not.toContain('typegraph_passage_entity_edges')
  })

  it('persists memory artifacts by tenant, graph, layout, and path', async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const rowKey = (tenantId: unknown, graphId: unknown, layoutId: unknown, path: unknown) =>
      [tenantId, graphId, layoutId, path].join('|')
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      const bound = params ?? []
      if (query.includes('INSERT INTO typegraph_memory_artifacts')) {
        const row = {
          tenant_id: bound[0],
          graph_id: bound[1],
          layout_id: bound[2],
          path: bound[3],
          kind: bound[4],
          content: bound[5],
          metadata: bound[6],
          content_hash: bound[7],
          created_at: '2026-05-20T00:00:00.000Z',
          updated_at: '2026-05-20T00:00:00.000Z',
        }
        rows.set(rowKey(bound[0], bound[1], bound[2], bound[3]), row)
        return [row]
      }
      if (query.includes('SELECT tenant_id, graph_id, layout_id, path, kind, content')) {
        if (query.includes('path = $4')) {
          const row = rows.get(rowKey(bound[0], bound[1], bound[2], bound[3]))
          return row ? [row] : []
        }
        const graphIds = bound[1] as string[]
        const kind = query.includes('kind = $') ? bound[bound.length - 1] : undefined
        return [...rows.values()].filter(row =>
          row.tenant_id === bound[0]
          && graphIds.includes(row.graph_id as string)
          && (!query.includes('layout_id = $') || row.layout_id === bound[2])
          && (!query.includes('path LIKE') || String(row.path).startsWith(String(bound[bound.length - 1]).replace(/%$/, '')))
          && (!kind || row.kind === kind)
        )
      }
      if (query.includes('DELETE FROM typegraph_memory_artifacts')) {
        rows.delete(rowKey(bound[0], bound[1], bound[2], bound[3]))
      }
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    const artifact = await store.upsertArtifact({
      identity: { tenantId: 'tenant-1', graphId: 'memory:user:user-1' },
      layoutId: 'default',
      path: 'MEMORY.md',
      kind: 'handbook',
      content: '# Task Group: Memory',
      contentHash: 'hash-1',
      metadata: { selected: 1 },
    })
    const loaded = await store.getArtifact({ tenantId: 'tenant-1', graphId: 'memory:user:user-1' }, 'default', 'MEMORY.md')
    const listed = await store.listArtifacts({
      identity: { tenantId: 'tenant-1', graphId: 'memory:user:user-1' },
      layoutId: 'default',
      kind: 'handbook',
    })
    await store.deleteArtifact({ tenantId: 'tenant-1', graphId: 'memory:user:user-1' }, 'default', 'MEMORY.md')

    expect(artifact).toMatchObject({
      tenantId: 'tenant-1',
      graphId: 'memory:user:user-1',
      layoutId: 'default',
      path: 'MEMORY.md',
      kind: 'handbook',
      contentHash: 'hash-1',
      metadata: { selected: 1 },
    })
    expect(loaded?.path).toBe('MEMORY.md')
    expect(listed.map(item => item.path)).toEqual(['MEMORY.md'])
    expect(await store.getArtifact({ tenantId: 'tenant-1', graphId: 'memory:user:user-1' }, 'default', 'MEMORY.md')).toBeNull()
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
      metadata: { mentionCount: 1 },
      scope: { tenantId: 'tenant-1' },
      targetChunkRef: {
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 2,
        embeddingModel: 'mock-embed',
        chunkId: 'chunk_pat',
      },
      evidence: ['chunk_pat'],
      temporal: {
        validAt: new Date('2026-04-16T00:00:00Z'),
        createdAt: new Date('2026-04-16T00:00:00Z'),
      },
    }

    await store.upsertGraphEdges([edge])

    expect(capturedQuery).toContain('INSERT INTO typegraph_graph_edges')
    expect(capturedQuery).toContain('ON CONFLICT (tenant_id, graph_id, id)')
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
    expect(capturedParams[24]).toBe('public')
    expect(capturedParams[25]).toEqual(['chunk_pat'])
  })

  it('retries fact record upsert on duplicate deterministic fact id', async () => {
    const queries: string[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      queries.push(query)
      if (query.includes('ON CONFLICT (tenant_id, graph_id, edge_id)')) {
        const err = new Error('duplicate key value violates unique constraint "typegraph_fact_records_pkey"')
        Object.assign(err, { code: '23505', constraint: 'typegraph_fact_records_pkey' })
        throw err
      }
      return [rowFromParams(params)]
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    const result = await store.upsertFactRecord(makeFact())

    expect(sql).toHaveBeenCalledTimes(2)
    expect(queries[0]).toContain('ON CONFLICT (tenant_id, graph_id, edge_id)')
    expect(queries[1]).toContain('ON CONFLICT (tenant_id, graph_id, id)')
    expect(queries[1]).toContain('edge_id = EXCLUDED.edge_id')
    expect(result.id).toBe('fact-stable')
    expect(result.edgeId).toBe('edge-new')
  })

  it('inserts superseded facts into the timeline without depending on ingest order', async () => {
    const updates: Array<{ query: string; params: unknown[] }> = []
    const fact = {
      ...makeFact(),
      id: 'fact-stage-a',
      edgeId: 'edge-stage-a',
      relation: 'DEAL_STAGE',
      validAt: new Date('2026-01-01T00:00:00Z'),
      supersessionKey: 'hubspot:deal:123:deal_stage',
    }
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      if (query.includes('INSERT INTO typegraph_fact_records')) {
        return [rowFromParams(params)]
      }
      if (query.includes('AND valid_at >')) {
        return [{ id: 'fact-stage-b', valid_at: '2026-02-01T00:00:00Z' }]
      }
      if (query.includes('AND valid_at <')) {
        return [{ id: 'fact-stage-before', invalid_at: null }]
      }
      if (query.includes('UPDATE typegraph_fact_records')) {
        updates.push({ query, params: params ?? [] })
        return []
      }
      if (query.includes('WHERE tenant_id = $1 AND graph_id = $2 AND id = $3')) {
        return [{
          ...rowFromParams([
            fact.id,
            fact.edgeId,
            fact.sourceEntityId,
            fact.targetEntityId,
            fact.relation,
            'Stage A',
            'Stage A',
            null,
            'Stage A',
            null,
            fact.weight,
            1,
            null,
            'tenant-1',
            null,
            null,
            null,
            null,
            null,
            'public',
            '2026-01-01T00:00:00.000Z',
            '2026-02-01T00:00:00.000Z',
            null,
            fact.supersessionKey,
            'fact-stage-b',
            '2026-04-16T00:00:00Z',
            '2026-04-16T00:00:00Z',
            '2026-04-16T00:00:00Z',
          ]),
        }]
      }
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    const result = await store.upsertFactRecord(fact)

    expect(result.invalidAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    expect(result.supersededById).toBe('fact-stage-b')
    expect(updates.some(call => call.params.includes('fact-stage-before') && call.params.includes('fact-stage-a'))).toBe(true)
  })

  it('converges fact supersession windows for chronological and reverse ingestion', async () => {
    const chronological = createFactTimelineSql()
    const chronologicalStore = new PgMemoryStoreAdapter({ sql: chronological.sql, embeddingDimensions: 4 })
    await chronologicalStore.upsertFactRecord(makeStageFact('A', '2026-01-01T00:00:00Z'))
    await chronologicalStore.upsertFactRecord(makeStageFact('B', '2026-02-01T00:00:00Z'))

    const reverse = createFactTimelineSql()
    const reverseStore = new PgMemoryStoreAdapter({ sql: reverse.sql, embeddingDimensions: 4 })
    await reverseStore.upsertFactRecord(makeStageFact('B', '2026-02-01T00:00:00Z'))
    await reverseStore.upsertFactRecord(makeStageFact('A', '2026-01-01T00:00:00Z'))

    expect(timeline(reverse.rows())).toEqual(timeline(chronological.rows()))
    expect(timeline(chronological.rows())).toEqual([
      {
        id: 'fact-stage-a',
        validAt: '2026-01-01T00:00:00.000Z',
        invalidAt: '2026-02-01T00:00:00.000Z',
        supersededById: 'fact-stage-b',
      },
      {
        id: 'fact-stage-b',
        validAt: '2026-02-01T00:00:00.000Z',
        invalidAt: null,
        supersededById: null,
      },
    ])
    expect(activeTimelineRows(chronological.rows(), '2026-01-15T00:00:00Z').map(row => row.id)).toEqual(['fact-stage-a'])
    expect(activeTimelineRows(chronological.rows(), '2026-03-01T00:00:00Z').map(row => row.id)).toEqual(['fact-stage-b'])
    expect(activeTimelineRows(chronological.rows(), '2026-03-01T00:00:00Z', true).map(row => row.id)).toEqual(['fact-stage-a', 'fact-stage-b'])
  })

  it('inserts a backfilled supersession fact between existing versions', async () => {
    const timelineSql = createFactTimelineSql()
    const store = new PgMemoryStoreAdapter({ sql: timelineSql.sql, embeddingDimensions: 4 })

    await store.upsertFactRecord(makeStageFact('A', '2026-01-01T00:00:00Z'))
    await store.upsertFactRecord(makeStageFact('C', '2026-03-01T00:00:00Z'))
    await store.upsertFactRecord(makeStageFact('B', '2026-02-01T00:00:00Z'))

    expect(timeline(timelineSql.rows())).toEqual([
      {
        id: 'fact-stage-a',
        validAt: '2026-01-01T00:00:00.000Z',
        invalidAt: '2026-02-01T00:00:00.000Z',
        supersededById: 'fact-stage-b',
      },
      {
        id: 'fact-stage-b',
        validAt: '2026-02-01T00:00:00.000Z',
        invalidAt: '2026-03-01T00:00:00.000Z',
        supersededById: 'fact-stage-c',
      },
      {
        id: 'fact-stage-c',
        validAt: '2026-03-01T00:00:00.000Z',
        invalidAt: null,
        supersededById: null,
      },
    ])
  })

  it('merges duplicate drip versions with the same supersessionKey and validAt', async () => {
    const timelineSql = createFactTimelineSql()
    const store = new PgMemoryStoreAdapter({ sql: timelineSql.sql, embeddingDimensions: 4 })
    const first = makeStageFact('B', '2026-02-01T00:00:00Z')

    await store.upsertFactRecord(first)
    await store.upsertFactRecord({
      ...first,
      description: 'Deal stage B from retry',
      evidenceText: 'Deal stage B from retry',
      weight: 0.9,
    })

    expect(timelineSql.rows()).toHaveLength(1)
    expect(timelineSql.rows()[0]?.fact_text).toBe('Deal stage B from retry')
    expect(timelineSql.rows()[0]?.weight).toBe(0.9)
  })

  it('does not timeline-manage facts without a supersessionKey', async () => {
    const timelineSql = createFactTimelineSql()
    const store = new PgMemoryStoreAdapter({ sql: timelineSql.sql, embeddingDimensions: 4 })

    await store.upsertFactRecord(makeStageFact('A', '2026-01-01T00:00:00Z', {
      supersessionKey: undefined,
    }))
    await store.upsertFactRecord(makeStageFact('B', '2026-02-01T00:00:00Z', {
      supersessionKey: undefined,
    }))

    expect(timelineSql.rows()).toHaveLength(2)
    expect(timelineSql.rows().every(row => row.invalid_at == null && row.superseded_by_id == null)).toBe(true)
    expect(timelineSql.updates).toHaveLength(0)
  })

  it('applies the same temporal predicate to vector and hybrid fact search', async () => {
    const calls: SqlCall[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      calls.push({ query, params: params ?? [] })
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })
    const identity = { tenantId: 'tenant-1', graphId: 'employee' }
    const temporal = { asOf: new Date('2026-01-15T00:00:00Z') }

    await store.searchFacts([0.1, 0.2, 0.3, 0.4], identity, 7, temporal)
    await store.searchFactsHybrid('deal stage', [0.1, 0.2, 0.3, 0.4], identity, 7, temporal)

    const factSearchQueries = calls
      .map(call => call.query)
      .filter(query => query.includes('typegraph_fact_records') && (query.includes('embedding IS NOT NULL') || query.includes('websearch_to_tsquery')))
    expect(factSearchQueries.length).toBeGreaterThanOrEqual(3)
    for (const query of factSearchQueries) {
      expect(query).toContain('valid_at')
      expect(query).toContain('invalid_at')
      expect(query).toContain('expired_at')
      expect(query).toContain('<= ')
      expect(query).toContain('> ')
    }
  })

  it('applies temporal predicates to edge traversal and graph chunk search', async () => {
    const calls: SqlCall[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      calls.push({ query, params: params ?? [] })
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })
    const identity = { tenantId: 'tenant-1', graphId: 'employee' }
    const temporal = { asOf: new Date('2026-01-15T00:00:00Z') }

    await store.getEdges('ent-1', 'both', identity, temporal)
    await store.getEdgesBatch(['ent-1'], 'out', identity, temporal)
    await store.getChunkEdgesForEntities(['ent-1'], { scope: identity, temporal, limit: 10 })

    const graphReadQueries = calls.map(call => call.query).filter(query => query.includes('typegraph_graph_edges'))
    expect(graphReadQueries).toHaveLength(3)
    for (const query of graphReadQueries) {
      expect(query).toContain('valid_at')
      expect(query).toContain('invalid_at')
      expect(query).toContain('expired_at')
      expect(query).toContain('<= ')
      expect(query).toContain('> ')
    }
  })

  it('keeps historical graph rows when explicit invalidation APIs are used', async () => {
    const calls: SqlCall[] = []
    const sql = vi.fn(async (query: string, params?: unknown[]) => {
      calls.push({ query, params: params ?? [] })
      return []
    })
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })
    const invalidAt = new Date('2026-02-01T00:00:00Z')

    await store.invalidateFactRecord('fact-1', { invalidAt, reason: 'source_deleted' }, { tenantId: 'tenant-1', graphId: 'employee' })
    await store.invalidateEdge('edge-1', invalidAt, { reason: 'source_deleted' })

    const [factCall, edgeCall] = calls
    expect(factCall?.query).toContain('UPDATE typegraph_fact_records')
    expect(factCall?.query).toContain('SET invalid_at = $2')
    expect(factCall?.query).toContain('expired_at = COALESCE')
    expect(factCall?.params[1]).toBe('2026-02-01T00:00:00.000Z')
    expect(edgeCall?.query).toContain('UPDATE typegraph_graph_edges')
    expect(edgeCall?.query).toContain('SET invalid_at = $2')
    expect(edgeCall?.query).toContain('expired_at = COALESCE')
    expect(edgeCall?.params[1]).toBe('2026-02-01T00:00:00.000Z')
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
    expect(capturedQuery).toContain('WHERE typegraph_entity_external_ids.tenant_id = EXCLUDED.tenant_id')
    expect(capturedQuery).toContain('AND typegraph_entity_external_ids.entity_id = EXCLUDED.entity_id')
    expect(capturedParams[1]).toBe('ent_alice')
    expect(capturedParams[2]).toBe('email')
    expect(capturedParams[3]).toBe('Alice@Example.com')
    expect(capturedParams[4]).toBe('alice@example.com')
    expect(capturedParams[5]).toBe('none')
    expect(capturedParams[7]).toBe('tenant-1')
    expect(capturedParams[8]).toBe('public')
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
    expect(capturedQuery).not.toContain('$4')
    expect(capturedParams).toEqual([
      'crm_account_id',
      '001ACME',
      'none',
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
      threadId: 'thread-1',
    }
    const store = new PgMemoryStoreAdapter({ sql, embeddingDimensions: 4 })

    await store.findEntityByExternalId({ type: 'crm_account_id', id: '001ACME' }, identity)
    await store.searchEntitiesHybrid('Acme SSO Marcus Priya', [0.1, 0.2, 0.3, 0.4], identity, 7)
    await store.searchFactsHybrid('Acme SSO token refresh Marcus Priya', [0.1, 0.2, 0.3, 0.4], identity, 7)
    await store.getChunkEdgesForEntities(['ent_acme', 'ent_bug'], { scope: identity, bucketIds: ['bkt_acme'], limit: 25 })
    await store.getChunksByRefs(
      [{ bucketId: 'bkt_acme', documentId: 'doc_slack', chunkIndex: 2 }],
      { chunksTable: 'typegraph_chunks', scope: identity, bucketIds: ['bkt_acme'] },
    )
    await store.searchChunks(
      [0.1, 0.2, 0.3, 0.4],
      identity,
      {
        chunksTable: 'typegraph_chunks',
        bucketIds: ['bkt_acme'],
        limit: 20,
        chunkRefs: [{ bucketId: 'bkt_acme', documentId: 'doc_slack', chunkIndex: 2 }],
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
        threadId: identity.threadId,
        category: ['episodic', 'semantic'],
        activeAt: new Date('2026-04-16T00:00:00Z'),
      },
    })

    const documentStore = new PgDocumentStore(sql, 'typegraph_documents')
    await documentStore.list({
      bucketId: 'bkt_acme',
      tenantId: identity.tenantId,
      groupId: identity.groupId,
      userId: identity.userId,
      agentId: identity.agentId,
      threadId: identity.threadId,
      status: ['complete', 'processing'],
      documentIds: ['doc_slack'],
    }, { limit: 10, offset: 5 })
    await documentStore.update(identity.tenantId, 'doc_slack', {
      name: 'Slack export',
      url: 'https://demo.slack.local/thread',
      metadata: { source: 'slack' },
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
