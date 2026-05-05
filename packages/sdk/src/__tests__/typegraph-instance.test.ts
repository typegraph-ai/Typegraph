import { describe, it, expect, beforeEach, vi } from 'vitest'
import { typegraphInit, typegraphDeploy } from '../typegraph.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import type { typegraphInstance } from '../typegraph.js'
import type { Bucket } from '../types/bucket.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { EntityDetail, EntityResult, GraphExploreResult, KnowledgeGraphBridge } from '../types/graph-bridge.js'

/** Register a pre-built Bucket + embedding on an instance (bypasses buckets.create UUID generation). */
function registerTestBucket(instance: typegraphInstance, bucket: Bucket, embedding: EmbeddingProvider) {
  const impl = instance as any
  impl._buckets.set(bucket.id, bucket)
  impl.bucketEmbeddings.set(bucket.id, embedding)
}

describe('typegraphInit', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let instance: typegraphInstance

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    instance = await typegraphInit({ vectorStore: adapter, embedding })
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
      expect(distinct.size).toBe(1)
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
      expect(distinct.has('model-a:4')).toBe(true)
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

  describe('graph seeding', () => {
    it('forwards entity seeding to the knowledge graph bridge', async () => {
      const seeded: EntityDetail = {
        id: 'ent_alice',
        name: 'Alice',
        entityType: 'person',
        aliases: [],
        externalIds: [{ id: 'alice@example.com', type: 'email', identityType: 'user', encoding: 'none' }],
        edgeCount: 0,
        properties: {},
        createdAt: new Date(),
        topEdges: [],
      }
      const knowledgeGraph: KnowledgeGraphBridge = {
        upsertEntity: vi.fn().mockResolvedValue(seeded),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, knowledgeGraph })

      const result = await inst.graph.upsertEntity({
        name: 'Alice',
        entityType: 'person',
        externalIds: [{ id: 'alice@example.com', type: 'email', identityType: 'user' }],
      })

      expect(knowledgeGraph.upsertEntity).toHaveBeenCalledWith({
        name: 'Alice',
        entityType: 'person',
        externalIds: [{ id: 'alice@example.com', type: 'email', identityType: 'user' }],
      })
      expect(result).toEqual(seeded)
    })
  })

  describe('graph.searchEntities', () => {
    it('preserves bridge-provided aliases and edge counts', async () => {
      const identity = { userId: 'test-user' }
      const searchResults: EntityResult[] = [{
        id: 'ent_caesar',
        name: 'Cousin Cæsar',
        entityType: 'person',
        aliases: ['Cole Conway', 'Conway'],
        similarity: 0.98,
        edgeCount: 4,
        properties: { description: 'Uses the name Cole Conway in Paducah.' },
      }]
      const knowledgeGraph: KnowledgeGraphBridge = {
        searchEntities: vi.fn().mockResolvedValue(searchResults),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, knowledgeGraph })

      const results = await inst.graph.searchEntities('Cole Conway', identity, { limit: 5 })

      expect(knowledgeGraph.searchEntities).toHaveBeenCalledWith('Cole Conway', identity, 5)
      expect(results).toEqual(searchResults)
    })

    it('filters search results by entity type and minimum connections', async () => {
      const identity = { userId: 'test-user' }
      const knowledgeGraph: KnowledgeGraphBridge = {
        searchEntities: vi.fn().mockResolvedValue([
          {
            id: 'ent_caesar',
            name: 'Cousin Cæsar',
            entityType: 'person',
            aliases: ['Cole Conway'],
            similarity: 0.98,
            edgeCount: 3,
          },
          {
            id: 'ent_sharp',
            name: 'Steve Sharp',
            entityType: 'person',
            aliases: ['Sharp'],
            similarity: 0.86,
            edgeCount: 1,
          },
          {
            id: 'ent_paducah',
            name: 'Paducah, Kentucky',
            entityType: 'location',
            aliases: ['Paducah'],
            similarity: 0.77,
            edgeCount: 5,
          },
        ] satisfies EntityResult[]),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, knowledgeGraph })

      const results = await inst.graph.searchEntities('Cole Conway', identity, {
        limit: 10,
        entityType: 'person',
        minConnections: 2,
      })

      expect(knowledgeGraph.searchEntities).toHaveBeenCalledWith('Cole Conway', identity, 10)
      expect(results).toEqual([
        expect.objectContaining({
          id: 'ent_caesar',
          aliases: ['Cole Conway'],
          edgeCount: 3,
        }),
      ])
    })
  })

  describe('graph.explore', () => {
    it('forwards structured graph exploration to the bridge', async () => {
      const identity = { userId: 'test-user' }
      const exploreResult: GraphExploreResult = {
        intent: {
          rawQuery: 'plotline employees',
          sourceEntityQueries: [],
          targetEntityQueries: ['Plotline'],
          predicates: [{
            name: 'WORKS_FOR',
            confidence: 0.95,
          }],
          subqueries: ['plotline employees'],
          mode: 'relationship',
          strictness: 'soft',
        },
        anchors: [{
          id: 'ent_plotline',
          name: 'Plotline',
          entityType: 'organization',
          aliases: [],
          edgeCount: 3,
        }],
        entities: [{
          id: 'ent_adarsh',
          name: 'Adarsh Tadimari',
          entityType: 'person',
          aliases: ['Adarsh'],
          edgeCount: 4,
        }],
        facts: [{
          id: 'fact_1',
          edgeId: 'edge_1',
          sourceEntityId: 'ent_adarsh',
          sourceEntityName: 'Adarsh Tadimari',
          targetEntityId: 'ent_plotline',
          targetEntityName: 'Plotline',
          relation: 'WORKS_FOR',
          factText: 'Adarsh Tadimari works for Plotline',
          weight: 1,
          evidenceCount: 1,
        }],
      }
      const knowledgeGraph: KnowledgeGraphBridge = {
        explore: vi.fn().mockResolvedValue(exploreResult),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, knowledgeGraph })

      const result = await inst.graph.explore('plotline employees', {
        ...identity,
        depth: 1,
        include: { chunks: false },
      })

      expect(knowledgeGraph.explore).toHaveBeenCalledWith('plotline employees', {
        ...identity,
        depth: 1,
        include: { chunks: false },
      })
      expect(result).toEqual(exploreResult)
    })
  })

  describe('ingest', () => {
    it('ingests a single document', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const doc = createTestDocument({ content: 'Some content to ingest' })
      const result = await instance.ingest([doc], { ...ingestOptions, bucketId: bucket.id })
      expect(result.inserted).toBe(1)
    })

    it('ingests a batch of documents', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const docs = createTestDocuments(3)
      const result = await instance.ingest(docs, { ...ingestOptions, bucketId: bucket.id })
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
    })

    it('batches all chunks into a single embedBatch call', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const docs = createTestDocuments(3)
      const spy = vi.spyOn(embedding, 'embedBatch')
      await instance.ingest(docs, { ...ingestOptions, bucketId: bucket.id })
      expect(spy).toHaveBeenCalledOnce()
    })

    it('returns zero-count result for empty array', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const result = await instance.ingest([], { ...ingestOptions, bucketId: bucket.id })
      expect(result.total).toBe(0)
      expect(result.inserted).toBe(0)
    })

    it('throws for unknown bucket', async () => {
      const { ingestOptions } = createMockBucket({ documents: [] })
      await expect(instance.ingest([], { ...ingestOptions, bucketId: 'unknown' })).rejects.toThrow('not found')
    })

    it('calls adapter.connect during typegraphInit', async () => {
      expect(adapter.calls.filter(c => c.method === 'connect')).toHaveLength(1)
    })
  })

  describe('query', () => {
    it('returns results', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(3) })
      registerTestBucket(instance, bucket, embedding)
      await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await instance.query('Document 1')
      expect(response.results.chunks.length).toBeGreaterThan(0)
    })

    it('passes tenantId from config', async () => {
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'config-tenant' })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(inst, bucket, embedding)
      await inst.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await inst.query('test')
      expect(response.query.tenantId).toBe('config-tenant')
    })

    it('per-query tenantId overrides config', async () => {
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'config-tenant' })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(inst, bucket, embedding)
      await inst.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await inst.query('test', { tenantId: 'query-tenant' })
      expect(response.query.tenantId).toBe('query-tenant')
    })

    it('supports context option for XML context', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await instance.query('test', { context: { format: 'xml' } })
      expect(response.context).toContain('<context>')
      expect(response.contextStats?.format).toBe('xml')
    })

    it('supports context option for plain text context', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await instance.query('test', { context: { format: 'plain' } })
      expect(response.context).toBeDefined()
      expect(response.context).not.toContain('<context>')
    })
  })

  describe('hooks', () => {
    it('fires onIndexStart and onIndexComplete', async () => {
      const onIndexStart = vi.fn()
      const onIndexComplete = vi.fn()
      const inst = await typegraphInit({
        vectorStore: adapter,
        embedding,
        hooks: { onIndexStart, onIndexComplete },
      })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: [createTestDocument()] })
      registerTestBucket(inst, bucket, embedding)
      await inst.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      expect(onIndexStart).toHaveBeenCalledOnce()
      expect(onIndexComplete).toHaveBeenCalledOnce()
    })

    it('fires onQueryResults', async () => {
      const onQueryResults = vi.fn()
      const inst = await typegraphInit({
        vectorStore: adapter,
        embedding,
        hooks: { onQueryResults },
      })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: [createTestDocument()] })
      registerTestBucket(inst, bucket, embedding)
      await inst.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
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
      const inst = await typegraphDeploy({ vectorStore: a, embedding })
      expect(a.calls.filter(c => c.method === 'deploy')).toHaveLength(1)
      expect(a.calls.filter(c => c.method === 'connect')).toHaveLength(0)
      await expect(inst.query('test')).rejects.toThrow()
    })

    it('typegraphInit calls connect()', async () => {
      const a = createMockAdapter()
      await typegraphInit({ vectorStore: a, embedding })
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
      const inst = await typegraphInit({ vectorStore: a, embedding })
      const result = await inst.undeploy()
      expect(result.success).toBe(false)
      expect(result.message).toContain('does not support')
    })
  })
})
