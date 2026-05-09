import { describe, it, expect, vi } from 'vitest'
import { typegraphInit } from '../typegraph.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-document.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import type { typegraphInstance } from '../typegraph.js'
import type { Bucket } from '../types/bucket.js'
import type { Embedder } from '../embedding/provider.js'

/** Register a pre-built Bucket + embedding on an instance (bypasses buckets.create UUID generation). */
function registerTestBucket(instance: typegraphInstance, bucket: Bucket, embedding: Embedder) {
  const impl = instance as any
  impl._buckets.set(bucket.id, bucket)
  impl.bucketEmbeddings.set(bucket.id, embedding)
}

describe('integration', () => {
  it('add bucket → ingest → query → context xml', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(3) })
    registerTestBucket(instance, bucket, embedding)
    await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    const response = await instance.search('Documents 1', { promptBuilder: { format: 'xml' } })
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.prompt).toContain('<context>')
    expect(response.prompt).toContain('<context_chunks>')
    expect(response.prompt).toContain('<context_chunk_1>')
    expect(response.promptStats?.format).toBe('xml')
  })

  it('ingest → re-ingest with changes → query shows updated content', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

    const documents = [createTestDocument({ id: 'document-1', content: 'Original content for testing' })]
    const { bucket, ingestOptions } = createMockBucket({ documents: documents })
    registerTestBucket(instance, bucket, embedding)
    await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    const updatedDocs = [createTestDocument({ id: 'document-1', content: 'Updated content with new information' })]
    await instance.document.ingest(updatedDocs, { ...ingestOptions, bucketId: bucket.id })

    const response = await instance.search('Updated content')
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.content).toContain('Updated')
  })

  it('multi-bucket → merged query results', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

    const { bucket: document1, documents: docs1, ingestOptions: ingestOptions1 } = createMockBucket({ id: 'src-1', documents: createTestDocuments(2, 'Alpha') })
    const { bucket: document2, documents: docs2, ingestOptions: ingestOptions2 } = createMockBucket({ id: 'src-2', documents: createTestDocuments(2, 'Beta') })
    registerTestBucket(instance, document1, embedding)
    registerTestBucket(instance, document2, embedding)

    await instance.document.ingest(docs1, { ...ingestOptions1, bucketId: 'src-1' })
    await instance.document.ingest(docs2, { ...ingestOptions2, bucketId: 'src-2' })

    const response = await instance.search('content')
    expect(response.results.chunks.length).toBeGreaterThan(0)
    const bucketIds = new Set(response.results.chunks.map(r => r.document.bucketId))
    expect(bucketIds.size).toBeGreaterThanOrEqual(1)
  })

  it('multi-model (different embedding models per bucket)', async () => {
    const adapter = createMockAdapter()
    const embeddingA = createMockEmbedding({ model: 'model-a', dimensions: 4 })
    const embeddingB = createMockEmbedding({ model: 'model-b', dimensions: 4 })
    const instance = await typegraphInit({ vectorStore: adapter, embedding: embeddingA, tenantId: 'tenant-1' })

    const { bucket: document1, documents: docs1, ingestOptions: ingestOptions1 } = createMockBucket({ id: 'src-1', documents: createTestDocuments(2, 'Alpha') })
    const { bucket: document2, documents: docs2, ingestOptions: ingestOptions2 } = createMockBucket({ id: 'src-2', documents: createTestDocuments(2, 'Beta') })
    registerTestBucket(instance, document1, embeddingA)
    registerTestBucket(instance, document2, embeddingB)

    await instance.document.ingest(docs1, { ...ingestOptions1, bucketId: 'src-1' })
    await instance.document.ingest(docs2, { ...ingestOptions2, bucketId: 'src-2' })

    expect(adapter._chunks.has('model-a:4')).toBe(true)
    expect(adapter._chunks.has('model-b:4')).toBe(true)
  })

  it('idempotency (repeated ingestion is no-op)', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    const result1 = await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
    const result2 = await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    expect(result1.inserted).toBe(2)
    expect(result2.skipped).toBe(2)
    expect(result2.inserted).toBe(0)
  })

  it('tenant isolation', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instanceA = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-a' })
    const instanceB = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-b' })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instanceA, bucket, embedding)
    registerTestBucket(instanceB, bucket, embedding)

    await instanceA.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
    await instanceB.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    const responseA = await instanceA.search('Documents')
    const responseB = await instanceB.search('Documents')

    expect(responseA.query.tenantId).toBe('tenant-a')
    expect(responseB.query.tenantId).toBe('tenant-b')
  })

  it('ingestPreChunked → query', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

    const { bucket } = createMockBucket({ documents: [] })
    registerTestBucket(instance, bucket, embedding)

    const document = createTestDocument({ content: 'Ingested document content' })
    const chunks = [
      { content: 'Chunk zero text', chunkIndex: 0 },
      { content: 'Chunk one text', chunkIndex: 1 },
    ]
    await instance.document.ingestPreChunked(document, chunks, { bucketId: bucket.id })

    const response = await instance.search('Chunk zero text')
    expect(response.results.chunks.length).toBeGreaterThan(0)
  })

  it('query context pipeline (same results → xml/md/plain)', async () => {
    const adapter = createMockAdapter()
    const embedding = createMockEmbedding()
    const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)
    await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

    const xmlResponse = await instance.search('Documents', { promptBuilder: { format: 'xml' } })
    const mdResponse = await instance.search('Documents', { promptBuilder: { format: 'markdown' } })
    const plainResponse = await instance.search('Documents', { promptBuilder: { format: 'plain' } })

    expect(xmlResponse.prompt).toContain('<context>')
    expect(mdResponse.prompt).toContain('# Context')
    expect(plainResponse.prompt).not.toContain('<')
  })

  describe('access scope isolation', () => {
    const tenantId = 'tenant-x'

    it.each([
      ['user',   { userId: 'u1' },   { userId: 'u2' },   { type: 'user', id: 'u1' }],
      ['agent',  { agentId: 'a1' },  { agentId: 'a2' },  { type: 'agent', id: 'a1' }],
      ['thread', { threadId: 't1' }, { threadId: 't2' }, { type: 'thread', id: 't1' }],
      ['group',  { groupId: 'g1' },  { groupId: 'g2' },  { type: 'group', id: 'g1' }],
    ] as const)('accessScope=%s ignores unscoped + wrong-identity queries, returns only matching', async (_kind, match, wrong, accessRef) => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId })

      const documents = createTestDocuments(1, 'PrivateDoc')
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      registerTestBucket(instance, bucket, embedding)

      await instance.document.ingest(documents, {
        ...ingestOptions,
        bucketId: bucket.id,
        context: { ...match, access: [accessRef] },
      })

      const unscoped = await instance.search('PrivateDoc')
      expect(unscoped.results.chunks).toHaveLength(0)

      const wrongIdentity = await instance.search('PrivateDoc', { context: wrong })
      expect(wrongIdentity.results.chunks).toHaveLength(0)

      const matchingIdentity = await instance.search('PrivateDoc', { context: match })
      expect(matchingIdentity.results.chunks.length).toBeGreaterThan(0)
    })

    it('empty accessScope returns rows for tenant-scoped queries', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId })

      const documents = createTestDocuments(1, 'PublicDoc')
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      registerTestBucket(instance, bucket, embedding)

      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

      const tenantScoped = await instance.search('PublicDoc')
      expect(tenantScoped.results.chunks.length).toBeGreaterThan(0)
    })

    it('tenant_id remains the hard namespace boundary', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId })
      const wrongTenantInstance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-y' })

      const documents = createTestDocuments(1, 'TenantGated')
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      registerTestBucket(instance, bucket, embedding)

      await instance.document.ingest(documents, {
        ...ingestOptions,
        bucketId: bucket.id,
      })

      registerTestBucket(wrongTenantInstance, bucket, embedding)
      const wrongTenant = await wrongTenantInstance.search('TenantGated')
      expect(wrongTenant.results.chunks).toHaveLength(0)

      const matchingTenant = await instance.search('TenantGated')
      expect(matchingTenant.results.chunks.length).toBeGreaterThan(0)
    })

    it('updating document accessScope cascades to indexed chunks', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId })

      const documents = createTestDocuments(1, 'MigratingDoc')
      const { bucket, ingestOptions } = createMockBucket({ documents: documents })
      registerTestBucket(instance, bucket, embedding)

      await instance.document.ingest(documents, {
        ...ingestOptions,
        bucketId: bucket.id,
        context: { userId: 'u1' },
      })

      const before = await instance.search('MigratingDoc')
      expect(before.results.chunks.length).toBeGreaterThan(0)

      const documentId = [...adapter._documents.values()][0]!.id
      await instance.document.update(documentId, {}, { context: { access: [{ type: 'user', id: 'u1' }] } })

      const afterUnscoped = await instance.search('MigratingDoc')
      expect(afterUnscoped.results.chunks).toHaveLength(0)

      const afterScoped = await instance.search('MigratingDoc', { context: { userId: 'u1' } })
      expect(afterScoped.results.chunks.length).toBeGreaterThan(0)
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
      tenantId: 'tenant-1',
      hooks: { onIndexStart, onIndexComplete, onQueryResults },
    })

    const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(2) })
    registerTestBucket(instance, bucket, embedding)

    await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
    expect(onIndexStart).toHaveBeenCalled()
    expect(onIndexComplete).toHaveBeenCalled()

    await instance.search('test')
    expect(onQueryResults).toHaveBeenCalled()
  })
})
