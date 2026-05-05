import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryPlanner } from '../query/planner.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestSources } from './helpers/mock-connector.js'
import { IndexEngine } from '../index-engine/engine.js'
import { defaultChunker } from '../index-engine/chunker.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { KnowledgeGraphBridge, MemoryBridge } from '../types/graph-bridge.js'
import type { typegraphEvent, typegraphEventSink } from '../types/events.js'
import type { ExternalId, MemoryRecord } from '../memory/types/memory.js'

describe('QueryPlanner', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let bucketIds: string[]
  let bucketEmbeddings: Map<string, EmbeddingProvider>

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    bucketIds = []
    bucketEmbeddings = new Map()

    const sources = createTestSources(3)
    const { bucket, ingestOptions, chunkOpts } = createMockBucket({ id: 'src-1', sources: sources })
    bucketIds.push(bucket.id)
    bucketEmbeddings.set(bucket.id, embedding)

    await adapter.deploy()
    await adapter.connect()
    const engine = new IndexEngine(adapter, embedding)
    const items = await Promise.all(sources.map(async source => ({ source, chunks: await defaultChunker(source, chunkOpts) })))
    await engine.ingestBatch(bucket.id, items, ingestOptions)
  })

  it('returns results for indexed sources', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Source 1')
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.content).toBeDefined()
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(response.results.memories).toEqual([])
  })

  it('respects count', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test query', { count: 1 })
    expect(response.results.chunks).toHaveLength(1)
  })

  it('runs true keyword-only indexed search when semantic is explicitly disabled', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    adapter.calls.length = 0

    const response = await planner.execute('Source 1', {
      signals: { semantic: false, keyword: true },
      count: 2,
    })

    const hybridCall = adapter.calls.find(call => call.method === 'hybridSearch')
    expect(hybridCall).toBeDefined()
    expect((hybridCall!.args[3] as { signals?: unknown }).signals).toEqual({ semantic: false, keyword: true })
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.sources).toContain('keyword')
    expect(response.results.chunks[0]!.sources).not.toContain('semantic')
    expect(response.results.chunks[0]!.scores.normalized.semantic).toBeUndefined()
    expect(response.results.chunks[0]!.scores.normalized.keyword).toBeGreaterThan(0)
  })

  it('filters to requested sources', async () => {
    const docs2 = createTestSources(2, 'Other')
    const { bucket: bucket2, ingestOptions: ingestOptions2, chunkOpts: chunkOpts2 } = createMockBucket({ id: 'src-2', sources: docs2 })
    bucketIds.push(bucket2.id)
    bucketEmbeddings.set(bucket2.id, embedding)
    const engine = new IndexEngine(adapter, embedding)
    const items = await Promise.all(docs2.map(async source => ({ source, chunks: await defaultChunker(source, chunkOpts2) })))
    await engine.ingestBatch(bucket2.id, items, ingestOptions2)

    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test', { buckets: ['src-1'] })
    for (const r of response.results.chunks) {
      expect(r.source.bucketId).toBe('src-1')
    }
  })

  it('records per-source timings', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test')
    expect(response.buckets['src-1']).toBeDefined()
    expect(response.buckets['src-1']!.durationMs).toBeGreaterThanOrEqual(0)
    expect(response.buckets['src-1']!.status).toBe('ok')
  })

  it('returns empty results when no sources', async () => {
    const planner = new QueryPlanner(adapter, [], new Map(), new Map())
    const response = await planner.execute('test')
    expect(response.results.chunks).toHaveLength(0)
    expect(response.results.facts).toHaveLength(0)
    expect(response.results.entities).toHaveLength(0)
    expect(response.results.memories).toHaveLength(0)
  })

  it('passes tenantId through', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test', { tenantId: 'tenant-1' })
    expect(response.query.tenantId).toBe('tenant-1')
  })

  it('emits query.execute with structured snake_case result counters', async () => {
    const events: typegraphEvent[] = []
    const eventSink: typegraphEventSink = {
      emit: (event) => {
        events.push(event)
      },
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, eventSink)

    const response = await planner.execute('Source 1', { count: 2 })
    const queryEvents = events.filter(event => event.eventType === 'query.execute')

    expect(queryEvents).toHaveLength(1)
    expect(queryEvents[0]!.payload).toMatchObject({
      query: 'Source 1',
      requested_count: 2,
      result_count: response.results.chunks.length + response.results.memories.length,
      chunk_count: response.results.chunks.length,
      fact_count: 0,
      entity_count: 0,
      memory_count: 0,
      bucket_count: bucketIds.length,
    })
    expect(queryEvents[0]!.payload).not.toHaveProperty('resultCount')
    expect(queryEvents[0]!.payload).not.toHaveProperty('bucketCount')
  })

  it('maps results to structured query response shape', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Source 1')
    expect(response.results).toHaveProperty('chunks')
    expect(response.results).toHaveProperty('facts')
    expect(response.results).toHaveProperty('entities')
    expect(response.results).toHaveProperty('memories')
    const result = response.results.chunks[0]!
    expect(result).toHaveProperty('content')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('scores')
    expect(result).toHaveProperty('source')
    expect(result).toHaveProperty('chunk')
    expect(result).toHaveProperty('metadata')
    expect(result).not.toHaveProperty('facts')
    expect(result).not.toHaveProperty('entities')
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(result.source).toHaveProperty('id')
    expect(result.source).toHaveProperty('bucketId')
    expect(result.chunk).toHaveProperty('index')
    expect(result.chunk).toHaveProperty('total')
  })

  it('uses "semantic" source label for indexed results', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Source 1')
    const result = response.results.chunks[0]!
    expect(result.sources).toContain('semantic')
  })

  it('returns direct facts and entities for semantic search without graph traversal', async () => {
    const fact = {
      id: 'fact-direct',
      edgeId: 'edge-direct',
      sourceEntityId: 'ent-pat',
      sourceEntityName: 'Pat',
      targetEntityId: 'ent-sms',
      targetEntityName: 'SMS',
      relation: 'PREFERS',
      factText: 'Pat prefers SMS',
      weight: 1,
      evidenceCount: 1,
    }
    const entity = {
      id: 'ent-pat',
      name: 'Pat',
      entityType: 'person',
      aliases: [],
      edgeCount: 1,
    }
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchKnowledge: vi.fn().mockResolvedValue({ facts: [fact], entities: [entity] }),
      searchGraphChunks: vi.fn(),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('sms', {
      signals: { semantic: true, keyword: false, graph: false },
      count: 2,
    })

    expect(knowledgeGraph.searchKnowledge).toHaveBeenCalledWith('sms', expect.anything(), expect.objectContaining({
      count: 2,
      signals: expect.objectContaining({ semantic: true, keyword: false, graph: false }),
    }))
    expect(knowledgeGraph.searchGraphChunks).not.toHaveBeenCalled()
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-direct', factText: 'Pat prefers SMS' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-pat', name: 'Pat' })])
  })

  it('prefilters indexed chunks with OR entity-scope chunk refs', async () => {
    const [firstChunk, secondChunk] = [...adapter._chunks.values()][0]!
    const externalId: ExternalId = { id: 'pat@example.com', type: 'email', identityType: 'user' }
    const knowledgeGraph: KnowledgeGraphBridge = {
      resolveEntityScope: vi.fn().mockResolvedValue({
        entityIds: ['ent-1', 'ent-2'],
        chunkRefs: [
          {
            bucketId: firstChunk!.bucketId,
            sourceId: firstChunk!.sourceId,
            chunkIndex: firstChunk!.chunkIndex,
            embeddingModel: firstChunk!.embeddingModel,
          },
          {
            bucketId: secondChunk!.bucketId,
            sourceId: secondChunk!.sourceId,
            chunkIndex: secondChunk!.chunkIndex,
            embeddingModel: secondChunk!.embeddingModel,
          },
        ],
      }),
      searchKnowledge: vi.fn().mockResolvedValue({ facts: [], entities: [] }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Source', {
      entityScope: { entityIds: ['ent-1', 'ent-2'], externalIds: [externalId] },
      count: 10,
    })
    const searchCall = adapter.calls.find(call => call.method === 'search')

    expect(knowledgeGraph.resolveEntityScope).toHaveBeenCalledWith(
      { entityIds: ['ent-1', 'ent-2'], externalIds: [externalId] },
      expect.anything(),
      expect.anything(),
    )
    expect(searchCall).toBeDefined()
    expect((searchCall!.args[2] as { filter?: unknown }).filter).toEqual(expect.objectContaining({
      chunkRefs: [
        {
          bucketId: firstChunk!.bucketId,
          sourceId: firstChunk!.sourceId,
          chunkIndex: firstChunk!.chunkIndex,
          embeddingModel: firstChunk!.embeddingModel,
        },
        {
          bucketId: secondChunk!.bucketId,
          sourceId: secondChunk!.sourceId,
          chunkIndex: secondChunk!.chunkIndex,
          embeddingModel: secondChunk!.embeddingModel,
        },
      ],
    }))
    expect(response.results.chunks).toHaveLength(2)
    expect(response.results.chunks.map(chunk => `${chunk.source.bucketId}:${chunk.source.id}:${chunk.chunk.index}`)).toEqual(expect.arrayContaining([
      `${firstChunk!.bucketId}:${firstChunk!.sourceId}:${firstChunk!.chunkIndex}`,
      `${secondChunk!.bucketId}:${secondChunk!.sourceId}:${secondChunk!.chunkIndex}`,
    ]))
  })

  it('throws for indexed entity scope without graph scope resolution', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)

    await expect(planner.execute('Source', {
      entityScope: { entityIds: ['ent-1'] },
      count: 1,
    })).rejects.toThrow('entityScope requires a knowledge graph bridge with entity scope resolution.')
  })

  it('allows memory-only entity scope without a knowledge graph bridge', async () => {
    const email: ExternalId = { id: 'pat@example.com', type: 'email', identityType: 'user' }
    const memory: MemoryRecord = {
      id: 'mem-1',
      category: 'semantic',
      status: 'active',
      content: 'Pat prefers SMS for urgent notices',
      importance: 0.8,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: { _similarity: 0.9 },
      scope: { tenantId: 'tenant-1' },
      validAt: new Date(),
      createdAt: new Date(),
    }
    const memoryBridge: MemoryBridge = {
      remember: vi.fn(),
      forget: vi.fn(),
      correct: vi.fn(),
      addConversationTurn: vi.fn(),
      recall: vi.fn().mockResolvedValue([memory]),
      hasMemories: vi.fn().mockResolvedValue(true),
    }
    const planner = new QueryPlanner(adapter, [], new Map(), new Map(), memoryBridge)

    const response = await planner.execute('urgent notices', {
      tenantId: 'tenant-1',
      signals: { semantic: false, keyword: false, memory: true, graph: false },
      entityScope: { externalIds: [email] },
      count: 3,
    })

    expect(memoryBridge.recall).toHaveBeenCalledWith('urgent notices', expect.objectContaining({
      tenantId: 'tenant-1',
      limit: 3,
      entityScope: { externalIds: [email] },
    }))
    expect(response.results.memories).toEqual([expect.objectContaining({
      id: 'mem-1',
      content: 'Pat prefers SMS for urgent notices',
    })])
  })

  it('autoWeights adjusts scoring without enabling graph search', async () => {
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphChunks: vi.fn().mockResolvedValue({
        results: [],
        facts: [],
        entities: [],
        trace: {},
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('how does Tennyson relate to Maud?', {
      autoWeights: true,
      count: 1,
    })

    expect(knowledgeGraph.searchGraphChunks).not.toHaveBeenCalled()
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
  })

  it('returns nonzero graph scores for graph-only chunk graph results', async () => {
    const firstChunk = [...adapter._chunks.values()][0]![0]!
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphChunks: vi.fn().mockResolvedValue({
        results: [{
          chunkId: 'chunk-test',
          content: firstChunk.content,
          bucketId: firstChunk.bucketId,
          sourceId: firstChunk.sourceId,
          chunkIndex: firstChunk.chunkIndex,
          totalChunks: firstChunk.totalChunks,
          score: 0.25,
          metadata: {},
        }],
        facts: [{
          id: 'fact-1',
          edgeId: 'edge-1',
          sourceEntityId: 'ent-1',
          sourceEntityName: 'Tennyson',
          targetEntityId: 'ent-2',
          targetEntityName: 'Maud',
          relation: 'AUTHORED',
          factText: 'Tennyson wrote Maud',
          weight: 1,
          evidenceCount: 1,
        }],
        entities: [{
          id: 'ent-1',
          name: 'Tennyson',
          entityType: 'person',
          aliases: [],
          edgeCount: 1,
        }],
        trace: {
          entitySeedCount: 1,
          factSeedCount: 1,
          chunkSeedCount: 1,
          graphNodeCount: 3,
          graphEdgeCount: 2,
          pprNonzeroCount: 3,
          candidatesBeforeMerge: 1,
          candidatesAfterMerge: 1,
          topGraphScores: [0.25],
          selectedFactIds: ['fact-1'],
          selectedEntityIds: ['ent-1'],
          selectedChunkIds: ['chunk-test'],
        },
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Source 1', {
      signals: { semantic: false, keyword: false, graph: true },
      count: 1,
    })

    expect(response.results.chunks).toHaveLength(1)
    expect(response.results.chunks[0]!.sources).toContain('graph')
    expect(response.results.chunks[0]!.scores.raw.ppr).toBe(0.25)
    expect(response.results.chunks[0]!.scores.normalized.graph).toBeCloseTo(Math.sqrt(Math.sqrt(0.25)))
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', factText: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
    expect(knowledgeGraph.searchGraphChunks).toHaveBeenCalledWith(
      'Source 1',
      expect.anything(),
      expect.objectContaining({
        factFilter: true,
        factCandidateLimit: 80,
        factFilterInputLimit: 12,
        factSeedLimit: 4,
        chunkSeedLimit: 80,
        maxExpansionEdgesPerEntity: 25,
        factChainLimit: 2,
        maxPprIterations: 40,
        minPprScore: 1e-8,
      })
    )
  })

  it('merges graph scores into indexed results by chunk identity', async () => {
    const firstChunk = [...adapter._chunks.values()][0]![0]!
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphChunks: vi.fn().mockResolvedValue({
        results: [{
          chunkId: 'chunk-test',
          content: `${firstChunk.content} with graph-only formatting`,
          bucketId: firstChunk.bucketId,
          sourceId: firstChunk.sourceId,
          chunkIndex: firstChunk.chunkIndex,
          totalChunks: firstChunk.totalChunks,
          score: 0.36,
          metadata: {},
        }],
        facts: [{
          id: 'fact-1',
          edgeId: 'edge-1',
          sourceEntityId: 'ent-1',
          sourceEntityName: 'Tennyson',
          targetEntityId: 'ent-2',
          targetEntityName: 'Maud',
          relation: 'AUTHORED',
          factText: 'Tennyson wrote Maud',
          weight: 1,
          evidenceCount: 1,
        }],
        entities: [{
          id: 'ent-1',
          name: 'Tennyson',
          entityType: 'person',
          aliases: [],
          edgeCount: 1,
        }],
        trace: {
          entitySeedCount: 1,
          factSeedCount: 1,
          chunkSeedCount: 1,
          graphNodeCount: 3,
          graphEdgeCount: 2,
          pprNonzeroCount: 3,
          candidatesBeforeMerge: 1,
          candidatesAfterMerge: 1,
          topGraphScores: [0.36],
          selectedFactIds: ['fact-1'],
          selectedEntityIds: ['ent-1'],
          selectedChunkIds: ['chunk-test'],
        },
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Source 1', {
      signals: { semantic: true, keyword: false, graph: true },
      count: 10,
    })

    const merged = response.results.chunks.find(result =>
      result.source.id === firstChunk.sourceId && result.chunk.index === firstChunk.chunkIndex
    )
    expect(merged).toBeDefined()
    expect(merged!.sources).toContain('graph')
    expect(merged!.scores.raw.ppr).toBe(0.36)
    expect(merged!.scores.normalized.graph).toBeGreaterThan(0)
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', factText: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
  })

  it('surfaces a misconfigured graph bridge when searchGraphChunks is missing', async () => {
    const knowledgeGraph: KnowledgeGraphBridge = {}
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, knowledgeGraph)

    const response = await planner.execute('Source 1', {
      signals: { semantic: false, keyword: false, graph: true },
      count: 1,
    })

    expect(response.results.chunks).toEqual([])
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(response.warnings).toEqual(expect.arrayContaining([
      'Graph search failed: Knowledge graph bridge must implement searchGraphChunks for graph queries.',
    ]))
  })
})
