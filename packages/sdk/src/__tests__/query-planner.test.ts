import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryPlanner } from '../query/planner.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-document.js'
import { createTestDocuments } from './helpers/mock-connector.js'
import { IndexEngine } from '../index-engine/engine.js'
import { defaultChunker } from '../index-engine/chunker.js'
import type { Embedder } from '../embedding/provider.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { typegraphEvent, typegraphEventSink } from '../types/events.js'
import type { Reranker } from '../types/extractor.js'
import type { QueryChunkResult } from '../types/query.js'
import type { typegraphLogger } from '../types/logger.js'

function chunkKey(chunk: QueryChunkResult): string {
  return `${chunk.document.bucketId}:${chunk.document.id}:${chunk.chunk.index}`
}

function createTestLogger(): typegraphLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

describe('QueryPlanner', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let bucketIds: string[]
  let bucketEmbeddings: Map<string, Embedder>

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    bucketIds = []
    bucketEmbeddings = new Map()

    const documents = createTestDocuments(3)
    const { bucket, ingestOptions, chunkOpts } = createMockBucket({ id: 'src-1', documents: documents })
    bucketIds.push(bucket.id)
    bucketEmbeddings.set(bucket.id, embedding)

    await adapter.deploy()
    await adapter.connect()
    const engine = new IndexEngine(adapter, embedding)
    const items = await Promise.all(documents.map(async document => ({ document, chunks: await defaultChunker(document, chunkOpts) })))
    await engine.ingestBatch(bucket.id, items, { tenantId: 'tenant-1', ...ingestOptions })
  })

  it('returns results for indexed documents', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Documents 1')
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.content).toBeDefined()
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
  })

  it('treats null execute opts as omitted', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Documents 1', null)

    expect(response.results.chunks.length).toBeGreaterThan(0)
  })

  it('respects count', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test query', { limit: 1 })
    expect(response.results.chunks).toHaveLength(1)
  })

  it('warns and returns normal results when rerank is requested without a reranker', async () => {
    const logger = createTestLogger()
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, logger)

    const response = await planner.execute('Documents 1', { limit: 2, rerank: true, explain: true })

    expect(response.results.chunks).toHaveLength(2)
    expect(response.query.mergeStrategy).toBe('rrf')
    expect(response.warnings).toEqual(expect.arrayContaining([
      'Search rerank was requested but no reranker is configured; returning non-reranked results.',
    ]))
    expect(logger.warn).toHaveBeenCalledWith('Search rerank was requested but no reranker is configured; returning non-reranked results.')
    expect(response.explanation?.rerank).toMatchObject({
      requested: true,
      applied: false,
      topK: 2,
      finalCount: 2,
    })
  })

  it('passes QueryChunkResult candidates and rerank options to the configured reranker', async () => {
    const abortController = new AbortController()
    const reranker: Reranker<QueryChunkResult> = {
      name: 'reverse-reranker',
      rerank: vi.fn(async (_query, candidates) => [...candidates].reverse()),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', {
      limit: 1,
      rerank: { topK: 2 },
      abortSignal: abortController.signal,
      explain: true,
    })
    const rerankCall = vi.mocked(reranker.rerank).mock.calls[0]!
    const candidates = rerankCall[1]

    expect(reranker.rerank).toHaveBeenCalledWith('Documents', expect.any(Array), {
      topK: 2,
      abortSignal: abortController.signal,
    })
    expect(candidates.length).toBeGreaterThan(response.results.chunks.length)
    expect(candidates[0]).toHaveProperty('content')
    expect(candidates[0]).toHaveProperty('document.id')
    expect(candidates[0]).toHaveProperty('chunk.index')
    expect(response.query.mergeStrategy).toBe('rrf+rerank')
    expect(response.explanation?.rerank).toMatchObject({
      requested: true,
      applied: true,
      reranker: 'reverse-reranker',
      topK: 2,
      candidateCount: candidates.length,
      finalCount: 1,
    })
  })

  it('reranks chunk order while preserving the final limit and fused scores', async () => {
    let seenCandidates: QueryChunkResult[] = []
    const reranker: Reranker<QueryChunkResult> = {
      name: 'reverse-reranker',
      rerank: vi.fn(async (_query, candidates) => {
        seenCandidates = [...candidates]
        return [...candidates].reverse()
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { limit: 1, rerank: true })

    expect(response.results.chunks).toHaveLength(1)
    expect(chunkKey(response.results.chunks[0]!)).toBe(chunkKey(seenCandidates.at(-1)!))
    expect(response.results.chunks[0]!.score).toBe(1)
    expect(response.results.chunks[0]!.scores.output.reranker).toBe(1)
    expect(response.results.chunks[0]!.scores.output.fused).toBeDefined()
  })

  it('preserves normalized provider reranker scores and marks their source', async () => {
    const reranker: Reranker<QueryChunkResult> = {
      name: 'scored-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates.slice(0, 2).map((candidate, index) => ({
        candidate,
        score: index === 0 ? 0.93 : 0.41,
      }))),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { limit: 2, rerank: true, explain: true })

    expect(response.results.chunks.map(chunk => chunk.score)).toEqual([0.93, 0.41])
    expect(response.results.chunks[0]!.scores.raw.reranker).toBe(0.93)
    expect(response.results.chunks[0]!.scores.output.reranker).toBe(0.93)
    expect(response.results.chunks[0]!.scores.output.fused).toBeDefined()
    expect(response.query.scoreSource).toBe('provider')
    expect(response.explanation?.rerank?.scoreSource).toBe('provider')
  })

  it('runs fanout passes concurrently and reranks every pass against canonical intent without a final rerank', async () => {
    let activeReranks = 0
    let maxActiveReranks = 0
    let rerankPass = 0
    const abortController = new AbortController()
    const asOf = new Date('2030-01-01T00:00:00.000Z')
    const documentIds = [...adapter._documents.values()].map(document => document.id)
    const events: typegraphEvent[] = []
    const eventSink: typegraphEventSink = {
      emit: event => { events.push(event) },
    }
    const reranker: Reranker<QueryChunkResult> = {
      name: 'fanout-reranker',
      rerank: vi.fn(async (_query, candidates) => {
        const pass = rerankPass++
        activeReranks += 1
        maxActiveReranks = Math.max(maxActiveReranks, activeReranks)
        await new Promise(resolve => setTimeout(resolve, 10))
        activeReranks -= 1
        const stableCandidates = [...candidates].sort((a, b) => chunkKey(a).localeCompare(chunkKey(b)))
        return stableCandidates.slice(0, 2).map((candidate, index) => ({
          candidate,
          score: Math.max(0, [0.5, 0.9, 0.8][pass]! - index * 0.2),
        }))
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, eventSink, undefined, 'tenant-1', reranker)
    adapter.calls.length = 0

    const response = await planner.execute('canonical customer intent', {
      subqueries: ['supplement alpha', 'supplement beta', '  SUPPLEMENT ALPHA  ', 'canonical customer intent'],
      limit: 2,
      rerank: { topK: 2, query: 'canonical customer intent' },
      abortSignal: abortController.signal,
      documentFilter: { documentIds },
      asOf,
      explain: true,
    })

    expect(reranker.rerank).toHaveBeenCalledTimes(3)
    expect(vi.mocked(reranker.rerank).mock.calls.map(call => call[0])).toEqual([
      'canonical customer intent',
      'canonical customer intent',
      'canonical customer intent',
    ])
    expect(maxActiveReranks).toBeGreaterThan(1)
    expect(adapter.calls.filter(call => call.method === 'searchWithDocuments').map(call => call.args[2])).toEqual(expect.arrayContaining([
      'canonical customer intent',
      'supplement alpha',
      'supplement beta',
    ]))
    for (const call of adapter.calls.filter(call => call.method === 'searchWithDocuments')) {
      expect(call.args[3]).toMatchObject({
        documentFilter: { documentIds },
        temporalAt: asOf,
      })
    }
    for (const call of vi.mocked(reranker.rerank).mock.calls) {
      expect(call[2]?.abortSignal).toBe(abortController.signal)
    }
    expect(response.results.chunks).toHaveLength(2)
    expect(response.explanation?.fanout?.preDeduplicationCount).toBeLessThanOrEqual(6)
    expect(response.explanation?.fanout?.mergeStrategy).toBe('fanout-provider-score')
    expect(response.results.chunks[0]!.score).toBe(0.9)
    expect(response.results.chunks[0]!.queryMatches?.length).toBeGreaterThanOrEqual(2)
    expect(response.query.retrievalQueries).toEqual([
      'canonical customer intent',
      'supplement alpha',
      'supplement beta',
    ])
    const queryEvents = events.filter(event => event.eventType === 'query.execute')
    expect(queryEvents).toHaveLength(1)
    expect(events.map(event => event.eventType)).toEqual(['query.execute'])
    expect(queryEvents[0]!.payload).toMatchObject({
      query: 'canonical customer intent',
      fanout: true,
      merge_strategy: 'fanout-provider-score',
      result_count: 2,
    })
    expect(JSON.stringify(queryEvents[0]!.payload)).not.toContain(response.results.chunks[0]!.content)
  })

  it('uses deterministic position merging for legacy plain-array rerankers', async () => {
    const reranker: Reranker<QueryChunkResult> = {
      name: 'legacy-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates.slice(0, 2).reverse()),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('canonical intent', {
      subqueries: ['supplemental intent'],
      limit: 2,
      rerank: { topK: 2, query: 'canonical intent' },
      explain: true,
    })

    expect(reranker.rerank).toHaveBeenCalledTimes(2)
    expect(response.query.mergeStrategy).toBe('fanout-rrf-position')
    expect(response.query.scoreSource).toBe('position')
    expect(response.explanation?.fanout?.scoreSource).toBe('position')
    expect(response.results.chunks.every(chunk => (chunk.queryMatches?.length ?? 0) > 0)).toBe(true)
  })

  it('excludes a failed supplemental pass and merges successful canonical reranks', async () => {
    const originalSearchWithDocuments = adapter.searchWithDocuments!.bind(adapter)
    adapter.searchWithDocuments = async (model, queryEmbedding, query, searchOpts) => {
      if (query === 'broken supplement') throw new Error('supplement unavailable')
      return originalSearchWithDocuments(model, queryEmbedding, query, searchOpts)
    }
    const reranker: Reranker<QueryChunkResult> = {
      name: 'scored-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates.slice(0, 2).map((candidate, index) => ({
        candidate,
        score: 0.9 - index * 0.2,
      }))),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('canonical intent', {
      subqueries: ['broken supplement', 'working supplement'],
      limit: 2,
      rerank: { topK: 2, query: 'canonical intent' },
      explain: true,
    })

    expect(reranker.rerank).toHaveBeenCalledTimes(2)
    expect(response.results.chunks).toHaveLength(2)
    expect(response.explanation?.fanout?.passes).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: 'broken supplement', status: 'rejected', error: 'supplement unavailable' }),
      expect.objectContaining({ query: 'working supplement', status: 'fulfilled', scoreSource: 'provider' }),
    ]))
    expect(response.warnings).toContain('Search pass failed for "broken supplement": supplement unavailable')
  })

  it('merges canonically reranked supplements when the primary search fails', async () => {
    const originalSearchWithDocuments = adapter.searchWithDocuments!.bind(adapter)
    adapter.searchWithDocuments = async (model, queryEmbedding, query, searchOpts) => {
      if (query === 'broken primary') throw new Error('primary unavailable')
      return originalSearchWithDocuments(model, queryEmbedding, query, searchOpts)
    }
    const reranker: Reranker<QueryChunkResult> = {
      name: 'scored-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates.slice(0, 2).map((candidate, index) => ({
        candidate,
        score: 0.8 - index * 0.2,
      }))),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('broken primary', {
      subqueries: ['working supplement one', 'working supplement two'],
      limit: 2,
      rerank: { topK: 2, query: 'broken primary' },
      explain: true,
    })

    expect(reranker.rerank).toHaveBeenCalledTimes(2)
    expect(vi.mocked(reranker.rerank).mock.calls.map(call => call[0])).toEqual([
      'broken primary',
      'broken primary',
    ])
    expect(response.results.chunks).toHaveLength(2)
    expect(response.query.canonicalQuery).toBe('broken primary')
    expect(response.explanation?.fanout?.passes[0]).toMatchObject({
      query: 'broken primary',
      kind: 'primary',
      status: 'rejected',
    })
  })

  it('falls back to legacy positional scores when scored reranker values are invalid', async () => {
    const reranker: Reranker<QueryChunkResult> = {
      name: 'invalid-scored-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates.slice(0, 2).map((candidate, index) => ({
        candidate,
        score: index === 0 ? Number.NaN : 1.2,
      }))),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { limit: 2, rerank: true, explain: true })

    expect(response.query.scoreSource).toBe('position')
    expect(response.explanation?.rerank?.scoreSource).toBe('position')
    expect(response.results.chunks[0]!.scores.raw.reranker).toBeUndefined()
    expect(response.results.chunks[0]!.scores.output.reranker).toBe(1)
  })

  it('overfetches candidates before reranking with the capped 3x policy', async () => {
    let candidateCount = 0
    const reranker: Reranker<QueryChunkResult> = {
      name: 'counting-reranker',
      rerank: vi.fn(async (_query, candidates) => {
        candidateCount = candidates.length
        return candidates
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { limit: 1, rerank: { topK: 1 }, explain: true })

    expect(candidateCount).toBeGreaterThan(response.results.chunks.length)
    expect(response.results.chunks).toHaveLength(1)
    expect(response.explanation?.rerank?.candidateCount).toBe(candidateCount)
    expect(response.explanation?.rerank?.finalCount).toBe(1)
  })

  it('uses rerank topK as the final count when limit is omitted', async () => {
    const reranker: Reranker<QueryChunkResult> = {
      name: 'identity-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { rerank: { topK: 2 }, explain: true })

    expect(response.results.chunks).toHaveLength(2)
    expect(response.explanation?.rerank).toMatchObject({
      topK: 2,
      finalCount: 2,
    })
  })

  it('warns and falls back to pre-rerank results when the reranker throws', async () => {
    const logger = createTestLogger()
    const baselinePlanner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const baseline = await baselinePlanner.execute('Documents', { limit: 2 })
    const reranker: Reranker<QueryChunkResult> = {
      name: 'failing-reranker',
      rerank: vi.fn(async () => {
        throw new Error('reranker unavailable')
      }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, logger, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { limit: 2, rerank: true, explain: true })

    expect(response.results.chunks.map(chunkKey)).toEqual(baseline.results.chunks.map(chunkKey))
    expect(response.query.mergeStrategy).toBe('rrf')
    expect(response.results.chunks[0]!.scores.output.reranker).toBeUndefined()
    expect(response.warnings?.[0]).toContain('Search reranker failed: reranker unavailable')
    expect(logger.warn).toHaveBeenCalledWith('Search reranker failed: reranker unavailable; returning non-reranked results.')
    expect(response.explanation?.rerank).toMatchObject({
      requested: true,
      applied: false,
      reranker: 'failing-reranker',
    })
  })

  it('deduplicates reranker output, ignores unknown candidates, and appends omitted candidates', async () => {
    const reranker: Reranker<QueryChunkResult> = {
      name: 'messy-reranker',
      rerank: vi.fn(async (_query, candidates) => [
        { ...candidates[0]!, document: { ...candidates[0]!.document, id: 'unknown-document' } },
        candidates[1]!,
        candidates[1]!,
      ]),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents', { limit: 3, rerank: true })
    const candidates = vi.mocked(reranker.rerank).mock.calls[0]![1]

    expect(response.results.chunks.map(chunkKey)).toEqual([
      chunkKey(candidates[1]!),
      chunkKey(candidates[0]!),
      chunkKey(candidates[2]!),
    ])
  })

  it('runs true keyword-only indexed search when semantic is explicitly disabled', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    adapter.calls.length = 0

    const response = await planner.execute('Documents 1', {
      resources: ['documents'],
      weights: { semantic: false, bm25: 1, graph: false, recency: false },
      limit: 2,
    })

    const searchCall = adapter.calls.find(call => call.method === 'searchWithDocuments')
    expect(searchCall).toBeDefined()
    expect((searchCall!.args[3] as { retrieval?: unknown }).retrieval).toEqual({ semantic: false, keyword: true })
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.chunks[0]!.matchedBy).toContain('bm25')
    expect(response.results.chunks[0]!.matchedBy).not.toContain('semantic')
    expect(response.results.chunks[0]!.scores.normalized.semantic).toBeUndefined()
    expect(response.results.chunks[0]!.scores.normalized.keyword).toBeGreaterThan(0)
  })

  it('filters to requested documents', async () => {
    const docs2 = createTestDocuments(2, 'Other')
    const { bucket: bucket2, ingestOptions: ingestOptions2, chunkOpts: chunkOpts2 } = createMockBucket({ id: 'src-2', documents: docs2 })
    bucketIds.push(bucket2.id)
    bucketEmbeddings.set(bucket2.id, embedding)
    const engine = new IndexEngine(adapter, embedding)
    const items = await Promise.all(docs2.map(async document => ({ document, chunks: await defaultChunker(document, chunkOpts2) })))
    await engine.ingestBatch(bucket2.id, items, { tenantId: 'tenant-1', ...ingestOptions2 })

    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test', { buckets: ['src-1'] })
    for (const r of response.results.chunks) {
      expect(r.document.bucketId).toBe('src-1')
    }
  })

  it('records per-document timings', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('test')
    expect(response.buckets['src-1']).toBeDefined()
    expect(response.buckets['src-1']!.durationMs).toBeGreaterThanOrEqual(0)
    expect(response.buckets['src-1']!.status).toBe('ok')
  })

  it('returns empty results when no documents', async () => {
    const planner = new QueryPlanner(adapter, [], new Map(), new Map())
    const response = await planner.execute('test')
    expect(response.results.chunks).toHaveLength(0)
    expect(response.results.facts).toHaveLength(0)
    expect(response.results.entities).toHaveLength(0)
  })

  it('does not expose tenantId in the public search response', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, undefined, undefined, 'tenant-1')
    const response = await planner.execute('test')
    expect('tenantId' in response.query).toBe(false)
  })

  it('emits query.execute with structured snake_case result counters', async () => {
    const events: typegraphEvent[] = []
    const eventSink: typegraphEventSink = {
      emit: (event) => {
        events.push(event)
      },
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, undefined, eventSink)

    const response = await planner.execute('Documents 1', { limit: 2 })
    const queryEvents = events.filter(event => event.eventType === 'query.execute')

    expect(queryEvents).toHaveLength(1)
    expect(queryEvents[0]!.payload).toMatchObject({
      query: 'Documents 1',
      requested_count: 2,
      result_count: response.results.chunks.length,
      chunk_count: response.results.chunks.length,
      fact_count: 0,
      entity_count: 0,
      bucket_count: bucketIds.length,
      requested_graph: 'public',
      graph_closure: ['public'],
      active_bucket_ids: bucketIds,
    })
    expect(queryEvents[0]!.payload).not.toHaveProperty('resultCount')
    expect(queryEvents[0]!.payload).not.toHaveProperty('bucketCount')
  })

  it('maps results to structured query response shape', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Documents 1')
    expect(response.results).toHaveProperty('chunks')
    expect(response.results).toHaveProperty('facts')
    expect(response.results).toHaveProperty('entities')
    const result = response.results.chunks[0]!
    expect(result).toHaveProperty('content')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('scores')
    expect(result).toHaveProperty('document')
    expect(result).toHaveProperty('chunk')
    expect(result).toHaveProperty('metadata')
    expect(result).not.toHaveProperty('facts')
    expect(result).not.toHaveProperty('entities')
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(result.document).toHaveProperty('id')
    expect(result.document).toHaveProperty('bucketId')
    expect(result.chunk).toHaveProperty('index')
    expect(result.chunk).toHaveProperty('total')
  })

  it('uses "semantic" document label for indexed results', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)
    const response = await planner.execute('Documents 1')
    const result = response.results.chunks[0]!
    expect(result.matchedBy).toContain('semantic')
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
      description: 'Pat prefers SMS',
      weight: 1,
      
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
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph)

    const response = await planner.execute('sms', {
      resources: ['documents', 'facts', 'entities'],
      weights: { bm25: false, graph: false, recency: false },
      limit: 2,
    })

    expect(knowledgeGraph.searchKnowledge).toHaveBeenCalledWith('sms', expect.anything(), expect.objectContaining({
      count: 2,
      retrieval: expect.objectContaining({ semantic: true, keyword: false }),
    }))
    expect(knowledgeGraph.searchGraphChunks).not.toHaveBeenCalled()
    expect(response.results.chunks.length).toBeGreaterThan(0)
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-direct', description: 'Pat prefers SMS' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-pat', name: 'Pat' })])
  })

  it('prefilters indexed chunks with OR entity-scope chunk refs', async () => {
    const [firstChunk, secondChunk] = [...adapter._chunks.values()][0]!
    const externalId = { id: 'pat@example.com', type: 'email' }
    const knowledgeGraph: KnowledgeGraphBridge = {
      resolveEntityScope: vi.fn().mockResolvedValue({
        entityIds: ['ent-1', 'ent-2'],
        chunkRefs: [
          {
            bucketId: firstChunk!.bucketId,
            documentId: firstChunk!.documentId,
            chunkIndex: firstChunk!.chunkIndex,
            embeddingModel: firstChunk!.embeddingModel,
          },
          {
            bucketId: secondChunk!.bucketId,
            documentId: secondChunk!.documentId,
            chunkIndex: secondChunk!.chunkIndex,
            embeddingModel: secondChunk!.embeddingModel,
          },
        ],
      }),
      searchKnowledge: vi.fn().mockResolvedValue({ facts: [], entities: [] }),
    }
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph)

    const response = await planner.execute('Documents', {
      entityScope: { entityIds: ['ent-1', 'ent-2'], externalIds: [externalId] },
      limit: 10,
    })
    const searchCall = adapter.calls.find(call => call.method === 'searchWithDocuments')

    expect(knowledgeGraph.resolveEntityScope).toHaveBeenCalledWith(
      { entityIds: ['ent-1', 'ent-2'], externalIds: [externalId] },
      expect.anything(),
      expect.anything(),
    )
    expect(searchCall).toBeDefined()
    expect((searchCall!.args[3] as { filter?: unknown }).filter).toEqual(expect.objectContaining({
      chunkRefs: [
        {
          bucketId: firstChunk!.bucketId,
          documentId: firstChunk!.documentId,
          chunkIndex: firstChunk!.chunkIndex,
          embeddingModel: firstChunk!.embeddingModel,
        },
        {
          bucketId: secondChunk!.bucketId,
          documentId: secondChunk!.documentId,
          chunkIndex: secondChunk!.chunkIndex,
          embeddingModel: secondChunk!.embeddingModel,
        },
      ],
    }))
    expect(response.results.chunks).toHaveLength(2)
    expect(response.results.chunks.map(chunk => `${chunk.document.bucketId}:${chunk.document.id}:${chunk.chunk.index}`)).toEqual(expect.arrayContaining([
      `${firstChunk!.bucketId}:${firstChunk!.documentId}:${firstChunk!.chunkIndex}`,
      `${secondChunk!.bucketId}:${secondChunk!.documentId}:${secondChunk!.chunkIndex}`,
    ]))
  })

  it('throws for indexed entity scope without graph scope resolution', async () => {
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings)

    await expect(planner.execute('Documents', {
      entityScope: { entityIds: ['ent-1'] },
      limit: 1,
    })).rejects.toThrow('entityScope requires a knowledge graph bridge with entity scope resolution.')
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
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph)

    const response = await planner.execute('how does Tennyson relate to Maud?', {
      autoWeights: true,
      resources: ['documents'],
      limit: 1,
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
          documentId: firstChunk.documentId,
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
          description: 'Tennyson wrote Maud',
          weight: 1,
          
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
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph)

    const response = await planner.execute('Documents 1', {
      resources: ['entities', 'facts'],
      weights: { semantic: false, bm25: false, graph: 1, recency: false },
      limit: 1,
    })

    expect(response.results.chunks).toHaveLength(1)
    expect(response.results.chunks[0]!.matchedBy).toContain('graph')
    expect(response.results.chunks[0]!.scores.raw.ppr).toBe(0.25)
    expect(response.results.chunks[0]!.scores.normalized.graph).toBeCloseTo(Math.sqrt(Math.sqrt(0.25)))
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', description: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
    expect(knowledgeGraph.searchGraphChunks).toHaveBeenCalledWith(
      'Documents 1',
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
          documentId: firstChunk.documentId,
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
          description: 'Tennyson wrote Maud',
          weight: 1,
          
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
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph)

    const response = await planner.execute('Documents 1', {
      resources: ['documents', 'entities', 'facts'],
      weights: { bm25: false, graph: 1, recency: false },
      limit: 10,
    })

    const merged = response.results.chunks.find(result =>
      result.document.id === firstChunk.documentId && result.chunk.index === firstChunk.chunkIndex
    )
    expect(merged).toBeDefined()
    expect(merged!.matchedBy).toContain('graph')
    expect(merged!.scores.raw.ppr).toBe(0.36)
    expect(merged!.scores.normalized.graph).toBeGreaterThan(0)
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', description: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
  })

  it('reranks mixed indexed and graph chunk results without dropping facts or entities', async () => {
    const firstChunk = [...adapter._chunks.values()][0]![0]!
    const reranker: Reranker<QueryChunkResult> = {
      name: 'identity-reranker',
      rerank: vi.fn(async (_query, candidates) => candidates),
    }
    const knowledgeGraph: KnowledgeGraphBridge = {
      searchGraphChunks: vi.fn().mockResolvedValue({
        results: [{
          chunkId: 'chunk-test',
          content: firstChunk.content,
          bucketId: firstChunk.bucketId,
          documentId: firstChunk.documentId,
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
          description: 'Tennyson wrote Maud',
          weight: 1,
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
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph, undefined, undefined, 'tenant-1', reranker)

    const response = await planner.execute('Documents 1', {
      resources: ['documents', 'entities', 'facts'],
      weights: { bm25: false, graph: 1, recency: false },
      limit: 1,
      rerank: true,
    })

    expect(reranker.rerank).toHaveBeenCalled()
    expect(response.query.mergeStrategy).toBe('rrf+rerank')
    expect(response.results.chunks).toHaveLength(1)
    expect(response.results.facts).toEqual([expect.objectContaining({ id: 'fact-1', description: 'Tennyson wrote Maud' })])
    expect(response.results.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Tennyson' })])
  })

  it('surfaces a misconfigured graph bridge when searchGraphChunks is missing', async () => {
    const knowledgeGraph: KnowledgeGraphBridge = {}
    const planner = new QueryPlanner(adapter, bucketIds, bucketEmbeddings, bucketEmbeddings, knowledgeGraph)

    const response = await planner.execute('Documents 1', {
      resources: ['entities', 'facts'],
      weights: { semantic: false, bm25: false, graph: 1, recency: false },
      limit: 1,
    })

    expect(response.results.chunks).toEqual([])
    expect(response.results.facts).toEqual([])
    expect(response.results.entities).toEqual([])
    expect(response.warnings).toEqual(expect.arrayContaining([
      'Graph search failed: Knowledge graph bridge must implement searchGraphChunks for graph queries.',
    ]))
  })
})
