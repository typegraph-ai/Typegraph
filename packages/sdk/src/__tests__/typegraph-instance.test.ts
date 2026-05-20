import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_BUCKET_ID, typegraphInit, typegraphDeploy } from '../typegraph.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-document.js'
import { createTestDocument, createTestDocuments } from './helpers/mock-connector.js'
import type { typegraphInstance } from '../typegraph.js'
import type { Bucket } from '../types/bucket.js'
import type { Embedder } from '../embedding/provider.js'
import type { typegraphEventRecord } from '../types/event.js'
import type { EntityDetail, EntityResult, GraphExploreResult, KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { Reranker } from '../types/extractor.js'
import type { QueryChunkResult } from '../types/query.js'

/** Register a pre-built Bucket + embedding on an instance (bypasses buckets.create UUID generation). */
function registerTestBucket(instance: typegraphInstance, bucket: Bucket, embedding: Embedder) {
  const impl = instance as any
  impl._buckets.set(bucket.id, bucket)
  impl.bucketEmbeddings.set(bucket.id, embedding)
  impl.bucketSearchEmbeddings.set(bucket.id, embedding)
}

function setKnowledgeGraph(instance: typegraphInstance, knowledgeGraph: KnowledgeGraphBridge) {
  ;(instance as any).graphBridgeInstance = knowledgeGraph
}

describe('typegraphInit', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let instance: typegraphInstance

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    instance = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })
  })

  describe('buckets.create', () => {
    it('creates a bucket with a generated id', async () => {
      const bucket = await instance.bucket.create({ name: 'Test Bucket' })
      expect(bucket.id).toBeDefined()
      expect(bucket.name).toBe('Test Bucket')
      expect(bucket.status).toBe('active')
    })

    it('accepts a bucket-owned graph and registers it as a public graph', async () => {
      const bucket = await instance.bucket.create({ id: 'novel-a', name: 'Novel A', graph: 'graph-novel-a' })

      expect(bucket.graph).toBe('graph-novel-a')
      expect((instance as any).graphConfigs.get('graph-novel-a')).toMatchObject({
        id: 'graph-novel-a',
        tenantId: 'tenant-1',
        access: 'public',
        metadata: { type: 'bucket' },
      })
      expect(adapter._graphs.get('tenant-1:graph-novel-a')).toMatchObject({
        id: 'graph-novel-a',
        tenantId: 'tenant-1',
      })
    })

    it('applies bucket graphConfig ontology to bucket-owned graphs', async () => {
      await instance.bucket.create({
        id: 'novel-a',
        name: 'Novel A',
        graph: 'graph-novel-a',
        graphConfig: {
          ontology: { version: 'bench-literary', profiles: ['literary'] },
          metadata: { benchmark: 'graphrag-bench-novel' },
        },
      })

      expect((instance as any).graphConfigs.get('graph-novel-a')).toMatchObject({
        id: 'graph-novel-a',
        tenantId: 'tenant-1',
        access: 'public',
        ontology: { version: 'bench-literary', profiles: ['literary'] },
        metadata: { type: 'bucket', benchmark: 'graphrag-bench-novel' },
      })
      expect((instance as any).compiledOntologies.get('graph-novel-a').entityTypes).toContain('character')
      expect(adapter._graphs.get('tenant-1:graph-novel-a')).toMatchObject({
        ontology: { version: 'bench-literary', profiles: ['literary'] },
        metadata: { type: 'bucket', benchmark: 'graphrag-bench-novel' },
      })
    })

    it('registers configured bucket graphs during init', async () => {
      const inst = await typegraphInit({
        vectorStore: adapter,
        embedding,
        tenantId: 'tenant-1',
        buckets: {
          novel: { name: 'Novel', graph: 'graph-from-config' },
        },
      })

      expect((inst as any).graphConfigs.get('graph-from-config')).toMatchObject({
        id: 'graph-from-config',
        tenantId: 'tenant-1',
        access: 'public',
      })
      expect(adapter._graphs.get('tenant-1:graph-from-config')).toMatchObject({
        id: 'graph-from-config',
        tenantId: 'tenant-1',
      })
    })

    it('loads persisted bucket graphs during init', async () => {
      await adapter.upsertGraphRecord!({
        id: 'persisted-graph',
        tenantId: 'tenant-1',
        name: 'Persisted',
        access: 'public',
      })

      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })

      expect((inst as any).graphConfigs.get('persisted-graph')).toMatchObject({
        id: 'persisted-graph',
        tenantId: 'tenant-1',
        access: 'public',
      })
    })

    it('registers embedding for new bucket', async () => {
      const bucket = await instance.bucket.create({ name: 'Test Bucket' })
      expect(instance.getEmbeddingForBucket(bucket.id)).toBeDefined()
    })
  })

  describe('getEmbeddingForBucket', () => {
    it('returns default embedding', () => {
      const { bucket } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const emb = instance.getEmbeddingForBucket(bucket.id)
      expect(emb.name).toBe(embedding.name)
    })

    it('returns per-bucket override', () => {
      const customEmb = createMockEmbedding({ model: 'custom-v2' })
      const { bucket } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, customEmb)
      const emb = instance.getEmbeddingForBucket(bucket.id)
      expect(emb.name).toBe('custom-v2')
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

    it('filters to documentIds', () => {
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
    it('groups documents by model', () => {
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
        externalIds: [{ id: 'alice@example.com', type: 'email', encoding: 'none' }],
        edgeCount: 0,
        metadata: {},
        createdAt: new Date(),
        topEdges: [],
      }
      const knowledgeGraph: KnowledgeGraphBridge = {
        upsertEntity: vi.fn().mockResolvedValue(seeded),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })
      setKnowledgeGraph(inst, knowledgeGraph)

      const result = await inst.graph.upsertEntity({
        name: 'Alice',
        entityType: 'person',
        externalIds: [{ id: 'alice@example.com', type: 'email' }],
      })

      expect(knowledgeGraph.upsertEntity).toHaveBeenCalledWith({
        name: 'Alice',
        entityType: 'person',
        externalIds: [{ id: 'alice@example.com', type: 'email' }],
        tenantId: 'tenant-1',
        graphId: 'public',
        graphIds: ['public'],
      })
      expect(result).toEqual(seeded)
    })

    it('rejects seed entity types outside the effective ontology', async () => {
      const knowledgeGraph: KnowledgeGraphBridge = {
        upsertEntity: vi.fn(),
      }
      const inst = await typegraphInit({
        vectorStore: adapter,
        embedding,
        tenantId: 'tenant-1',
        ontology: {
          version: 'strict-customer',
          mode: 'strict',
          entities: {
            customer: { description: 'A customer organization.' },
          },
        },
      })
      setKnowledgeGraph(inst, knowledgeGraph)

      await expect(inst.graph.upsertEntity({
        name: 'Alice',
        entityType: 'person',
      })).rejects.toThrow('Entity type "person" is not allowed by ontology "strict-customer"')
      expect(knowledgeGraph.upsertEntity).not.toHaveBeenCalled()
    })
  })

  describe('graph.searchEntities', () => {
    it('preserves bridge-provided aliases and edge counts', async () => {
      const searchResults: EntityResult[] = [{
        id: 'ent_caesar',
        name: 'Cousin Cæsar',
        entityType: 'person',
        aliases: ['Cole Conway', 'Conway'],
        similarity: 0.98,
        edgeCount: 4,
        metadata: { description: 'Uses the name Cole Conway in Paducah.' },
      }]
      const knowledgeGraph: KnowledgeGraphBridge = {
        searchEntities: vi.fn().mockResolvedValue(searchResults),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })
      setKnowledgeGraph(inst, knowledgeGraph)

      const results = await inst.graph.searchEntities('Cole Conway', { context: { userId: 'test-user' }, limit: 5 })

      expect(knowledgeGraph.searchEntities).toHaveBeenCalledWith('Cole Conway', { userId: 'test-user', tenantId: 'tenant-1', graphId: 'public', graphIds: ['public'] }, 5)
      expect(results).toEqual(searchResults)
    })

    it('filters search results by entity type and minimum connections', async () => {
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
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })
      setKnowledgeGraph(inst, knowledgeGraph)

      const results = await inst.graph.searchEntities('Cole Conway', {
        context: { userId: 'test-user' },
        limit: 10,
        entityType: 'person',
        minConnections: 2,
      })

      expect(knowledgeGraph.searchEntities).toHaveBeenCalledWith('Cole Conway', { userId: 'test-user', tenantId: 'tenant-1', graphId: 'public', graphIds: ['public'] }, 10)
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
      const exploreResult: GraphExploreResult = {
        intent: {
          rawQuery: 'plotline employees',
          documentEntityQueries: [],
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
          description: 'Adarsh Tadimari works for Plotline',
          weight: 1,
          
        }],
      }
      const knowledgeGraph: KnowledgeGraphBridge = {
        explore: vi.fn().mockResolvedValue(exploreResult),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1' })
      setKnowledgeGraph(inst, knowledgeGraph)

      const result = await inst.graph.explore('plotline employees', {
        context: { userId: 'test-user' },
        depth: 1,
        include: { chunks: false },
      })

      expect(knowledgeGraph.explore).toHaveBeenCalledWith('plotline employees', {
        userId: 'test-user',
        tenantId: 'tenant-1',
        graphId: 'public',
        graphIds: ['public'],
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
      const document = createTestDocument({ content: 'Some content to ingest' })
      const result = await instance.document.ingest([document], { ...ingestOptions, bucketId: bucket.id })
      expect(result.inserted).toBe(1)
    })

    it('treats null ingest opts as omitted', async () => {
      const { bucket } = createMockBucket({ id: DEFAULT_BUCKET_ID, documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const document = createTestDocument({ content: 'Some content to ingest with null opts' })

      const result = await instance.document.ingest([document], null)

      expect(result.inserted).toBe(1)
      expect(result.bucketId).toBe(DEFAULT_BUCKET_ID)
    })

    it('treats null pre-chunked ingest opts as omitted', async () => {
      const { bucket } = createMockBucket({ id: DEFAULT_BUCKET_ID, documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const document = createTestDocument({ content: 'Prechunked content with null opts' })

      const result = await instance.document.ingestPreChunked(
        document,
        [{ content: document.content, chunkIndex: 0 }],
        null,
      )

      expect(result.inserted).toBe(1)
      expect(result.bucketId).toBe(DEFAULT_BUCKET_ID)
    })

    it('ignores null document subject external ID entries', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const document = createTestDocument({
        subject: {
          externalIds: [
            null,
            undefined,
            { type: 'email', id: 'pat@example.com' },
          ] as any,
        },
      })

      const result = await instance.document.ingest([document], { ...ingestOptions, bucketId: bucket.id })

      expect(result.inserted).toBe(1)
    })

    it('ingests a batch of documents', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const documents = createTestDocuments(3)
      const result = await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
    })

    it('batches all chunks into a single embed call', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const documents = createTestDocuments(3)
      const spy = vi.spyOn(embedding, 'embed')
      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      expect(spy).toHaveBeenCalledOnce()
    })

    it('returns zero-count result for empty array', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      const result = await instance.document.ingest([], { ...ingestOptions, bucketId: bucket.id })
      expect(result.total).toBe(0)
      expect(result.inserted).toBe(0)
    })

    it('throws for unknown bucket', async () => {
      const { ingestOptions } = createMockBucket({ documents: [] })
      await expect(instance.document.ingest([], { ...ingestOptions, bucketId: 'unknown' })).rejects.toThrow('not found')
    })

    it('calls adapter.connect during typegraphInit', async () => {
      expect(adapter.calls.filter(c => c.method === 'connect')).toHaveLength(1)
    })
  })

  describe('optional filters', () => {
    it('treats null list filters as omitted', async () => {
      const { bucket, ingestOptions } = createMockBucket({ documents: [] })
      registerTestBucket(instance, bucket, embedding)
      await instance.document.ingest([createTestDocument()], { ...ingestOptions, bucketId: bucket.id })

      await expect(instance.document.list(null)).resolves.toHaveLength(1)
      await expect(instance.job.list(null)).resolves.toEqual([])
    })

    it('rejects null destructive document filters with a ConfigError', async () => {
      await expect(instance.document.delete(null)).rejects.toThrow('document.delete requires at least one filter field')
    })

    it('rejects null destructive event filters with a ConfigError', async () => {
      await expect(instance.event.delete(null)).rejects.toThrow('event.delete requires at least one filter field')
    })
  })

  describe('query', () => {
    it('returns results', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(3) })
      registerTestBucket(instance, bucket, embedding)
      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await instance.search('Documents 1')
      expect(response.results.chunks.length).toBeGreaterThan(0)
    })

    it('uses the reranker configured on typegraphInit for self-hosted search', async () => {
      const reranker: Reranker<QueryChunkResult> = {
        name: 'configured-reranker',
        rerank: vi.fn(async (_query, candidates) => [...candidates].reverse()),
      }
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'tenant-1', reranker })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(3) })
      registerTestBucket(inst, bucket, embedding)
      await inst.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

      const response = await inst.search('Documents', { limit: 1, rerank: true })

      expect(reranker.rerank).toHaveBeenCalled()
      expect(response.query.mergeStrategy).toBe('rrf+rerank')
      expect(response.results.chunks).toHaveLength(1)
      expect(response.results.chunks[0]!.scores.output.reranker).toBe(1)
    })

    it('does not throw when rerank is requested without a configured reranker', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

      const response = await instance.search('Documents 1', { rerank: true })

      expect(response.results.chunks.length).toBeGreaterThan(0)
      expect(response.query.mergeStrategy).toBe('rrf')
      expect(response.warnings?.[0]).toContain('no reranker is configured')
    })

    it('treats null query opts as omitted', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })

      const response = await instance.search('Documents 1', null)

      expect(response.results.chunks.length).toBeGreaterThan(0)
    })

    it('does not expose tenantId from config in search responses', async () => {
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'config-tenant' })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(inst, bucket, embedding)
      await inst.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await inst.search('test')
      expect('tenantId' in response.query).toBe(false)
    })

    it('rejects legacy per-query tenantId overrides', async () => {
      const inst = await typegraphInit({ vectorStore: adapter, embedding, tenantId: 'config-tenant' })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(inst, bucket, embedding)
      await inst.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      await expect(inst.search('test', { tenantId: 'query-tenant' } as any)).rejects.toThrow('opts.context')
    })

    it('supports context option for XML context', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await instance.search('test', { promptBuilder: { format: 'xml' } })
      expect(response.prompt).toContain('<context>')
      expect(response.promptStats?.format).toBe('xml')
    })

    it('supports context option for plain text context', async () => {
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: createTestDocuments(1) })
      registerTestBucket(instance, bucket, embedding)
      await instance.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      const response = await instance.search('test', { promptBuilder: { format: 'plain' } })
      expect(response.prompt).toBeDefined()
      expect(response.prompt).not.toContain('<context>')
    })
  })

  describe('hooks', () => {
    it('fires onIndexStart and onIndexComplete', async () => {
      const onIndexStart = vi.fn()
      const onIndexComplete = vi.fn()
      const inst = await typegraphInit({
        vectorStore: adapter,
        embedding,
        tenantId: 'tenant-1',
        hooks: { onIndexStart, onIndexComplete },
      })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: [createTestDocument()] })
      registerTestBucket(inst, bucket, embedding)
      await inst.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      expect(onIndexStart).toHaveBeenCalledOnce()
      expect(onIndexComplete).toHaveBeenCalledOnce()
    })

    it('fires onQueryResults', async () => {
      const onQueryResults = vi.fn()
      const inst = await typegraphInit({
        vectorStore: adapter,
        embedding,
        tenantId: 'tenant-1',
        hooks: { onQueryResults },
      })
      const { bucket, documents, ingestOptions } = createMockBucket({ documents: [createTestDocument()] })
      registerTestBucket(inst, bucket, embedding)
      await inst.document.ingest(documents, { ...ingestOptions, bucketId: bucket.id })
      await inst.search('test')
      expect(onQueryResults).toHaveBeenCalledOnce()
    })
  })

  describe('event and thread URLs', () => {
    it('deletes events through the adapter delete primitive', async () => {
      await instance.event.ingest({
        id: 'evt_delete',
        name: 'Delete me',
        occurredAt: new Date('2026-05-13T12:00:00.000Z'),
      }, { bucketId: DEFAULT_BUCKET_ID }) as typegraphEventRecord

      const count = await instance.event.delete({ eventIds: ['evt_delete'] })

      expect(count).toBe(1)
      await expect(instance.event.get('evt_delete')).resolves.toBeNull()
      expect(adapter.calls.find(c => c.method === 'deleteEvents')?.args[0]).toEqual(expect.objectContaining({
        tenantId: 'tenant-1',
        eventIds: ['evt_delete'],
        graphIds: ['public'],
      }))
    })

    it('persists event URL as a top-level field', async () => {
      const event = await instance.event.ingest({
        id: 'evt_url',
        name: 'Linked event',
        url: 'https://example.com/events/evt_url',
        occurredAt: new Date('2026-05-13T12:00:00.000Z'),
        content: 'Event content',
      }, { bucketId: DEFAULT_BUCKET_ID }) as typegraphEventRecord

      expect(event).toMatchObject({
        id: 'evt_url',
        url: 'https://example.com/events/evt_url',
      })
      expect(adapter.calls.find(c => c.method === 'upsertEvent')?.args[0]).toEqual(expect.objectContaining({
        url: 'https://example.com/events/evt_url',
      }))
    })

    it('normalizes event url=null to no URL', async () => {
      const event = await instance.event.ingest({
        id: 'evt_null_url',
        name: 'Null URL event',
        url: null,
        occurredAt: new Date('2026-05-13T12:00:00.000Z'),
      }, { bucketId: DEFAULT_BUCKET_ID }) as typegraphEventRecord

      expect(event.url).toBeUndefined()
      expect(adapter.calls.find(c => c.method === 'upsertEvent')?.args[0]).toEqual(expect.objectContaining({
        url: undefined,
      }))
    })

    it('persists thread URL as a top-level field', async () => {
      const thread = await instance.thread.upsert({
        id: 'thread_url',
        name: 'Linked thread',
        url: 'https://example.com/threads/thread_url',
      }, { bucketId: DEFAULT_BUCKET_ID })

      expect(thread).toMatchObject({
        id: 'thread_url',
        url: 'https://example.com/threads/thread_url',
      })
      expect(adapter.calls.find(c => c.method === 'upsertThread')?.args[0]).toEqual(expect.objectContaining({
        url: 'https://example.com/threads/thread_url',
      }))
    })

    it('stores thread turn URL on the generated event', async () => {
      const result = await instance.thread.addTurn('thread_turn_url', {
        role: 'user',
        content: 'A linked message',
        url: 'https://example.com/messages/msg_1',
      }, {
        bucketId: DEFAULT_BUCKET_ID,
        context: { threadId: 'thread_turn_url' },
      })

      expect(result.event).toMatchObject({
        threadId: 'thread_turn_url',
        url: 'https://example.com/messages/msg_1',
      })
      expect(adapter.calls.filter(c => c.method === 'upsertEvent').at(-1)?.args[0]).toEqual(expect.objectContaining({
        threadId: 'thread_turn_url',
        url: 'https://example.com/messages/msg_1',
      }))
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
      const inst = await typegraphDeploy({ vectorStore: a, embedding, tenantId: 'tenant-1' })
      expect(a.calls.filter(c => c.method === 'deploy')).toHaveLength(1)
      expect(a.calls.filter(c => c.method === 'connect')).toHaveLength(0)
      await expect(inst.search('test')).rejects.toThrow()
    })

    it('typegraphInit calls connect()', async () => {
      const a = createMockAdapter()
      await typegraphInit({ vectorStore: a, embedding, tenantId: 'tenant-1' })
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
      const inst = await typegraphInit({ vectorStore: a, embedding, tenantId: 'tenant-1' })
      const result = await inst.undeploy()
      expect(result.success).toBe(false)
      expect(result.message).toContain('does not support')
    })
  })
})
