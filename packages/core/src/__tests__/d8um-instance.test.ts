import { describe, it, expect, beforeEach, vi } from 'vitest'
import { d8umCreate, d8umDeploy } from '../d8um.js'
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

describe('d8umCreate', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let instance: d8umInstance

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    instance = await d8umCreate({ vectorStore: adapter, embedding })
  })

  describe('buckets.create', () => {
    it('creates a bucket with a generated id', async () => {
      const bucket = await instance.buckets.create({ name: 'Test Bucket' })
      expect(bucket.id).toBeDefined()
      expect(bucket.name).toBe('Test Bucket')
      expect(bucket.status).toBe('active')
    })

    it('registers embedding for new bucket', async () => {
      const bucket = await instance.buckets.create({ name: 'Test Bucket' })
      expect(instance.getEmbeddingForBucket(bucket.id)).toBeDefined()
    })
  })

  describe('getEmbeddingForBucket', () => {
    it('returns default embedding', () => {
      const { bucket } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const emb = instance.getEmbeddingForBucket(bucket.id)
      expect(emb.model).toBe(embedding.model)
    })

    it('returns per-bucket override', () => {
      const customEmb = createMockEmbedding({ model: 'custom-v2' })
      const { bucket } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, customEmb)
      const emb = instance.getEmbeddingForBucket(bucket.id)
      expect(emb.model).toBe('custom-v2')
    })

    it('throws for unknown bucket', () => {
      expect(() => instance.getEmbeddingForBucket('unknown')).toThrow('not found')
    })
  })

  describe('getDistinctEmbeddings', () => {
    it('returns unique embeddings by model name', () => {
      const { bucket: s1 } = createMockBucket({ id: 'src-1', documents: [] })
      const { bucket: s2 } = createMockBucket({ id: 'src-2', documents: [] })
      registerTestBucket(instance, s1, embedding)
      registerTestBucket(instance, s2, embedding)
      const distinct = instance.getDistinctEmbeddings()
      expect(distinct.size).toBe(1) // Both use the same default embedding
    })

    it('filters to sourceIds', () => {
      const embA = createMockEmbedding({ model: 'model-a' })
      const embB = createMockEmbedding({ model: 'model-b' })
      const { bucket: s1 } = createMockBucket({ id: 'src-1', documents: [] })
      const { bucket: s2 } = createMockBucket({ id: 'src-2', documents: [] })
      registerTestBucket(instance, s1, embA)
      registerTestBucket(instance, s2, embB)
      const distinct = instance.getDistinctEmbeddings(['src-1'])
      expect(distinct.size).toBe(1)
      expect(distinct.has('model-a')).toBe(true)
    })
  })

  describe('groupBucketsByModel', () => {
    it('groups sources by model', () => {
      const { bucket: s1 } = createMockBucket({ id: 'src-1', documents: [] })
      const { bucket: s2 } = createMockBucket({ id: 'src-2', documents: [] })
      const differentEmb = createMockEmbedding({ model: 'different-model' })
      registerTestBucket(instance, s1, embedding)
      registerTestBucket(instance, s2, differentEmb)
      const groups = instance.groupBucketsByModel()
      expect(groups.size).toBe(2)
    })
  })

  describe('indexWithConnector', () => {
    it('indexes a specific bucket', async () => {
      const { bucket, connector, indexConfig } = createMockBucket({ documents: createTestDocuments(2) })
      registerTestBucket(instance, bucket, embedding)
      const result = await instance.indexWithConnector(bucket.id, connector, indexConfig)
      expect(result.total).toBe(2)
    })

    it('throws for unknown bucket', async () => {
      const { connector, indexConfig } = createMockBucket({ documents: [] })
      await expect(instance.indexWithConnector('unknown', connector, indexConfig)).rejects.toThrow('not found')
    })

    it('calls adapter.deploy and adapter.connect during d8umCreate', async () => {
      // d8umCreate calls deploy() then initialize() which calls connect()
      expect(adapter.calls.filter(c => c.method === 'deploy')).toHaveLength(1)
      expect(adapter.calls.filter(c => c.method === 'connect')).toHaveLength(1)
    })
  })

  describe('ingest', () => {
    it('ingests a single document', async () => {
      const { bucket, indexConfig } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const doc = createTestDocument({ content: 'Some content to ingest' })
      const result = await instance.ingest(bucket.id, [doc], indexConfig)
      expect(result.inserted).toBe(1)
    })

    it('ingests a batch of documents', async () => {
      const { bucket, indexConfig } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const docs = createTestDocuments(3)
      const result = await instance.ingest(bucket.id, docs, indexConfig)
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
    })

    it('batches all chunks into a single embedBatch call', async () => {
      const { bucket, indexConfig } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const docs = createTestDocuments(3)
      const spy = vi.spyOn(embedding, 'embedBatch')
      await instance.ingest(bucket.id, docs, indexConfig)
      expect(spy).toHaveBeenCalledOnce()
    })

    it('returns zero-count result for empty array', async () => {
      const { bucket, indexConfig } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const result = await instance.ingest(bucket.id, [], indexConfig)
      expect(result.total).toBe(0)
      expect(result.inserted).toBe(0)
    })
  })

  describe('query', () => {
    it('returns results', async () => {
      const { bucket, connector, indexConfig } = createMockBucket({ documents: createTestDocuments(3) })
      registerTestBucket(instance, bucket, embedding)
      await instance.indexWithConnector(bucket.id, connector, indexConfig)
      const response = await instance.query('Document 1')
      expect(response.results.length).toBeGreaterThan(0)
    })

    it('passes tenantId from config', async () => {
      const inst = await d8umCreate({ vectorStore: adapter, embedding, tenantId: 'config-tenant' })
      const { bucket, connector, indexConfig } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(inst, bucket, embedding)
      await inst.indexWithConnector(bucket.id, connector, indexConfig)
      const response = await inst.query('test')
      expect(response.query.tenantId).toBe('config-tenant')
    })

    it('per-query tenantId overrides config', async () => {
      const inst = await d8umCreate({ vectorStore: adapter, embedding, tenantId: 'config-tenant' })
      const { bucket, connector, indexConfig } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(inst, bucket, embedding)
      await inst.indexWithConnector(bucket.id, connector, indexConfig)
      const response = await inst.query('test', { tenantId: 'query-tenant' })
      expect(response.query.tenantId).toBe('query-tenant')
    })
  })

  describe('assemble', () => {
    it('assembles XML by default', async () => {
      const { bucket, connector, indexConfig } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.indexWithConnector(bucket.id, connector, indexConfig)
      const response = await instance.query('test')
      const xml = instance.assemble(response.results)
      expect(xml).toContain('<context>')
    })

    it('assembles plain text', async () => {
      const { bucket, connector, indexConfig } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.indexWithConnector(bucket.id, connector, indexConfig)
      const response = await instance.query('test')
      const plain = instance.assemble(response.results, { format: 'plain' })
      expect(plain).not.toContain('<context>')
    })
  })

  describe('hooks', () => {
    it('fires onIndexStart and onIndexComplete', async () => {
      const onIndexStart = vi.fn()
      const onIndexComplete = vi.fn()
      const inst = await d8umCreate({
        vectorStore: adapter,
        embedding,
        hooks: { onIndexStart, onIndexComplete },
      })
      const { bucket, connector, indexConfig } = createMockBucket({ documents: [createTestDocument()] })
      registerTestBucket(inst, bucket, embedding)
      await inst.indexWithConnector(bucket.id, connector, indexConfig)
      expect(onIndexStart).toHaveBeenCalledOnce()
      expect(onIndexComplete).toHaveBeenCalledOnce()
    })

    it('fires onQueryResults', async () => {
      const onQueryResults = vi.fn()
      const inst = await d8umCreate({
        vectorStore: adapter,
        embedding,
        hooks: { onQueryResults },
      })
      const { bucket, connector, indexConfig } = createMockBucket({ documents: [createTestDocument()] })
      registerTestBucket(inst, bucket, embedding)
      await inst.indexWithConnector(bucket.id, connector, indexConfig)
      await inst.query('test')
      expect(onQueryResults).toHaveBeenCalledOnce()
    })
  })

  describe('destroy', () => {
    it('calls adapter destroy', async () => {
      await instance.destroy()
      expect(adapter.calls.some(c => c.method === 'destroy')).toBe(true)
    })
  })

  describe('lifecycle', () => {
    it('deploy() calls adapter.deploy() but does not set initialized', async () => {
      const a = createMockAdapter()
      const inst = await d8umDeploy({ vectorStore: a, embedding })
      expect(a.calls.filter(c => c.method === 'deploy')).toHaveLength(1)
      expect(a.calls.filter(c => c.method === 'connect')).toHaveLength(0)
      // deploy-only instance should not be usable for runtime operations
      await expect(inst.query('test')).rejects.toThrow()
    })

    it('d8umCreate calls both deploy() and connect()', async () => {
      const a = createMockAdapter()
      await d8umCreate({ vectorStore: a, embedding })
      expect(a.calls.filter((c: { method: string }) => c.method === 'deploy')).toHaveLength(1)
      expect(a.calls.filter((c: { method: string }) => c.method === 'connect')).toHaveLength(1)
    })

    it('undeploy() delegates to adapter and clears state', async () => {
      const result = await instance.undeploy()
      expect(result.success).toBe(true)
      expect(adapter.calls.some(c => c.method === 'undeploy')).toBe(true)
    })

    it('undeploy() returns failure when adapter lacks undeploy', async () => {
      const a = createMockAdapter()
      delete (a as any).undeploy
      const inst = await d8umCreate({ vectorStore: a, embedding })
      const result = await inst.undeploy()
      expect(result.success).toBe(false)
      expect(result.message).toContain('does not support')
    })
  })
})
