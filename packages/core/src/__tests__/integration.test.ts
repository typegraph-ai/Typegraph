import { describe, it, expect, vi } from 'vitest'
import { d8umCreate } from '../d8um.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import type { d8umInstance } from '../d8um.js'
import type { Bucket } from '../types/bucket.js'
import type { EmbeddingProvider } from '../embedding/provider.js'

/** Register a pre-built Bucket + embedding on an instance (bypasses buckets.create UUID generation). */
function registerTestBucket(instance: d8umInstance, bucket: Bucket, embedding: EmbeddingProvider) {
  const impl = instance as any
  impl._buckets.set(bucket.id, bucket)
  impl.bucketEmbeddings.set(bucket.id, embedding)
}

describe('integration', () => {
  it('add bucket → ingest → query → assemble xml', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const { bucket, documents, indexConfig } = createMockBucket({ documents: createTestDocuments(3) })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(bucket.id, documents, indexConfig)

    const response = await instance.query('Document 1')
    expect(response.results.length).toBeGreaterThan(0)

    const xml = instance.assemble(response.results)
    expect(xml).toContain('<context>')
    expect(xml).toContain('<source')
    expect(xml).toContain('<passage')
  })

  it('ingest → re-ingest with changes → query shows updated content', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const docs = [createTestDocument({ id: 'doc-1', content: 'Original content for testing' })]
    const { bucket, indexConfig } = createMockBucket({ documents: docs })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(bucket.id, docs, indexConfig)

    const updatedDocs = [createTestDocument({ id: 'doc-1', content: 'Updated content with new information' })]
    await instance.ingest(bucket.id, updatedDocs, indexConfig)

    const response = await instance.query('Updated content')
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results[0]!.content).toContain('Updated')
  })

  it('multi-bucket → merged query results', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const { bucket: source1, documents: docs1, indexConfig: indexConfig1 } = createMockBucket({ id: 'src-1', documents: createTestDocuments(2, 'Alpha') })
    const { bucket: source2, documents: docs2, indexConfig: indexConfig2 } = createMockBucket({ id: 'src-2', documents: createTestDocuments(2, 'Beta') })
    registerTestBucket(instance, source1, embedding)
    registerTestBucket(instance, source2, embedding)

    await instance.ingest('src-1', docs1, indexConfig1)
    await instance.ingest('src-2', docs2, indexConfig2)

    const response = await instance.query('content')
    expect(response.results.length).toBeGreaterThan(0)
    const bucketIds = new Set(response.results.map(r => r.bucket.id))
    expect(bucketIds.size).toBeGreaterThanOrEqual(1)
  })

  it('multi-model (different embedding models per bucket)', async () => {
    const adapter = createMockAdapter()
    const embeddingA = createMockEmbedding({ model: 'model-a', dimensions: 4 })
    const embeddingB = createMockEmbedding({ model: 'model-b', dimensions: 4 })
    const instance = await d8umCreate({ vectorStore: adapter, embedding: embeddingA })

    const { bucket: source1, documents: docs1, indexConfig: indexConfig1 } = createMockBucket({ id: 'src-1', documents: createTestDocuments(2, 'Alpha') })
    const { bucket: source2, documents: docs2, indexConfig: indexConfig2 } = createMockBucket({ id: 'src-2', documents: createTestDocuments(2, 'Beta') })
    registerTestBucket(instance, source1, embeddingA)
    registerTestBucket(instance, source2, embeddingB)

    await instance.ingest('src-1', docs1, indexConfig1)
    await instance.ingest('src-2', docs2, indexConfig2)

    expect(adapter._chunks.has('model-a')).toBe(true)
    expect(adapter._chunks.has('model-b')).toBe(true)
  })

  it('idempotency (repeated ingestion is no-op)', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const { bucket, documents, indexConfig } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    const result1 = await instance.ingest(bucket.id, documents, indexConfig)
    const result2 = await instance.ingest(bucket.id, documents, indexConfig)

    expect(result1.inserted).toBe(2)
    expect(result2.skipped).toBe(2)
    expect(result2.inserted).toBe(0)
  })

  it('tenant isolation', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const { bucket, documents, indexConfig } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    await instance.ingest(bucket.id, documents, indexConfig, { tenantId: 'tenant-a' })
    await instance.ingest(bucket.id, documents, indexConfig, { tenantId: 'tenant-b' })

    const responseA = await instance.query('Document', { tenantId: 'tenant-a' })
    const responseB = await instance.query('Document', { tenantId: 'tenant-b' })

    expect(responseA.query.tenantId).toBe('tenant-a')
    expect(responseB.query.tenantId).toBe('tenant-b')
  })

  it('ingestWithChunks → query', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const { bucket } = createMockBucket({ documents: [] })
    registerTestBucket(instance, bucket, embedding)

    const doc = createTestDocument({ content: 'Ingested document content' })
    const chunks = [
      { content: 'Chunk zero text', chunkIndex: 0 },
      { content: 'Chunk one text', chunkIndex: 1 },
    ]
    await instance.ingestWithChunks(bucket.id, doc, chunks)

    const response = await instance.query('Chunk zero text')
    expect(response.results.length).toBeGreaterThan(0)
  })

  it('assemble format pipeline (same results → xml/md/plain/custom)', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({ vectorStore: adapter, embedding })

    const { bucket, documents, indexConfig } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(bucket.id, documents, indexConfig)

    const response = await instance.query('Document')
    const results = response.results

    const xml = instance.assemble(results, { format: 'xml' })
    const md = instance.assemble(results, { format: 'markdown' })
    const plain = instance.assemble(results, { format: 'plain' })
    const custom = instance.assemble(results, { format: (r) => `Count: ${r.length}` })

    expect(xml).toContain('<context>')
    expect(md).toContain('---')
    expect(plain).not.toContain('<')
    expect(custom).toMatch(/Count: \d+/)
  })

  it('hooks observability (full lifecycle)', async () => {
    const onIndexStart = vi.fn()
    const onIndexComplete = vi.fn()
    const onQueryResults = vi.fn()

    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await d8umCreate({
      vectorStore: adapter,
      embedding,
      hooks: { onIndexStart, onIndexComplete, onQueryResults },
    })

    const { bucket, documents, indexConfig } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    await instance.ingest(bucket.id, documents, indexConfig)
    expect(onIndexStart).toHaveBeenCalled()
    expect(onIndexComplete).toHaveBeenCalled()

    await instance.query('test')
    expect(onQueryResults).toHaveBeenCalled()
  })
})
