import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IndexEngine } from '../index-engine/engine.js'
import { embeddingModelKey } from '../embedding/provider.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-document.js'
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

  /** Helper: chunk documents and ingest via engine.ingestBatch */
  async function ingestDocs(
    engine: IndexEngine,
    bucketId: string,
    documents: ReturnType<typeof createTestDocuments>,
    ingestOptions: ReturnType<typeof createMockBucket>['ingestOptions'],
    opts?: Parameters<IndexEngine['ingestBatch']>[2],
  ) {
    const chunkOpts = { chunkSize: ingestOptions.chunkSize ?? 100, chunkOverlap: ingestOptions.chunkOverlap ?? 20 }
    const items = await Promise.all(documents.map(async document => ({ document, chunks: await defaultChunker(document, chunkOpts) })))
    return engine.ingestBatch(bucketId, items, { tenantId: 'tenant-1', ...ingestOptions, ...(opts ?? {}) })
  }

  describe('ingestBatch', () => {
    it('indexes all documents', async () => {
      const documents = createTestDocuments(3)
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, documents, ingestOptions)
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
      expect(result.skipped).toBe(0)
    })

    it('requires tenantId when opts are null', async () => {
      const document = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)

      await expect(engine.ingestBatch(bucket.id, [{ document, chunks }], null))
        .rejects.toThrow('ingest requires identity.tenantId.')
    })

    it('skips unchanged documents (idempotency)', async () => {
      const documents = createTestDocuments(2)
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, documents, ingestOptions)
      const result2 = await ingestDocs(engine, bucket.id, documents, ingestOptions)
      expect(result2.total).toBe(2)
      expect(result2.skipped).toBe(2)
      expect(result2.inserted).toBe(0)
    })

    it('skips unchanged group-visible documents', async () => {
      const documents = createTestDocuments(2)
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, documents, ingestOptions, {
        groupId: 'Novel-30752',
      })
      const result2 = await ingestDocs(engine, bucket.id, documents, ingestOptions, {
        groupId: 'Novel-30752',
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
      const documents = [createTestDocument({ id: 'document-1', content: 'Original content' })]
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, documents, ingestOptions)

      const updatedDocs = [createTestDocument({ id: 'document-1', content: 'Updated content' })]
      const result = await ingestDocs(engine, bucket.id, updatedDocs, ingestOptions)
      expect(result.inserted).toBe(1)
      expect(adapter.calls.some(call =>
        call.method === 'deleteDocuments' &&
        call.args[0]?.tenantId === 'tenant-1' &&
        call.args[0]?.bucketId === bucket.id &&
        call.args[0]?.documentIds?.[0] === 'document-1'
      )).toBe(true)
    })

    it('replaces stale chunks when deterministic document content changes', async () => {
      const document = createTestDocument({ id: 'document-1', content: 'Original content' })
      const updated = createTestDocument({ id: 'document-1', content: 'Updated content' })
      const { bucket, ingestOptions } = createMockBucket({ documents: [document] })
      const engine = new IndexEngine(adapter, embedding)
      const opts = { tenantId: 'tenant-1', ...ingestOptions }

      await engine.ingestBatch(bucket.id, [{
        document,
        chunks: [
          { content: 'Original chunk 0', chunkIndex: 0 },
          { content: 'Original chunk 1', chunkIndex: 1 },
          { content: 'Original chunk 2', chunkIndex: 2 },
        ],
      }], opts)

      await engine.ingestBatch(bucket.id, [{
        document: updated,
        chunks: [{ content: 'Updated chunk 0', chunkIndex: 0 }],
      }], opts)

      const chunks = adapter._chunks.get(embeddingModelKey(embedding)) ?? []
      expect(chunks.filter(chunk => chunk.documentId === 'document-1')).toHaveLength(1)
      expect(chunks.find(chunk => chunk.documentId === 'document-1')?.content).toBe('Updated chunk 0')
    })

    it('re-indexes on model change', async () => {
      const documents = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })

      const engine1 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v1' }))
      await ingestDocs(engine1, bucket.id, documents, ingestOptions)

      const engine2 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v2' }))
      const result = await ingestDocs(engine2, bucket.id, documents, ingestOptions)
      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
    })

    it('calls ensureModel', async () => {
      const documents = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, documents, ingestOptions)
      expect(adapter.calls.some(c => c.method === 'ensureModel')).toBe(true)
    })

    it('supports dryRun', async () => {
      const documents = [createTestDocument()]
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, documents, ingestOptions, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocumentChunks')).toHaveLength(0)
    })

    it('strips markdown for embedding when configured', async () => {
      const document = createTestDocument({ content: '# Heading\n\n**Bold** text' })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [document],
        stripMarkdownForEmbedding: true,
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embed')
      await ingestDocs(engine, bucket.id, [document], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0].texts
      expect(embeddedTexts[0]).not.toContain('#')
      expect(embeddedTexts[0]).not.toContain('**')
    })

    it('applies custom preprocessForEmbedding', async () => {
      const document = createTestDocument({ content: 'Hello World' })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [document],
        preprocessForEmbedding: (c) => c.toLowerCase(),
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embed')
      await ingestDocs(engine, bucket.id, [document], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0].texts
      expect(embeddedTexts[0]).toBe('hello world')
    })

    it('propagates default metadata (title, url, updatedAt)', async () => {
      const document = createTestDocument({
        name: 'My Documents',
        url: 'https://example.com',
        updatedAt: new Date('2024-06-01'),
      })
      const { bucket, ingestOptions } = createMockBucket({ documents: [document] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [document], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.name).toBe('My Documents')
      expect(stored[0]!.metadata.url).toBe('https://example.com')
    })

    it('normalizes url=null to no URL during batch ingest', async () => {
      const document = createTestDocument({ id: 'document-null-url', url: null })
      const { bucket, ingestOptions } = createMockBucket({ documents: [document] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [document], ingestOptions)

      const recordCall = adapter.calls.find(c => c.method === 'upsertDocumentRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('normalizes url=null to no URL during pre-chunked ingest', async () => {
      const document = createTestDocument({ id: 'document-null-url-prechunked', url: null })
      const { bucket } = createMockBucket({ documents: [] })
      const engine = new IndexEngine(adapter, embedding)

      const result = await engine.ingestWithChunks(
        bucket.id,
        document,
        [{ content: 'Chunk content', chunkIndex: 0 }],
        { tenantId: 'tenant-1' },
      )

      expect(result.inserted).toBe(1)
      const recordCall = adapter.calls.find(c => c.method === 'upsertDocumentRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('propagates custom metadata fields', async () => {
      const document = createTestDocument({
        metadata: { category: 'tech', priority: 'high' },
      })
      const { bucket, ingestOptions } = createMockBucket({
        documents: [document],
        propagateMetadata: ['metadata.category', 'metadata.priority'],
      })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [document], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.category).toBe('tech')
      expect(stored[0]!.metadata.priority).toBe('high')
    })

    it('creates document records', async () => {
      const document = createTestDocument()
      const { bucket, ingestOptions } = createMockBucket({ documents: [document] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [document], ingestOptions)

      expect(adapter.calls.some(c => c.method === 'upsertDocumentRecord')).toBe(true)
    })

    it('uses canonical document id when hash dedup is missing', async () => {
      const document = createTestDocument({
        id: undefined,
        content: 'Canonical document content about Alice and Bob.',
        name: 'Canonical Batch Documents',
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

      await engine.ingestBatch(bucket.id, [{ document, chunks }], { tenantId: 'tenant-1', graphExtraction: true })
      const canonicalId = adapter._chunks.get(embeddingModelKey(embedding))![0]!.documentId
      const ikey = resolveIdempotencyKey(document, ['url'])
      await adapter.hashStore.delete(buildHashStoreKey('tenant-1', bucket.id, ikey))
      adapter.calls.length = 0
      events.length = 0
      extractFromChunk.mockClear()

      const result = await engine.ingestBatch(bucket.id, [{ document, chunks }], { tenantId: 'tenant-1', graphExtraction: true })

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      const upsertCall = adapter.calls.find(c => c.method === 'upsertDocumentChunks')!
      expect((upsertCall.args[1] as Array<{ documentId: string }>)[0]!.documentId).toBe(canonicalId)
      expect(extractFromChunk.mock.calls[0]![3]).toBe(canonicalId)
      expect(adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!.args[1]).toBe(canonicalId)
      expect(events.find(e => e.eventType === 'index.document')!.targetId).toBe(canonicalId)
    })

    it('leaves graph extraction failures retryable', async () => {
      const document = createTestDocument({
        id: undefined,
        content: 'Retryable graph extraction document.',
        name: 'Retryable Graph Documents',
        url: 'https://example.com/retryable-graph',
      })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('Graph write failed')),
      } as any

      const failed = await engine.ingestBatch(bucket.id, [{ document, chunks }], { tenantId: 'tenant-1', graphExtraction: true })

      expect(failed.inserted).toBe(0)
      expect(failed.updated).toBe(0)
      expect(failed.extraction?.failed).toBe(1)
      const failedStatus = adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!
      expect(failedStatus.args[2]).toBe('failed')
      const ikey = resolveIdempotencyKey(document, ['url'])
      const storeKey = buildHashStoreKey('tenant-1', bucket.id, ikey)
      expect(await adapter.hashStore.get(storeKey)).toBeNull()

      adapter.calls.length = 0
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockResolvedValue({ entities: [] }),
      } as any
      const retried = await engine.ingestBatch(bucket.id, [{ document, chunks }], { tenantId: 'tenant-1', graphExtraction: true })

      expect(retried.skipped).toBe(0)
      expect(retried.inserted).toBe(0)
      expect(retried.updated).toBe(1)
      expect(await adapter.hashStore.get(storeKey)).not.toBeNull()
      expect(adapter.calls.some(c => c.method === 'upsertDocumentChunks')).toBe(true)
      expect(adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!.args[2]).toBe('complete')
    })

    it('serializes graph extraction even when concurrency is higher', async () => {
      const documents = [
        createTestDocument({ id: undefined, name: 'Documents A', url: 'https://example.com/a', content: 'Alice met Bob.' }),
        createTestDocument({ id: undefined, name: 'Documents B', url: 'https://example.com/b', content: 'Carol met Dana.' }),
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
        documents.map(document => ({ document, chunks: [{ content: document.content, chunkIndex: 0 }] })),
        { tenantId: 'tenant-1', graphExtraction: true, concurrency: 2 },
      )

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(maxActive).toBe(1)
    })

    it('passes the resolved graph identity to graph extraction', async () => {
      const document = createTestDocument({
        id: 'document-source-graph',
        content: 'Alice works at Acme.',
        name: 'Source Graph Document',
      })
      const { bucket } = createMockBucket({ documents: [] })
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestBatch(
        bucket.id,
        [{ document, chunks: [{ content: document.content, chunkIndex: 0 }] }],
        {
          tenantId: 'tenant-1',
          organizationId: 'org-1',
          groupId: 'Novel-30752',
          graphId: 'internal-source-graph',
          graphExtraction: true,
        },
      )

      expect(extractFromChunk).toHaveBeenCalledTimes(1)
      expect(extractFromChunk.mock.calls[0]![7]).toEqual(expect.objectContaining({
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        groupId: 'Novel-30752',
        graphId: 'internal-source-graph',
      }))
    })
  })

  describe('ingestWithChunks', () => {
    it('ingests pre-built chunks', async () => {
      const document = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Chunk 0', chunkIndex: 0 },
        { content: 'Chunk 1', chunkIndex: 1 },
      ]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1' })
      expect(result.inserted).toBe(1)
      expect(result.total).toBe(1)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored).toHaveLength(2)
    })

    it('requires tenantId when opts are null', async () => {
      const document = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)

      await expect(engine.ingestWithChunks(bucket.id, document, chunks, null))
        .rejects.toThrow('ingest requires identity.tenantId.')
    })

    it('supports dryRun', async () => {
      const document = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1', dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocumentChunks')).toHaveLength(0)
    })

    it('sets status to failed on error', async () => {
      const document = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]

      const failEmbedding = createMockEmbedding()
      failEmbedding.embed = async () => { throw new Error('Embed failed') }

      const engine = new IndexEngine(adapter, failEmbedding)
      await expect(engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1' })).rejects.toThrow('Embed failed')

      const statusCalls = adapter.calls.filter(c => c.method === 'updateDocumentStatus')
      if (statusCalls.length > 0) {
        expect(statusCalls[statusCalls.length - 1]!.args[2]).toBe('failed')
      }
    })

    it('reports triple extraction exceptions as errors, not timeouts', async () => {
      const document = createTestDocument()
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('No output generated.')),
      } as any

      const result = await engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1', graphExtraction: true })

      expect(result.extraction?.failed).toBe(1)
      expect(result.extraction?.failedChunks?.[0]).toEqual(expect.objectContaining({
        reason: 'error',
        message: 'No output generated.',
      }))
    })

    it('uses canonical document id for pre-chunked reprocessing', async () => {
      const document = createTestDocument({
        id: undefined,
        content: 'Canonical pre-chunked content about Alice and Bob.',
        name: 'Canonical Prechunked Documents',
        url: 'https://example.com/canonical-prechunked',
      })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1', graphExtraction: true })
      const canonicalId = adapter._chunks.get(embeddingModelKey(embedding))![0]!.documentId
      adapter.calls.length = 0
      extractFromChunk.mockClear()

      const result = await engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1', graphExtraction: true })

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      const upsertCall = adapter.calls.find(c => c.method === 'upsertDocumentChunks')!
      expect((upsertCall.args[1] as Array<{ documentId: string }>)[0]!.documentId).toBe(canonicalId)
      expect(extractFromChunk.mock.calls[0]![3]).toBe(canonicalId)
      expect(adapter.calls.filter(c => c.method === 'updateDocumentStatus').at(-1)!.args[1]).toBe(canonicalId)
    })

    it('extracts graph facts from chunks without graph-owned chunk persistence', async () => {
      const document = createTestDocument({ id: 'document-chunks' })
      const { bucket } = createMockBucket({ documents: [] })
      const chunks = [
        { content: 'Alice met Bob.', chunkIndex: 0 },
        { content: 'Bob works at Acme.', chunkIndex: 1 },
      ]
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, document, chunks, { graphExtraction: true, tenantId: 'tenant-1' })

      const upsertCallIndex = adapter.calls.findIndex(call => call.method === 'upsertDocumentChunks')
      expect(upsertCallIndex).toBeGreaterThanOrEqual(0)
      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[0]).toEqual(expect.arrayContaining([
        'Alice met Bob.',
        bucket.id,
        0,
        'document-chunks',
      ]))
      expect(extractFromChunk.mock.calls[0]![7]).toEqual(expect.objectContaining({ tenantId: 'tenant-1' }))
    })

    it('passes accumulated entity context to later chunks', async () => {
      const document = createTestDocument()
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

      await engine.ingestWithChunks(bucket.id, document, chunks, { tenantId: 'tenant-1', graphExtraction: true })

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[1]![5]).toEqual([
        { name: 'Cole Conway', type: 'person' },
      ])
    })
  })
})
