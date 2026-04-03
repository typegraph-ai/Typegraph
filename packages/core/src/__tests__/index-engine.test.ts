import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IndexEngine } from '../index-engine/engine.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import { defaultChunker } from '../index-engine/chunker.js'

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
    indexConfig: ReturnType<typeof createMockBucket>['indexConfig'],
    opts?: Parameters<IndexEngine['ingestBatch']>[2],
  ) {
    const items = docs.map(doc => ({ doc, chunks: defaultChunker(doc, indexConfig) }))
    return engine.ingestBatch(bucketId, items, opts, indexConfig)
  }

  describe('ingestBatch', () => {
    it('indexes all documents', async () => {
      const docs = createTestDocuments(3)
      const { bucket, indexConfig } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, docs, indexConfig)
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
      expect(result.skipped).toBe(0)
    })

    it('skips unchanged documents (idempotency)', async () => {
      const docs = createTestDocuments(2)
      const { bucket, indexConfig } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, indexConfig)
      const result2 = await ingestDocs(engine, bucket.id, docs, indexConfig)
      expect(result2.total).toBe(2)
      expect(result2.skipped).toBe(2)
      expect(result2.inserted).toBe(0)
    })

    it('re-indexes on content change', async () => {
      const docs = [createTestDocument({ id: 'doc-1', content: 'Original content' })]
      const { bucket, indexConfig } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, docs, indexConfig)

      const updatedDocs = [createTestDocument({ id: 'doc-1', content: 'Updated content' })]
      const result = await ingestDocs(engine, bucket.id, updatedDocs, indexConfig)
      expect(result.inserted).toBe(1)
    })

    it('re-indexes on model change', async () => {
      const docs = [createTestDocument()]
      const { bucket, indexConfig } = createMockBucket({ documents: docs })

      const engine1 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v1' }))
      await ingestDocs(engine1, bucket.id, docs, indexConfig)

      const engine2 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v2' }))
      const result = await ingestDocs(engine2, bucket.id, docs, indexConfig)
      expect(result.inserted).toBe(1)
    })

    it('calls ensureModel', async () => {
      const docs = [createTestDocument()]
      const { bucket, indexConfig } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, docs, indexConfig)
      expect(adapter.calls.some(c => c.method === 'ensureModel')).toBe(true)
    })

    it('supports dryRun', async () => {
      const docs = [createTestDocument()]
      const { bucket, indexConfig } = createMockBucket({ documents: docs })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, docs, indexConfig, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertDocument')).toHaveLength(0)
    })

    it('strips markdown for embedding when configured', async () => {
      const doc = createTestDocument({ content: '# Heading\n\n**Bold** text' })
      const { bucket, indexConfig } = createMockBucket({
        documents: [doc],
        stripMarkdownForEmbedding: true,
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [doc], indexConfig)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).not.toContain('#')
      expect(embeddedTexts[0]).not.toContain('**')
    })

    it('applies custom preprocessForEmbedding', async () => {
      const doc = createTestDocument({ content: 'Hello World' })
      const { bucket, indexConfig } = createMockBucket({
        documents: [doc],
        preprocessForEmbedding: (c) => c.toLowerCase(),
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [doc], indexConfig)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).toBe('hello world')
    })

    it('propagates default metadata (title, url, updatedAt)', async () => {
      const doc = createTestDocument({
        title: 'My Doc',
        url: 'https://example.com',
        updatedAt: new Date('2024-06-01'),
      })
      const { bucket, indexConfig } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], indexConfig)

      const stored = adapter._chunks.get(embedding.model)!
      expect(stored[0]!.metadata.title).toBe('My Doc')
      expect(stored[0]!.metadata.url).toBe('https://example.com')
    })

    it('propagates custom metadata fields', async () => {
      const doc = createTestDocument({
        metadata: { category: 'tech', priority: 'high' },
      })
      const { bucket, indexConfig } = createMockBucket({
        documents: [doc],
        propagateMetadata: ['metadata.category', 'metadata.priority'],
      })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], indexConfig)

      const stored = adapter._chunks.get(embedding.model)!
      expect(stored[0]!.metadata.category).toBe('tech')
      expect(stored[0]!.metadata.priority).toBe('high')
    })

    it('creates document records', async () => {
      const doc = createTestDocument()
      const { bucket, indexConfig } = createMockBucket({ documents: [doc] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [doc], indexConfig)

      expect(adapter.calls.some(c => c.method === 'upsertDocumentRecord')).toBe(true)
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

      const stored = adapter._chunks.get(embedding.model)!
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
  })
})
