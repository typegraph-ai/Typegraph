import { describe, expect, it, vi } from 'vitest'
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
})
