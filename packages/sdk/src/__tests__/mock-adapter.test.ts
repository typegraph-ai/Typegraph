import { describe, it, expect, beforeEach } from 'vitest'
import { createMockAdapter, createMockHashStore } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import type { EmbeddedChunk } from '../types/document.js'

function makeChunk(overrides: Partial<EmbeddedChunk> = {}): EmbeddedChunk {
  return {
    idempotencyKey: 'key-1',
    bucketId: 'src-1',
    documentId: 'doc-1',
    content: 'Test chunk content',
    embedding: [0.1, 0.2, 0.3, 0.4],
    embeddingModel: 'mock-embed-v1',
    chunkIndex: 0,
    totalChunks: 1,
    metadata: {},
    indexedAt: new Date(),
    ...overrides,
  }
}

describe('MockAdapter', () => {
  let adapter: ReturnType<typeof createMockAdapter>

  beforeEach(() => {
    adapter = createMockAdapter()
  })

  it('tracks deploy, connect, and destroy calls', async () => {
    await adapter.deploy()
    await adapter.connect()
    await adapter.destroy!()
    expect(adapter.calls.filter(c => c.method === 'deploy')).toHaveLength(1)
    expect(adapter.calls.filter(c => c.method === 'connect')).toHaveLength(1)
    expect(adapter.calls.filter(c => c.method === 'destroy')).toHaveLength(1)
  })

  it('ensureModel creates storage', async () => {
    await adapter.ensureModel('test-model', 4)
    expect(adapter._chunks.has('test-model')).toBe(true)
  })

  it('upsertDocument stores chunks', async () => {
    await adapter.ensureModel('model', 4)
    const chunk = makeChunk()
    await adapter.upsertDocument('model', [chunk])
    expect(adapter._chunks.get('model')).toHaveLength(1)
  })

  it('search retrieves by cosine similarity', async () => {
    await adapter.ensureModel('model', 4)
    await adapter.upsertDocument('model', [
      makeChunk({ embedding: [1, 0, 0, 0], content: 'A' }),
      makeChunk({ embedding: [0, 1, 0, 0], content: 'B', idempotencyKey: 'key-2' }),
    ])

    const results = await adapter.search('model', [1, 0, 0, 0], { count: 10 })
    expect(results[0]!.content).toBe('A')
    expect(results[0]!.scores.semantic).toBeCloseTo(1)
  })

  it('search sorts by cosine similarity', async () => {
    await adapter.ensureModel('model', 4)
    await adapter.upsertDocument('model', [
      makeChunk({ embedding: [0, 0, 0, 1], content: 'Far', idempotencyKey: 'k1' }),
      makeChunk({ embedding: [0.9, 0.1, 0, 0], content: 'Close', idempotencyKey: 'k2' }),
      makeChunk({ embedding: [1, 0, 0, 0], content: 'Exact', idempotencyKey: 'k3' }),
    ])

    const results = await adapter.search('model', [1, 0, 0, 0], { count: 3 })
    expect(results[0]!.content).toBe('Exact')
    expect(results[2]!.content).toBe('Far')
  })

  it('hybridSearch includes keyword matching', async () => {
    await adapter.ensureModel('model', 4)
    await adapter.upsertDocument('model', [
      makeChunk({ embedding: [0.5, 0.5, 0, 0], content: 'JavaScript programming', idempotencyKey: 'k1' }),
      makeChunk({ embedding: [0.5, 0.5, 0, 0], content: 'Python scripting', idempotencyKey: 'k2' }),
    ])

    const results = await adapter.hybridSearch!('model', [0.5, 0.5, 0, 0], 'JavaScript', { count: 2 })
    // JavaScript should score higher due to keyword match
    expect(results[0]!.content).toContain('JavaScript')
    expect(results[0]!.scores.keyword).toBeGreaterThan(0)
  })

  it('upsert replaces existing chunks', async () => {
    await adapter.ensureModel('model', 4)
    const chunk = makeChunk({ content: 'Original' })
    await adapter.upsertDocument('model', [chunk])
    const updated = makeChunk({ content: 'Updated' })
    await adapter.upsertDocument('model', [updated])
    expect(adapter._chunks.get('model')).toHaveLength(1)
    expect(adapter._chunks.get('model')![0]!.content).toBe('Updated')
  })

  it('delete by filter', async () => {
    await adapter.ensureModel('model', 4)
    await adapter.upsertDocument('model', [
      makeChunk({ bucketId: 'src-1', idempotencyKey: 'k1' }),
      makeChunk({ bucketId: 'src-2', idempotencyKey: 'k2' }),
    ])
    await adapter.delete('model', { bucketId: 'src-1' })
    expect(adapter._chunks.get('model')).toHaveLength(1)
    expect(adapter._chunks.get('model')![0]!.bucketId).toBe('src-2')
  })

  it('countChunks by filter', async () => {
    await adapter.ensureModel('model', 4)
    await adapter.upsertDocument('model', [
      makeChunk({ bucketId: 'src-1', idempotencyKey: 'k1' }),
      makeChunk({ bucketId: 'src-1', idempotencyKey: 'k2', chunkIndex: 1 }),
      makeChunk({ bucketId: 'src-2', idempotencyKey: 'k3' }),
    ])
    const count = await adapter.countChunks('model', { bucketId: 'src-1' })
    expect(count).toBe(2)
  })

  it('document records: upsert and retrieve', async () => {
    const doc = await adapter.upsertDocumentRecord!({
      bucketId: 'src-1',
      title: 'Test',
      contentHash: 'abc',
      chunkCount: 5,
      status: 'complete',
    })
    expect(doc.id).toBeDefined()
    expect(doc.title).toBe('Test')
    expect(doc.status).toBe('complete')

    const retrieved = await adapter.getDocument!(doc.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe(doc.id)
  })

  it('updateDocumentStatus', async () => {
    const doc = await adapter.upsertDocumentRecord!({
      bucketId: 'src-1',
      title: 'Test',
      contentHash: 'abc',
      chunkCount: 0,
      status: 'processing',
    })
    await adapter.updateDocumentStatus!(doc.id, 'complete', 10)
    const updated = await adapter.getDocument!(doc.id)
    expect(updated!.status).toBe('complete')
    expect(updated!.chunkCount).toBe(10)
  })

  it('getChunksByRange returns chunks in range', async () => {
    await adapter.ensureModel('model', 4)
    await adapter.upsertDocument('model', [
      makeChunk({ documentId: 'doc-1', chunkIndex: 0, content: 'C0', idempotencyKey: 'k0' }),
      makeChunk({ documentId: 'doc-1', chunkIndex: 1, content: 'C1', idempotencyKey: 'k1' }),
      makeChunk({ documentId: 'doc-1', chunkIndex: 2, content: 'C2', idempotencyKey: 'k2' }),
      makeChunk({ documentId: 'doc-1', chunkIndex: 3, content: 'C3', idempotencyKey: 'k3' }),
    ])
    const result = await adapter.getChunksByRange!('model', 'doc-1', 1, 2)
    expect(result).toHaveLength(2)
    expect(result[0]!.chunkIndex).toBe(1)
    expect(result[1]!.chunkIndex).toBe(2)
  })
})

describe('MockHashStore', () => {
  let hashStore: ReturnType<typeof createMockHashStore>

  beforeEach(() => {
    hashStore = createMockHashStore()
  })

  it('set and get records', async () => {
    const record = {
      idempotencyKey: 'key-1',
      contentHash: 'hash-1',
      bucketId: 'src-1',
      embeddingModel: 'model',
      indexedAt: new Date(),
      chunkCount: 3,
    }
    await hashStore.set('store-key', record)
    const retrieved = await hashStore.get('store-key')
    expect(retrieved).toEqual(record)
  })

  it('returns null for missing keys', async () => {
    const result = await hashStore.get('nonexistent')
    expect(result).toBeNull()
  })

  it('deletes records', async () => {
    await hashStore.set('key', {
      idempotencyKey: 'k',
      contentHash: 'h',
      bucketId: 's',
      embeddingModel: 'm',
      indexedAt: new Date(),
      chunkCount: 1,
    })
    await hashStore.delete('key')
    expect(await hashStore.get('key')).toBeNull()
  })

  it('listByBucket filters correctly', async () => {
    await hashStore.set('k1', {
      idempotencyKey: 'k1',
      contentHash: 'h1',
      bucketId: 'src-1',
      embeddingModel: 'm',
      indexedAt: new Date(),
      chunkCount: 1,
    })
    await hashStore.set('k2', {
      idempotencyKey: 'k2',
      contentHash: 'h2',
      bucketId: 'src-2',
      embeddingModel: 'm',
      indexedAt: new Date(),
      chunkCount: 1,
    })
    const results = await hashStore.listByBucket('src-1')
    expect(results).toHaveLength(1)
    expect(results[0]!.bucketId).toBe('src-1')
  })

  it('manages lastRunTime', async () => {
    const time = new Date('2024-06-01')
    await hashStore.setLastRunTime('src-1', undefined, time)
    const retrieved = await hashStore.getLastRunTime('src-1', undefined)
    expect(retrieved).toEqual(time)
  })
})
