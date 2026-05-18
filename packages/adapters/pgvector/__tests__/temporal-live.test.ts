import { describe, expect, it } from 'vitest'
import type { SemanticFactRecord } from '@typegraph-ai/sdk'
import { PgMemoryStoreAdapter } from '../src/memory-store.js'

const liveDatabaseTest = process.env.TYPEGRAPH_PGVECTOR_INTEGRATION_TEST_URL ? it : it.skip

type SqlClient = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  end: () => Promise<void>
}

async function loadPostgres() {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>
  try {
    const mod = await dynamicImport('postgres') as { default?: unknown }
    return mod.default ?? mod
  } catch (error) {
    throw new Error(
      'TYPEGRAPH_PGVECTOR_INTEGRATION_TEST_URL is set, but the optional "postgres" package is not available. Install workspace dependencies before running live pgvector tests.',
      { cause: error },
    )
  }
}

function makeFact(stage: string, validAt: string, graphId: string): SemanticFactRecord {
  return {
    id: `fact-stage-${stage.toLowerCase()}`,
    edgeId: `edge-stage-${stage.toLowerCase()}`,
    sourceEntityId: 'deal-acme-renewal',
    targetEntityId: `stage-${stage.toLowerCase()}`,
    relation: 'DEAL_STAGE',
    description: `Acme renewal stage ${stage}`,
    evidenceText: `Acme renewal stage ${stage}`,
    weight: 1,
    evidenceCount: 1,
    embedding: [1, 0, 0, 0],
    scope: { tenantId: 'tenant-live-temporal', graphId },
    validAt: new Date(validAt),
    createdAt: new Date('2026-04-16T00:00:00Z'),
    updatedAt: new Date('2026-04-16T00:00:00Z'),
    supersessionKey: 'hubspot:12345:deal:222:deal_stage',
  }
}

function summarize(rows: SemanticFactRecord[]) {
  return rows
    .sort((a, b) => a.validAt.getTime() - b.validAt.getTime())
    .map(row => ({
      id: row.id,
      validAt: row.validAt.toISOString(),
      invalidAt: row.invalidAt?.toISOString() ?? null,
      supersededById: row.supersededById ?? null,
    }))
}

describe('PgMemoryStoreAdapter live temporal integration', () => {
  liveDatabaseTest('converges chronological, reverse, and duplicate drip supersession ingestion', async () => {
    const postgres = await loadPostgres() as (url: string, opts?: Record<string, unknown>) => SqlClient
    const client = postgres(process.env.TYPEGRAPH_PGVECTOR_INTEGRATION_TEST_URL!, { max: 1 })
    const schema = `tg_temporal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const sql = (query: string, params?: unknown[]) => client.unsafe(query, params ?? [])

    try {
      await sql('CREATE EXTENSION IF NOT EXISTS vector')
      const store = new PgMemoryStoreAdapter({ sql, schema, embeddingDimensions: 4 })
      await store.initialize()

      const run = async (graphId: string, facts: SemanticFactRecord[]) => {
        for (const fact of facts) await store.upsertFactRecord(fact)
        return store.searchFacts([1, 0, 0, 0], { tenantId: 'tenant-live-temporal', graphId }, 10, { includeInvalidated: true })
      }

      const chronological = await run('chronological', [
        makeFact('A', '2026-01-01T00:00:00Z', 'chronological'),
        makeFact('B', '2026-02-01T00:00:00Z', 'chronological'),
      ])
      const reverse = await run('reverse', [
        makeFact('B', '2026-02-01T00:00:00Z', 'reverse'),
        makeFact('A', '2026-01-01T00:00:00Z', 'reverse'),
      ])
      const duplicate = await run('duplicate', [
        makeFact('B', '2026-02-01T00:00:00Z', 'duplicate'),
        makeFact('B', '2026-02-01T00:00:00Z', 'duplicate'),
      ])

      expect(summarize(reverse)).toEqual(summarize(chronological))
      expect(summarize(chronological)).toEqual([
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
      expect(summarize(duplicate)).toHaveLength(1)

      const jan15 = await store.searchFacts(
        [1, 0, 0, 0],
        { tenantId: 'tenant-live-temporal', graphId: 'chronological' },
        10,
        { asOf: new Date('2026-01-15T00:00:00Z') },
      )
      const current = await store.searchFacts(
        [1, 0, 0, 0],
        { tenantId: 'tenant-live-temporal', graphId: 'chronological' },
        10,
        { asOf: new Date('2026-03-01T00:00:00Z') },
      )

      expect(jan15.map(fact => fact.id)).toEqual(['fact-stage-a'])
      expect(current.map(fact => fact.id)).toEqual(['fact-stage-b'])
    } finally {
      await sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
