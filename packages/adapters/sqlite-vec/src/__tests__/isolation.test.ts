import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { EmbeddedChunk, Bucket } from '@typegraph-ai/sdk'
import { SqliteVecAdapter } from '../adapter.js'

const MODEL = 'test/identity-model'
const DIMS = 4

function makeChunk(overrides: Partial<EmbeddedChunk> = {}): EmbeddedChunk {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'ikey-default',
    bucketId: overrides.bucketId ?? 'bucket-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    groupId: overrides.groupId,
    userId: overrides.userId,
    agentId: overrides.agentId,
    conversationId: overrides.conversationId,
    documentId: overrides.documentId ?? 'doc-1',
    content: overrides.content ?? 'hello world',
    embedding: overrides.embedding ?? [1, 0, 0, 0],
    embeddingModel: MODEL,
    chunkIndex: overrides.chunkIndex ?? 0,
    totalChunks: overrides.totalChunks ?? 1,
    metadata: overrides.metadata ?? {},
    indexedAt: overrides.indexedAt ?? new Date('2026-04-16T00:00:00Z'),
  }
}

describe('SqliteVecAdapter — identity isolation', () => {
  let adapter: SqliteVecAdapter

  beforeEach(async () => {
    adapter = new SqliteVecAdapter({ dbPath: ':memory:' })
    await adapter.deploy()
    await adapter.connect()
    await adapter.ensureModel(MODEL, DIMS)
  })

  afterEach(async () => {
    await adapter.destroy?.()
  })

  it('search filters by userId within the same tenant', async () => {
    await adapter.upsertDocument(MODEL, [
      makeChunk({ idempotencyKey: 'A', userId: 'user-a', documentId: 'doc-a', embedding: [1, 0, 0, 0] }),
      makeChunk({ idempotencyKey: 'B', userId: 'user-b', documentId: 'doc-b', embedding: [0, 1, 0, 0] }),
    ])

    const results = await adapter.search(MODEL, [1, 0, 0, 0], {
      count: 10,
      filter: { tenantId: 'tenant-1', userId: 'user-a' },
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.userId).toBe('user-a')
    expect(results[0]!.documentId).toBe('doc-a')
  })

  it('search filters by agentId', async () => {
    await adapter.upsertDocument(MODEL, [
      makeChunk({ idempotencyKey: 'A', agentId: 'agent-a', embedding: [1, 0, 0, 0] }),
      makeChunk({ idempotencyKey: 'B', agentId: 'agent-b', embedding: [1, 0, 0, 0] }),
    ])

    const results = await adapter.search(MODEL, [1, 0, 0, 0], {
      count: 10,
      filter: { agentId: 'agent-a' },
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.agentId).toBe('agent-a')
  })

  it('search filters by conversationId', async () => {
    await adapter.upsertDocument(MODEL, [
      makeChunk({ idempotencyKey: 'A', conversationId: 'conv-a', embedding: [1, 0, 0, 0] }),
      makeChunk({ idempotencyKey: 'B', conversationId: 'conv-b', embedding: [1, 0, 0, 0] }),
    ])

    const results = await adapter.search(MODEL, [1, 0, 0, 0], {
      count: 10,
      filter: { conversationId: 'conv-a' },
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.conversationId).toBe('conv-a')
  })

  it('search filters by groupId', async () => {
    await adapter.upsertDocument(MODEL, [
      makeChunk({ idempotencyKey: 'A', groupId: 'group-a', embedding: [1, 0, 0, 0] }),
      makeChunk({ idempotencyKey: 'B', groupId: 'group-b', embedding: [1, 0, 0, 0] }),
    ])

    const results = await adapter.search(MODEL, [1, 0, 0, 0], {
      count: 10,
      filter: { groupId: 'group-a' },
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.groupId).toBe('group-a')
  })

  it('countChunks respects identity filters', async () => {
    await adapter.upsertDocument(MODEL, [
      makeChunk({ idempotencyKey: 'A', userId: 'user-a' }),
      makeChunk({ idempotencyKey: 'B', userId: 'user-b' }),
      makeChunk({ idempotencyKey: 'C', userId: 'user-a' }),
    ])

    expect(await adapter.countChunks(MODEL, { userId: 'user-a' })).toBe(2)
    expect(await adapter.countChunks(MODEL, { userId: 'user-b' })).toBe(1)
    expect(await adapter.countChunks(MODEL, { tenantId: 'tenant-1' })).toBe(3)
  })

  it('mapRowToScoredChunk returns all identity fields', async () => {
    await adapter.upsertDocument(MODEL, [
      makeChunk({
        idempotencyKey: 'A',
        tenantId: 't1',
        groupId: 'g1',
        userId: 'u1',
        agentId: 'a1',
        conversationId: 'c1',
      }),
    ])

    const [result] = await adapter.search(MODEL, [1, 0, 0, 0], { count: 1 })
    expect(result).toBeDefined()
    expect(result!.tenantId).toBe('t1')
    expect(result!.groupId).toBe('g1')
    expect(result!.userId).toBe('u1')
    expect(result!.agentId).toBe('a1')
    expect(result!.conversationId).toBe('c1')
  })
})

describe('SqliteVecAdapter — bucket identity + cascade', () => {
  let adapter: SqliteVecAdapter

  beforeEach(async () => {
    adapter = new SqliteVecAdapter({ dbPath: ':memory:' })
    await adapter.deploy()
    await adapter.connect()
    await adapter.ensureModel(MODEL, DIMS)
  })

  afterEach(async () => {
    await adapter.destroy?.()
  })

  it('upsertBucket round-trips all 5 identity fields', async () => {
    const input: Bucket = {
      id: 'b1',
      name: 'test-bucket',
      status: 'active',
      tenantId: 't1',
      groupId: 'g1',
      userId: 'u1',
      agentId: 'a1',
      conversationId: 'c1',
    }
    await adapter.upsertBucket!(input)
    const roundTripped = await adapter.getBucket!('b1')
    expect(roundTripped).toMatchObject({
      id: 'b1',
      tenantId: 't1',
      groupId: 'g1',
      userId: 'u1',
      agentId: 'a1',
      conversationId: 'c1',
    })
  })

  it('listBuckets filters by userId', async () => {
    await adapter.upsertBucket!({ id: 'b1', name: 'b1', status: 'active', tenantId: 't1', userId: 'u1' })
    await adapter.upsertBucket!({ id: 'b2', name: 'b2', status: 'active', tenantId: 't1', userId: 'u2' })

    const result = await adapter.listBuckets!({ userId: 'u1' })
    const buckets = Array.isArray(result) ? result : result.items
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.id).toBe('b1')
  })

  it('listBuckets filters by agentId', async () => {
    await adapter.upsertBucket!({ id: 'b1', name: 'b1', status: 'active', tenantId: 't1', agentId: 'a1' })
    await adapter.upsertBucket!({ id: 'b2', name: 'b2', status: 'active', tenantId: 't1', agentId: 'a2' })

    const result = await adapter.listBuckets!({ agentId: 'a1' })
    const buckets = Array.isArray(result) ? result : result.items
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.id).toBe('b1')
  })

  it('deleteBucket cascades to chunks, vec table, and hashes', async () => {
    await adapter.upsertBucket!({ id: 'b1', name: 'b1', status: 'active', tenantId: 't1' })
    await adapter.upsertDocument(MODEL, [
      makeChunk({ idempotencyKey: 'k1', bucketId: 'b1' }),
      makeChunk({ idempotencyKey: 'k2', bucketId: 'b1', documentId: 'doc-2' }),
    ])
    await adapter.hashStore.set('b1:t1:k1', {
      idempotencyKey: 'k1',
      contentHash: 'h1',
      bucketId: 'b1',
      tenantId: 't1',
      embeddingModel: MODEL,
      indexedAt: new Date(),
      chunkCount: 1,
    })

    // Sanity
    expect(await adapter.countChunks(MODEL, { bucketId: 'b1' })).toBe(2)
    expect(await adapter.hashStore.get('b1:t1:k1')).not.toBeNull()

    await adapter.deleteBucket!('b1')

    // Bucket record gone
    expect(await adapter.getBucket!('b1')).toBeNull()
    // Chunks gone
    expect(await adapter.countChunks(MODEL, { bucketId: 'b1' })).toBe(0)
    // Hash entries gone
    expect(await adapter.hashStore.get('b1:t1:k1')).toBeNull()
    // Search returns nothing
    const results = await adapter.search(MODEL, [1, 0, 0, 0], { count: 10, filter: { bucketId: 'b1' } })
    expect(results).toHaveLength(0)
  })
})

describe('SqliteHashStore — getMany', () => {
  let adapter: SqliteVecAdapter

  beforeEach(async () => {
    adapter = new SqliteVecAdapter({ dbPath: ':memory:' })
    await adapter.deploy()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.destroy?.()
  })

  it('returns a map of found records and omits missing keys', async () => {
    const rec = {
      idempotencyKey: 'ikey',
      contentHash: 'h',
      bucketId: 'b1',
      tenantId: 't1',
      embeddingModel: MODEL,
      indexedAt: new Date('2026-04-16T00:00:00Z'),
      chunkCount: 1,
    }
    await adapter.hashStore.set('k1', rec)
    await adapter.hashStore.set('k2', rec)

    const result = await adapter.hashStore.getMany!(['k1', 'k2', 'k3'])
    expect(result.size).toBe(2)
    expect(result.get('k1')).toBeDefined()
    expect(result.get('k2')).toBeDefined()
    expect(result.get('k3')).toBeUndefined()
  })

  it('returns empty map for empty input', async () => {
    const result = await adapter.hashStore.getMany!([])
    expect(result.size).toBe(0)
  })
})
