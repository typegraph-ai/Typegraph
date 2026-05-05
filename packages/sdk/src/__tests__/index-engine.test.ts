import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IndexEngine } from '../index-engine/engine.js'
import { embeddingModelKey } from '../embedding/provider.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestSource, createTestSources } from './helpers/mock-connector.js'
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

  /** Helper: chunk sources and ingest via engine.ingestBatch */
  async function ingestDocs(
    engine: IndexEngine,
    bucketId: string,
    sources: ReturnType<typeof createTestSources>,
    ingestOptions: ReturnType<typeof createMockBucket>['ingestOptions'],
    opts?: Parameters<IndexEngine['ingestBatch']>[2],
  ) {
    const chunkOpts = { chunkSize: ingestOptions.chunkSize ?? 100, chunkOverlap: ingestOptions.chunkOverlap ?? 20 }
    const items = await Promise.all(sources.map(async source => ({ source, chunks: await defaultChunker(source, chunkOpts) })))
    return engine.ingestBatch(bucketId, items, { ...ingestOptions, ...opts })
  }

  describe('ingestBatch', () => {
    it('indexes all sources', async () => {
      const sources = createTestSources(3)
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, sources, ingestOptions)
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
      expect(result.skipped).toBe(0)
    })

    it('skips unchanged sources (idempotency)', async () => {
      const sources = createTestSources(2)
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, sources, ingestOptions)
      const result2 = await ingestDocs(engine, bucket.id, sources, ingestOptions)
      expect(result2.total).toBe(2)
      expect(result2.skipped).toBe(2)
      expect(result2.inserted).toBe(0)
    })

    it('skips unchanged group-visible sources', async () => {
      const sources = createTestSources(2)
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, sources, ingestOptions, {
        groupId: 'Novel-30752',
        visibility: 'group',
      })
      const result2 = await ingestDocs(engine, bucket.id, sources, ingestOptions, {
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
        idempotencyKey: 'source-2',
      }))
    })

    it('re-indexes on content change', async () => {
      const sources = [createTestSource({ id: 'source-1', content: 'Original content' })]
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })
      const engine = new IndexEngine(adapter, embedding)

      await ingestDocs(engine, bucket.id, sources, ingestOptions)

      const updatedDocs = [createTestSource({ id: 'source-1', content: 'Updated content' })]
      const result = await ingestDocs(engine, bucket.id, updatedDocs, ingestOptions)
      expect(result.inserted).toBe(1)
    })

    it('re-indexes on model change', async () => {
      const sources = [createTestSource()]
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })

      const engine1 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v1' }))
      await ingestDocs(engine1, bucket.id, sources, ingestOptions)

      const engine2 = new IndexEngine(adapter, createMockEmbedding({ model: 'model-v2' }))
      const result = await ingestDocs(engine2, bucket.id, sources, ingestOptions)
      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
    })

    it('calls ensureModel', async () => {
      const sources = [createTestSource()]
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, sources, ingestOptions)
      expect(adapter.calls.some(c => c.method === 'ensureModel')).toBe(true)
    })

    it('supports dryRun', async () => {
      const sources = [createTestSource()]
      const { bucket, ingestOptions } = createMockBucket({ sources: sources })
      const engine = new IndexEngine(adapter, embedding)
      const result = await ingestDocs(engine, bucket.id, sources, ingestOptions, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertSourceChunks')).toHaveLength(0)
    })

    it('strips markdown for embedding when configured', async () => {
      const source = createTestSource({ content: '# Heading\n\n**Bold** text' })
      const { bucket, ingestOptions } = createMockBucket({
        sources: [source],
        stripMarkdownForEmbedding: true,
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [source], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).not.toContain('#')
      expect(embeddedTexts[0]).not.toContain('**')
    })

    it('applies custom preprocessForEmbedding', async () => {
      const source = createTestSource({ content: 'Hello World' })
      const { bucket, ingestOptions } = createMockBucket({
        sources: [source],
        preprocessForEmbedding: (c) => c.toLowerCase(),
      })
      const engine = new IndexEngine(adapter, embedding)
      const embedSpy = vi.spyOn(embedding, 'embedBatch')
      await ingestDocs(engine, bucket.id, [source], ingestOptions)
      const embeddedTexts = embedSpy.mock.calls[0]![0]
      expect(embeddedTexts[0]).toBe('hello world')
    })

    it('propagates default metadata (title, url, updatedAt)', async () => {
      const source = createTestSource({
        title: 'My Source',
        url: 'https://example.com',
        updatedAt: new Date('2024-06-01'),
      })
      const { bucket, ingestOptions } = createMockBucket({ sources: [source] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [source], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.title).toBe('My Source')
      expect(stored[0]!.metadata.url).toBe('https://example.com')
    })

    it('materializes source subjects without requiring triple extraction', async () => {
      const subject = {
        name: 'Acme demo',
        entityType: 'meeting',
        externalIds: [{ type: 'meeting_id', id: 'mtng_123' }],
      }
      const source = createTestSource({
        id: 'source-subject',
        title: 'Acme demo transcript',
        content: 'Transcript body that does not repeat the meeting title.',
        subject,
      })
      const { bucket } = createMockBucket({ sources: [] })
      const addSourceSubject = vi.fn().mockResolvedValue({
        id: 'ent_meeting',
        name: 'Acme demo',
        entityType: 'meeting',
        aliases: [],
        edgeCount: 0,
        properties: {},
        createdAt: new Date('2024-01-01'),
        topEdges: [],
      })
      const engine = new IndexEngine(
        adapter,
        embedding,
        undefined,
        undefined,
        { addSourceSubject } as any,
      )

      await engine.ingestWithChunks(
        bucket.id,
        source,
        [
          { content: 'Opening discussion.', chunkIndex: 0 },
          { content: 'Next steps.', chunkIndex: 1 },
        ],
      )

      expect(addSourceSubject).toHaveBeenCalledTimes(1)
      expect(addSourceSubject).toHaveBeenCalledWith(expect.objectContaining({
        subject,
        bucketId: bucket.id,
        sourceId: 'source-subject',
        embeddingModel: embeddingModelKey(embedding),
        chunks: expect.arrayContaining([
          expect.objectContaining({ chunkIndex: 0, id: expect.any(String) }),
          expect.objectContaining({ chunkIndex: 1, id: expect.any(String) }),
        ]),
      }))
      const recordCall = adapter.calls.find(c => c.method === 'upsertSourceRecord')!
      expect(recordCall.args[0]).toEqual(expect.objectContaining({ subject }))
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored).toHaveLength(2)
      expect(stored.every(chunk => chunk.metadata.subject === subject)).toBe(true)
    })

    it('normalizes url=null to no URL during batch ingest', async () => {
      const source = createTestSource({ id: 'source-null-url', url: null })
      const { bucket, ingestOptions } = createMockBucket({ sources: [source] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [source], ingestOptions)

      const recordCall = adapter.calls.find(c => c.method === 'upsertSourceRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('normalizes url=null to no URL during pre-chunked ingest', async () => {
      const source = createTestSource({ id: 'source-null-url-prechunked', url: null })
      const { bucket } = createMockBucket({ sources: [] })
      const engine = new IndexEngine(adapter, embedding)

      const result = await engine.ingestWithChunks(
        bucket.id,
        source,
        [{ content: 'Chunk content', chunkIndex: 0 }],
      )

      expect(result.inserted).toBe(1)
      const recordCall = adapter.calls.find(c => c.method === 'upsertSourceRecord')!
      expect(recordCall.args[0].url).toBeUndefined()
      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.url).toBeUndefined()
    })

    it('propagates custom metadata fields', async () => {
      const source = createTestSource({
        metadata: { category: 'tech', priority: 'high' },
      })
      const { bucket, ingestOptions } = createMockBucket({
        sources: [source],
        propagateMetadata: ['metadata.category', 'metadata.priority'],
      })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [source], ingestOptions)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored[0]!.metadata.category).toBe('tech')
      expect(stored[0]!.metadata.priority).toBe('high')
    })

    it('creates source records', async () => {
      const source = createTestSource()
      const { bucket, ingestOptions } = createMockBucket({ sources: [source] })
      const engine = new IndexEngine(adapter, embedding)
      await ingestDocs(engine, bucket.id, [source], ingestOptions)

      expect(adapter.calls.some(c => c.method === 'upsertSourceRecord')).toBe(true)
    })

    it('uses canonical source id when hash dedup is missing', async () => {
      const source = createTestSource({
        id: undefined,
        content: 'Canonical source content about Alice and Bob.',
        title: 'Canonical Batch Source',
        url: 'https://example.com/canonical-batch',
      })
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const events: typegraphEvent[] = []
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding, {
        emit: event => { events.push(event) },
      })
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestBatch(bucket.id, [{ source, chunks }], { graphExtraction: true })
      const canonicalId = adapter._chunks.get(embeddingModelKey(embedding))![0]!.sourceId
      const ikey = resolveIdempotencyKey(source, ['url'])
      await adapter.hashStore.delete(buildHashStoreKey(undefined, bucket.id, ikey))
      adapter.calls.length = 0
      events.length = 0
      extractFromChunk.mockClear()

      const result = await engine.ingestBatch(bucket.id, [{ source, chunks }], { graphExtraction: true })

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      const upsertCall = adapter.calls.find(c => c.method === 'upsertSourceChunks')!
      expect((upsertCall.args[1] as Array<{ sourceId: string }>)[0]!.sourceId).toBe(canonicalId)
      expect(extractFromChunk.mock.calls[0]![3]).toBe(canonicalId)
      expect(adapter.calls.filter(c => c.method === 'updateSourceStatus').at(-1)!.args[0]).toBe(canonicalId)
      expect(events.find(e => e.eventType === 'index.source')!.targetId).toBe(canonicalId)
    })

    it('leaves graph extraction failures retryable', async () => {
      const source = createTestSource({
        id: undefined,
        content: 'Retryable graph extraction source.',
        title: 'Retryable Graph Source',
        url: 'https://example.com/retryable-graph',
      })
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('Graph write failed')),
      } as any

      const failed = await engine.ingestBatch(bucket.id, [{ source, chunks }], { graphExtraction: true })

      expect(failed.inserted).toBe(0)
      expect(failed.updated).toBe(0)
      expect(failed.extraction?.failed).toBe(1)
      const failedStatus = adapter.calls.filter(c => c.method === 'updateSourceStatus').at(-1)!
      expect(failedStatus.args[1]).toBe('failed')
      const ikey = resolveIdempotencyKey(source, ['url'])
      const storeKey = buildHashStoreKey(undefined, bucket.id, ikey)
      expect(await adapter.hashStore.get(storeKey)).toBeNull()

      adapter.calls.length = 0
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockResolvedValue({ entities: [] }),
      } as any
      const retried = await engine.ingestBatch(bucket.id, [{ source, chunks }], { graphExtraction: true })

      expect(retried.skipped).toBe(0)
      expect(retried.inserted).toBe(0)
      expect(retried.updated).toBe(1)
      expect(await adapter.hashStore.get(storeKey)).not.toBeNull()
      expect(adapter.calls.some(c => c.method === 'upsertSourceChunks')).toBe(true)
      expect(adapter.calls.filter(c => c.method === 'updateSourceStatus').at(-1)!.args[1]).toBe('complete')
    })

    it('serializes graph extraction even when concurrency is higher', async () => {
      const sources = [
        createTestSource({ id: undefined, title: 'Source A', url: 'https://example.com/a', content: 'Alice met Bob.' }),
        createTestSource({ id: undefined, title: 'Source B', url: 'https://example.com/b', content: 'Carol met Dana.' }),
      ]
      const { bucket } = createMockBucket({ sources: [] })
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
        sources.map(source => ({ source, chunks: [{ content: source.content, chunkIndex: 0 }] })),
        { graphExtraction: true, concurrency: 2 },
      )

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(maxActive).toBe(1)
    })
  })

  describe('ingestWithChunks', () => {
    it('ingests pre-built chunks', async () => {
      const source = createTestSource()
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [
        { content: 'Chunk 0', chunkIndex: 0 },
        { content: 'Chunk 1', chunkIndex: 1 },
      ]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, source, chunks)
      expect(result.inserted).toBe(1)
      expect(result.total).toBe(1)

      const stored = adapter._chunks.get(embeddingModelKey(embedding))!
      expect(stored).toHaveLength(2)
    })

    it('supports dryRun', async () => {
      const source = createTestSource()
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      const result = await engine.ingestWithChunks(bucket.id, source, chunks, { dryRun: true })
      expect(result.inserted).toBe(1)
      expect(adapter.calls.filter(c => c.method === 'upsertSourceChunks')).toHaveLength(0)
    })

    it('sets status to failed on error', async () => {
      const source = createTestSource()
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [{ content: 'Chunk 0', chunkIndex: 0 }]

      const failEmbedding = createMockEmbedding()
      failEmbedding.embedBatch = async () => { throw new Error('Embed failed') }

      const engine = new IndexEngine(adapter, failEmbedding)
      await expect(engine.ingestWithChunks(bucket.id, source, chunks)).rejects.toThrow('Embed failed')

      const statusCalls = adapter.calls.filter(c => c.method === 'updateSourceStatus')
      if (statusCalls.length > 0) {
        expect(statusCalls[statusCalls.length - 1]!.args[1]).toBe('failed')
      }
    })

    it('reports triple extraction exceptions as errors, not timeouts', async () => {
      const source = createTestSource()
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = {
        extractFromChunk: vi.fn().mockRejectedValue(new Error('No output generated.')),
      } as any

      const result = await engine.ingestWithChunks(bucket.id, source, chunks, { graphExtraction: true })

      expect(result.extraction?.failed).toBe(1)
      expect(result.extraction?.failedChunks?.[0]).toEqual(expect.objectContaining({
        reason: 'error',
        message: 'No output generated.',
      }))
    })

    it('uses canonical source id for pre-chunked reprocessing', async () => {
      const source = createTestSource({
        id: undefined,
        content: 'Canonical pre-chunked content about Alice and Bob.',
        title: 'Canonical Prechunked Source',
        url: 'https://example.com/canonical-prechunked',
      })
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [{ content: 'Alice met Bob.', chunkIndex: 0 }]
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, source, chunks, { graphExtraction: true })
      const canonicalId = adapter._chunks.get(embeddingModelKey(embedding))![0]!.sourceId
      adapter.calls.length = 0
      extractFromChunk.mockClear()

      const result = await engine.ingestWithChunks(bucket.id, source, chunks, { graphExtraction: true })

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      const upsertCall = adapter.calls.find(c => c.method === 'upsertSourceChunks')!
      expect((upsertCall.args[1] as Array<{ sourceId: string }>)[0]!.sourceId).toBe(canonicalId)
      expect(extractFromChunk.mock.calls[0]![3]).toBe(canonicalId)
      expect(adapter.calls.filter(c => c.method === 'updateSourceStatus').at(-1)!.args[0]).toBe(canonicalId)
    })

    it('extracts graph facts from chunks without graph-owned chunk persistence', async () => {
      const source = createTestSource({ id: 'source-chunks' })
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [
        { content: 'Alice met Bob.', chunkIndex: 0 },
        { content: 'Bob works at Acme.', chunkIndex: 1 },
      ]
      const extractFromChunk = vi.fn().mockResolvedValue({ entities: [] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, source, chunks, { graphExtraction: true, tenantId: 'tenant-1' })

      const upsertCallIndex = adapter.calls.findIndex(call => call.method === 'upsertSourceChunks')
      expect(upsertCallIndex).toBeGreaterThanOrEqual(0)
      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[0]).toEqual(expect.arrayContaining([
        'Alice met Bob.',
        bucket.id,
        0,
        'source-chunks',
      ]))
      expect(extractFromChunk.mock.calls[0]![7]).toEqual(expect.objectContaining({ tenantId: 'tenant-1' }))
    })

    it('passes accumulated entity context to later chunks', async () => {
      const source = createTestSource()
      const { bucket } = createMockBucket({ sources: [] })
      const chunks = [
        { content: 'Cole Conway entered the saloon.', chunkIndex: 0 },
        { content: 'Conway met Steve Sharp there.', chunkIndex: 1 },
      ]
      const extractFromChunk = vi.fn()
        .mockResolvedValueOnce({ entities: [{ name: 'Cole Conway', type: 'person' }] })
        .mockResolvedValueOnce({ entities: [{ name: 'Steve Sharp', type: 'person' }] })
      const engine = new IndexEngine(adapter, embedding)
      engine.tripleExtractor = { extractFromChunk } as any

      await engine.ingestWithChunks(bucket.id, source, chunks, { graphExtraction: true })

      expect(extractFromChunk).toHaveBeenCalledTimes(2)
      expect(extractFromChunk.mock.calls[1]![5]).toEqual([
        { name: 'Cole Conway', type: 'person' },
      ])
    })
  })
})
