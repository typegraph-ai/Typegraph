import { describe, it, expect, vi } from 'vitest'
import { typegraphInit } from '../typegraph.js'
import { GroupId } from '../types/identity.js'
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

    expect('tenantId' in responseA.query).toBe(false)
    expect('tenantId' in responseB.query).toBe(false)
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

  describe('graph overlay isolation', () => {
    const tenantId = 'tenant-x'

    it('public graph cannot read child graph data, while child graph reads its ancestors', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({
        vectorStore: adapter,
        embedding,
        tenantId,
        graphs: {
          public: { access: 'public' },
          internal: {
            extends: ['public'],
            access: {
              read: { groups: [GroupId('employees')] },
              write: { groups: [GroupId('employees')] },
            },
          },
        },
      })

      const publicDocs = [createTestDocument({ id: 'public-doc', content: 'PublicDoc content for everyone', name: 'PublicDoc' })]
      const internalDocs = [createTestDocument({ id: 'internal-doc', content: 'InternalDoc content for employees', name: 'InternalDoc' })]
      const { bucket: publicBucket, ingestOptions: publicIngestOptions } = createMockBucket({ id: 'public', documents: publicDocs })
      const { bucket: internalBucket, ingestOptions: internalIngestOptions } = createMockBucket({ id: 'gong', documents: internalDocs })
      registerTestBucket(instance, { ...publicBucket, graph: 'public' }, embedding)
      registerTestBucket(instance, { ...internalBucket, graph: 'internal' }, embedding)

      await instance.document.ingest(publicDocs, { ...publicIngestOptions, bucketId: publicBucket.id })
      await instance.document.ingest(internalDocs, {
        ...internalIngestOptions,
        bucketId: internalBucket.id,
        context: { groupId: 'employees' },
      })

      const publicPerspective = await instance.search('PublicDoc', {
        weights: { semantic: false, bm25: 1, graph: false, recency: false },
      })
      expect(publicPerspective.results.chunks.map(chunk => chunk.content).join('\n')).toContain('PublicDoc')
      expect(publicPerspective.results.chunks.map(chunk => chunk.content).join('\n')).not.toContain('InternalDoc')

      await expect(instance.search('InternalDoc', {
        graph: 'internal',
        context: { groupId: 'contractors' },
      })).rejects.toThrow('Context is not allowed to read graph(s): internal')

      const internalPublicPerspective = await instance.search('PublicDoc', {
        graph: 'internal',
        context: { groupId: 'employees' },
        weights: { semantic: false, bm25: 1, graph: false, recency: false },
      })
      expect(internalPublicPerspective.results.chunks.map(chunk => chunk.content).join('\n')).toContain('PublicDoc')

      const internalPrivatePerspective = await instance.search('InternalDoc', {
        graph: 'internal',
        context: { groupId: 'employees' },
        weights: { semantic: false, bm25: 1, graph: false, recency: false },
      })
      expect(internalPrivatePerspective.results.chunks.map(chunk => chunk.content).join('\n')).toContain('InternalDoc')
    })

    it('bucket graph routes writes and rejects per-ingest graph overrides', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({
        vectorStore: adapter,
        embedding,
        tenantId,
        graphs: {
          public: { access: 'public' },
          internal: { extends: ['public'], access: 'public' },
        },
      })

      const documents = createTestDocuments(1, 'RoutedDoc')
      const { bucket, ingestOptions } = createMockBucket({ id: 'gong', documents: documents })
      registerTestBucket(instance, { ...bucket, graph: 'internal' }, embedding)

      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

      const storedDocument = [...adapter._documents.values()][0]!
      expect(storedDocument.graphId).toBe('internal')
      expect([...adapter._chunks.values()][0]![0]!.graphId).toBe('internal')

      await expect(instance.document.ingest(documents, {
        ...ingestOptions,
        bucketId: bucket.id,
        graph: 'public',
      } as never)).rejects.toThrow('document.ingest does not accept graph')
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

    it('default bucket and graph are public', async () => {
      const adapter = createMockAdapter()
      const embedding = createMockEmbedding()
      const instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId })

      const documents = createTestDocuments(1, 'DefaultPublicDoc')
      const { ingestOptions } = createMockBucket({ documents: documents })

      await instance.document.ingest(documents, ingestOptions)

      const storedDocument = [...adapter._documents.values()][0]!
      expect(storedDocument.bucketId).toBe('public')
      expect(storedDocument.graphId).toBe('public')
      expect([...adapter._chunks.values()][0]![0]!.graphId).toBe('public')
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
