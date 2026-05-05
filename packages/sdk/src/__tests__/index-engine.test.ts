import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IndexEngine } from '../index-engine/engine.js'
import { embeddingModelKey } from '../embedding/provider.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import { defaultChunker } from '../index-engine/chunker.js'
import { buildHashStoreKey, resolveIdempotencyKey } from '../index-engine/hash.js'
import type { typegraphEvent } from '../types/events.js'

describe('IndexEngine', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>

  beforeEach(() => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
  })

  /** Helper: chunk docs and ingest via engine.ingestBatch */
  async function ingestDocs(
    engine: IndexEngine,
    bucketId: string,
    docs: ReturnType<typeof createTestDocuments>,
    ingestOptions: ReturnType<typeof createMockBucket>['ingestOptions'],
    opts?: Parameters<IndexEngine['ingestBatch']>[2],
  ) {
    const chunkOpts = { chunkSize: ingestOptions.chunkSize ?? 100, chunkOverlap: ingestOptions.chunkOverlap ?? 20 }
    const items = await Promise.all(docs.map(async doc => ({ doc, chunks: await defaultChunker(doc, chunkOpts) })))
    return engine.ingestBatch(bucketId, items, { ...ingestOptions, ...opts })
  }

  describe('ingestBatch', () => {
    it('indexes all documents', async () => {
      const docs = createTestDocuments(3)
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, docs, ingestOptions)
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
      expect(result.skipped).toBe(0)
    })

    it('skips unchanged documents (idempotency)', async () => {
      const docs = createTestDocuments(2)
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, ingestOptions)
      const result2 = await ingestDocs(engine, bucket.id, docs, ingestOptions)
      expect(result2.total).toBe(2)
      expect(result2.skipped).toBe(2)
      expect(result2.inserted).toBe(0)
    })

    it('skips unchanged group-visible documents', async () => {
      const docs = createTestDocuments(2)
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, ingestOptions, {
        groupId: 'Novel-30752',
        visibility: 'group',
      })
      const result2 = await ingestDocs(engine, bucket.id, docs, ingestOptions, {
        groupId: 'Novel-30752',
        visibility: 'group',
      })

      expect(result2.total).toBe(2)
      expect(result2.skipped).toBe(2)
      expect(result2.inserted).toBe(0)
      expect(result2.updated).toBe(0)
      const countCalls = adapter.calls.filter(c => c.method === 'countChunks')
      expect(countCalls.at(-1)!.args[1]).toEqual(expect.objectContaining({
        groupId: 'Novel-30752',
        idempotencyKey: 'doc-2',
      }))
    })

    it('re-indexes on content change', async () => {
      const docs = [createTestDocument({ id: 'doc-1', content: 'Original content' })]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, ingestOptions)

      const updatedDocs = [createTestDocument({ id: 'doc-1', content: 'Updated content' })]
      const result = await ingestDocs(engine, bucket.id, updatedDocs, ingestOptions)
      expect(result.inserted).toBe(1)
    })

    it('re-indexes on model change', async () => {
      const docs = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })

      const engine1 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v1' }))
      await ingestDocs(engine1, bucket.id, docs, ingestOptions)

      const engine2 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v2' }))
      const result = await ingestDocs(engine2, bucket.id, docs, ingestOptions)
      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
    })

    it('calls ensureModel', async () => {
      const docs = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, docs, ingestOptions)
      expect(adapter.calls.some(c => c.method === 'ensureModel')).toBe(true)
    })

    it('supports dryRun', async () => {
      const docs = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, docs, ingestOptions, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocument')).toHaveLength(0)
    })

    it('strips markdown for embedding when configured', async () => {
      const doc = createTestDocument({ content: '# Heading\n\n**Bold** text' })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [doc],
        stripMarkdownForEmbedding: true,
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).not.toContain('#')
      expect(embeddedTexts[0]).not.toContain('**')
    })

    it('applies custom preprocessForEmbedding', async () => {
      const doc = createTestDocument({ content: 'Hello World' })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [doc],
        preprocessForEmbedding: (c) => c.toLowerCase(),
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).toBe('hello world')
    })

    it('propagates default metadata (title, url, updatedAt)', async () => {
      const doc = createTestDocument({
        title: 'My Doc',
        url: 'https://example.com',
        updatedAt: new Date('2024-06-01'),
      })
      const { bucket, ingestOptions } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.title).toBe('My Doc')
      expect(stored[0]!.metadata.url).toBe('https://example.com')
    })

    it('normalizes url=null to no URL during batch ingest', async () => {
      const doc = createTestDocument({ id: 'doc-null-url', url: null })
      const { bucket, ingestOptions } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      const recordCall = adapter.calls.find(c => c.method === 'upsertDocumentRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('normalizes url=null to no URL during pre-chunked ingest', async () => {
      const doc = createTestDocument({ id: 'doc-null-url-prechunked', url: null })
      const { bucket } = createMockBucket({ documents: [] })
      const engine = new IndexEngine(adapter, embedding)

      const result = await engine.ingestWithChunks(
        bucket.id,
        doc,
        [{ content: 'Chunk content', chunkIndex: 0 }],
      )

      expect(result.inserted).toBe(1)
      const recordCall = adapter.calls.find(c => c.method === 'upsertDocumentRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('propagates custom metadata fields', async () => {
      const doc = createTestDocument({
        metadata: { category: 'tech', priority: 'high' },
      })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [doc],
        propagateMetadata: ['metadata.category', 'metadata.priority'],
      })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.category).toBe('tech')
      expect(stored[0]!.metadata.priority).toBe('high')
    })

    it('creates document records', async () => {
      const doc = createTestDocument()
      const { bucket, ingestOptions } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], ingestOptions)

      expect(adapter.calls.some(c => c.method === 'upsertDocumentRecord')).toBe(true)
    })

    it('uses canonical document id when hash dedup is missing', async () => {
      const doc = createTestDocument({
        id: undefined,
        content: 'Canonical document content about Alice and Bob.',
        title: 'Canonical Batch Document',
        url: 'https://example.com/canonical-batch',
      })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const events: typegraphEvent[] = []
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding, {
        emit: event => { events.push(event) },
      })
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestBatch(bucket.id, [{ doc, chunks }], { graphExtraction: true })
      const canonicalId = adapter._chunks.get(embeddingModelKey(embedding))![0]!.documentId
      const ikey = resolveIdempotencyKey(doc, ['url'])
      await adapter.hashStore.delete(buildHashStoreKey(undefined, bucket.id, ikey))
      adapter.calls.length = 0
      events.length = 0
      extractFromChunk.mockClear()

      const result = await engine.ingestBatch(bucket.id, [{ doc, chunks }], { graphExtraction: true })

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      const upsertCall = adapter.calls.find(c => c.method === 'upsertDocument')!
      expect((upsertCall.args[1] as Array<{ documentId: string }>)[0]!.documentId).toBe(canonicalId)
      expect(extractFromChunk.mock.calls[0]![3]).toBe(canonicalId)
      expect(adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!.args[0]).toBe(canonicalId)
      expect(events.find(e => e.eventType === 'index.document')!.targetId).toBe(canonicalId)
    })

    it('leaves graph extraction failures retryable', async () => {
      const doc = createTestDocument({
        id: undefined,
        content: 'Retryable graph extraction document.',
        title: 'Retryable Graph Document',
        url: 'https://example.com/retryable-graph',
      })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('Graph write failed')),
      } as any

      const failed = await engine.ingestBatch(bucket.id, [{ doc, chunks }], { graphExtraction: true })

      expect(failed.inserted).toBe(0)
      expect(failed.updated).toBe(0)
      expect(failed.extraction?.failed).toBe(1)
      const failedStatus = adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!
      expect(failedStatus.args[1]).toBe('failed')
      const ikey = resolveIdempotencyKey(doc, ['url'])
      const storeKey = buildHashStoreKey(undefined, bucket.id, ikey)
      expect(await adapter.hashStore.get(storeKey)).toBeNull()

      adapter.calls.length = 0
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockResolvedValue({ entities: [] }),
      } as any
      const retried = await engine.ingestBatch(bucket.id, [{ doc, chunks }], { graphExtraction: true })

      expect(retried.skipped).toBe(0)
      expect(retried.inserted).toBe(0)
      expect(retried.updated).toBe(1)
      expect(await adapter.hashStore.get(storeKey)).not.toBeNull()
      expect(adapter.calls.some(c => c.method === 'upsertDocument')).toBe(true)
      expect(adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!.args[1]).toBe('complete')
    })

    it('serializes graph extraction even when concurrency is higher', async () => {
      const docs = [
        createTestDocument({ id: undefined, title: 'Doc A', url: 'https://example.com/a', content: 'Alice met Bob.' }),
        createTestDocument({ id: undefined, title: 'Doc B', url: 'https://example.com/b', content: 'Carol met Dana.' }),
      ]
      const { bucket } = createMockBucket({ documents: [] })
      let active = 0
      let maxActive = 0
      const extractFromChunk = vi.fn(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return { entities: [] }
      })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestBatch(
        bucket.id,
        docs.map(doc => ({ doc, chunks: [{ content: doc.content, chunkIndex: 0 }] })),
        { graphExtraction: true, concurrency: 2 },
      )

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(maxActive).toBe(1)
    })
  })

  describe('ingestWithChunks', () => {
    it('ingests pre-built chunks', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Chunk 0', chunkIndex: 0 },
        { content: 'Chunk 1', chunkIndex: 1 },
      ]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, doc, chunks)
      expect(result.inserted).toBe(1)
      expect(result.total).toBe(1)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored).toHaveLength(2)
    })

    it('supports dryRun', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, doc, chunks, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocument')).toHaveLength(0)
    })

    it('sets status to failed on error', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]

      const failEmbedding = createMockEmbedding()
      failEmbedding.embedBatch = async () => { throw new Error('Embed failed') }

      const engine = new IndexEngine(adapter, failEmbedding)
      await expect(engine.ingestWithChunks(bucket.id, doc, chunks)).rejects.toThrow('Embed failed')

      const statusCalls = adapter.calls.filter(c => c.method === 'updateDocumentStatus')
      if (statusCalls.length > 0) {
        expect(statusCalls[statusCalls.length - 1]!.args[1]).toBe('failed')
      }
    })

    it('reports triple extraction exceptions as errors, not timeouts', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('No output generated.')),
      } as any

      const result = await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true })

      expect(result.extraction?.failed).toBe(1)
      expect(result.extraction?.failedChunks?.[0]).toEqual(expect.objectContaining({
        reason: 'error',
        message: 'No output generated.',
      }))
    })

    it('uses canonical document id for pre-chunked reprocessing', async () => {
      const doc = createTestDocument({
        id: undefined,
        content: 'Canonical pre-chunked content about Alice and Bob.',
        title: 'Canonical Prechunked Document',
        url: 'https://example.com/canonical-prechunked',
      })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true })
      const canonicalId = adapter._chunks.get(embeddingModelKey(embedding))![0]!.documentId
      adapter.calls.length = 0
      extractFromChunk.mockClear()

      const result = await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true })

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      const upsertCall = adapter.calls.find(c => c.method === 'upsertDocument')!
      expect((upsertCall.args[1] as Array<{ documentId: string }>)[0]!.documentId).toBe(canonicalId)
      expect(extractFromChunk.mock.calls[0]![3]).toBe(canonicalId)
      expect(adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!.args[0]).toBe(canonicalId)
    })

    it('extracts graph facts from chunks without graph-owned chunk persistence', async () => {
      const doc = createTestDocument({ id: 'doc-chunks' })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Alice met Bob.', chunkIndex: 0 },
        { content: 'Bob works at Acme.', chunkIndex: 1 },
      ]
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true, tenantId: 'tenant-1' })

      const upsertCallIndex = adapter.calls.findIndex(call => call.method === 'upsertDocument')
      expect(upsertCallIndex).toBeGreaterThanOrEqual(0)
      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[0]).toEqual(expect.arrayContaining([
        'Alice met Bob.',
        bucket.id,
        0,
        'doc-chunks',
      ]))
      expect(extractFromChunk.mock.calls[0]![7]).toEqual(expect.objectContaining({ tenantId: 'tenant-1' }))
    })

    it('passes accumulated entity context to later chunks', async () => {
      const doc = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Cole Conway entered the saloon.', chunkIndex: 0 },
        { content: 'Conway met Steve Sharp there.', chunkIndex: 1 },
      ]
      const extractFromChunk = vi.fn()
        .mockResolvedValueOnce({ entities: [{ name: 'Cole Conway', type: 'person' }] })
        .mockResolvedValueOnce({ entities: [{ name: 'Steve Sharp', type: 'person' }] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, doc, chunks, { graphExtraction: true })

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[1]![5]).toEqual([
        { name: 'Cole Conway', type: 'person' },
      ])
    })
  })
})
