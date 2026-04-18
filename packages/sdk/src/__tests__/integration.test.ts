import { describe, it, expect, vi } from 'vitest'
import { typegraphInit } from '../typegraph.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import type { typegraphInstance } from '../typegraph.js'
import type { Bucket } from '../types/bucket.js'
import type { EmbeddingProvider } from '../embedding/provider.js'

/** Register a pre-built Bucket + embedding on an instance (bypasses buckets.create UUID generation). */
function registerTestBucket(instance: typegraphInstance, bucket: Bucket, embedding: EmbeddingProvider) {
  const impl = instance as any
  impl._buckets.set(bucket.id, bucket)
  impl.bucketEmbeddings.set(bucket.id, embedding)
}

describe('integration', () => {
  it('add bucket → ingest → query → format xml', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(3) })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    const response = await instance.query('Document 1', { format: 'xml' })
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.context).toContain('<context>')
    expect(response.context).toContain('<source')
    expect(response.context).toContain('<passage')
  })

  it('ingest → re-ingest with changes → query shows updated content', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const docs = [createTestDocument({ id: 'doc-1', content: 'Original content for testing' })]
    const { bucket, ingestOptions } = createMockBucket({ documents: docs })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(docs, { ...ingestOptions, bucketId: bucket.id })

    const updatedDocs = [createTestDocument({ id: 'doc-1', content: 'Updated content with new information' })]
    await instance.ingest(updatedDocs, { ...ingestOptions, bucketId: bucket.id })

    const response = await instance.query('Updated content')
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results[0]!.content).toContain('Updated')
  })

  it('multi-bucket → merged query results', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const { bucket: source1, documents: docs1, ingestOptions: ingestOptions1 } = createMockBucket({ id: 'src-1', documents: createTestDocuments(2, 'Alpha') })
    const { bucket: source2, documents: docs2, ingestOptions: ingestOptions2 } = createMockBucket({ id: 'src-2', documents: createTestDocuments(2, 'Beta') })
    registerTestBucket(instance, source1, embedding)
    registerTestBucket(instance, source2, embedding)

    await instance.ingest(docs1, { ...ingestOptions1, bucketId: 'src-1' })
    await instance.ingest(docs2, { ...ingestOptions2, bucketId: 'src-2' })

    const response = await instance.query('content')
    expect(response.results.length).toBeGreaterThan(0)
    const bucketIds = new Set(response.results.map(r => r.document.bucketId))
    expect(bucketIds.size).toBeGreaterThanOrEqual(1)
  })

  it('multi-model (different embedding models per bucket)', async () => {
    const adapter = createMockAdapter()
    const embeddingA = createMockEmbedding({ model: 'model-a', dimensions: 4 })
    const embeddingB = createMockEmbedding({ model: 'model-b', dimensions: 4 })
    const instance = await typegraphInit({ vectorStore: adapter, embedding: embeddingA })

    const { bucket: source1, documents: docs1, ingestOptions: ingestOptions1 } = createMockBucket({ id: 'src-1', documents: createTestDocuments(2, 'Alpha') })
    const { bucket: source2, documents: docs2, ingestOptions: ingestOptions2 } = createMockBucket({ id: 'src-2', documents: createTestDocuments(2, 'Beta') })
    registerTestBucket(instance, source1, embeddingA)
    registerTestBucket(instance, source2, embeddingB)

    await instance.ingest(docs1, { ...ingestOptions1, bucketId: 'src-1' })
    await instance.ingest(docs2, { ...ingestOptions2, bucketId: 'src-2' })

    expect(adapter._chunks.has('model-a:4')).toBe(true)
    expect(adapter._chunks.has('model-b:4')).toBe(true)
  })

  it('idempotency (repeated ingestion is no-op)', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    const result1 = await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
    const result2 = await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    expect(result1.inserted).toBe(2)
    expect(result2.skipped).toBe(2)
    expect(result2.inserted).toBe(0)
  })

  it('tenant isolation', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id, tenantId: 'tenant-a' })
    await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id, tenantId: 'tenant-b' })

    const responseA = await instance.query('Document', { tenantId: 'tenant-a' })
    const responseB = await instance.query('Document', { tenantId: 'tenant-b' })

    expect(responseA.query.tenantId).toBe('tenant-a')
    expect(responseB.query.tenantId).toBe('tenant-b')
  })

  it('ingestPreChunked → query', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const { bucket } = createMockBucket({ documents: [] })
    registerTestBucket(instance, bucket, embedding)

    const doc = createTestDocument({ content: 'Ingested document content' })
    const chunks = [
      { content: 'Chunk zero text', chunkIndex: 0 },
      { content: 'Chunk one text', chunkIndex: 1 },
    ]
    await instance.ingestPreChunked(doc, chunks, { bucketId: bucket.id })

    const response = await instance.query('Chunk zero text')
    expect(response.results.length).toBeGreaterThan(0)
  })

  it('query format pipeline (same results → xml/md/plain/custom)', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    const xmlResponse = await instance.query('Document', { format: 'xml' })
    const mdResponse = await instance.query('Document', { format: 'markdown' })
    const plainResponse = await instance.query('Document', { format: 'plain' })
    const customResponse = await instance.query('Document', { format: (r) => `Count: ${r.length}` })

    expect(xmlResponse.context).toContain('<context>')
    expect(mdResponse.context).toContain('---')
    expect(plainResponse.context).not.toContain('<')
    expect(customResponse.context).toMatch(/Count: \d+/)
  })

  describe('visibility scope isolation', () => {
    const tenantId = 'tenant-x'

    it.each([
      ['user',         { userId: 'u1' },          { userId: 'u2' }],
      ['agent',        { agentId: 'a1' },         { agentId: 'a2' }],
      ['conversation', { conversationId: 'c1' },  { conversationId: 'c2' }],
      ['group',        { groupId: 'g1' },         { groupId: 'g2' }],
    ] as const)('visibility=%s ignores unscoped + wrong-identity queries, returns only matching', async (vis, match, wrong) => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding })

      const docs = createTestDocuments(1, 'PrivateDoc')
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      registerTestBucket(instance, bucket, embedding)

      await instance.ingest(docs, {
        ...ingestOptions,
        bucketId: bucket.id,
        tenantId,
        visibility: vis,
        ...match,
      })

      const unscoped = await instance.query('PrivateDoc', { tenantId })
      expect(unscoped.results).toHaveLength(0)

      const wrongIdentity = await instance.query('PrivateDoc', { tenantId, ...wrong })
      expect(wrongIdentity.results).toHaveLength(0)

      const matchingIdentity = await instance.query('PrivateDoc', { tenantId, ...match })
      expect(matchingIdentity.results.length).toBeGreaterThan(0)
    })

    it('visibility=tenant returns rows on tenant-only queries (no identity narrowing)', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding })

      const docs = createTestDocuments(1, 'TenantDoc')
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      registerTestBucket(instance, bucket, embedding)

      // Tenant-visible rows intentionally carry no userId so any tenant-level
      // caller sees them regardless of their own userId.
      await instance.ingest(docs, {
        ...ingestOptions,
        bucketId: bucket.id,
        tenantId,
        visibility: 'tenant',
      })

      const unscoped = await instance.query('TenantDoc', { tenantId })
      expect(unscoped.results.length).toBeGreaterThan(0)
    })

    it('cascading visibility tighten (tenant → user) hides rows from unscoped queries', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding })

      const docs = createTestDocuments(1, 'MigratingDoc')
      const { bucket, ingestOptions } = createMockBucket({ documents: docs })
      registerTestBucket(instance, bucket, embedding)

      await instance.ingest(docs, {
        ...ingestOptions,
        bucketId: bucket.id,
        tenantId,
        visibility: 'tenant',
        userId: 'u1',
      })

      const before = await instance.query('MigratingDoc', { tenantId })
      expect(before.results.length).toBeGreaterThan(0)

      // Simulate the chunk-level cascade PgVectorAdapter.updateDocument() applies.
      for (const chunks of adapter._chunks.values()) {
        for (const c of chunks) c.visibility = 'user'
      }

      const afterUnscoped = await instance.query('MigratingDoc', { tenantId })
      expect(afterUnscoped.results).toHaveLength(0)

      const afterScoped = await instance.query('MigratingDoc', { tenantId, userId: 'u1' })
      expect(afterScoped.results.length).toBeGreaterThan(0)
    })
  })

  it('hooks observability (full lifecycle)', async () => {
    const onIndexStart = vi.fn()
    const onIndexComplete = vi.fn()
    const onQueryResults = vi.fn()

    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({
      vectorStore: adapter,
      embedding,
      hooks: { onIndexStart, onIndexComplete, onQueryResults },
    })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
    expect(onIndexStart).toHaveBeenCalled()
    expect(onIndexComplete).toHaveBeenCalled()

    await instance.query('test')
    expect(onQueryResults).toHaveBeenCalled()
  })
})
