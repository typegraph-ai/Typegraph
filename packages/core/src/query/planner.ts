import type { Bucket } from '../types/bucket.js'
import type { QueryOpts, QueryResponse, d8umResult } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { GraphBridge } from '../types/graph-bridge.js'
import { IndexedRunner } from './runners/indexed.js'
import { MemoryRunner } from './runners/memory-runner.js'
import { GraphRunner } from './runners/graph-runner.js'
import { mergeAndRank, type NormalizedResult } from './merger.js'
import { classifyQuery } from './classifier.js'

export class QueryPlanner {
  constructor(
    private adapter: VectorStoreAdapter,
    private bucketIds: string[],
    private bucketEmbeddings: Map<string, EmbeddingProvider>,
    private graph?: GraphBridge
  ) {}

  async execute(text: string, opts: QueryOpts = {}): Promise<QueryResponse> {
    const startMs = Date.now()
    const count = opts.count ?? 10
    const tenantId = opts.tenantId
    const resolvedMode = opts.mode === 'auto'
      ? classifyQuery(text)
      : (opts.mode ?? 'hybrid')

    // Filter to requested sources or use all
    const activeBucketIds = opts.buckets
      ? opts.buckets.filter(id => this.bucketIds.includes(id))
      : this.bucketIds

    // Group sources by embedding model
    const modelGroups = new Map<string, { embedding: EmbeddingProvider; bucketIds: string[] }>()
    const warnings: string[] = []

    for (const bucketId of activeBucketIds) {
      const emb = this.bucketEmbeddings.get(bucketId)
      if (!emb) {
        warnings.push(`Bucket "${bucketId}" has no embedding provider - skipped`)
        continue
      }
      const existing = modelGroups.get(emb.model)
      if (existing) {
        existing.bucketIds.push(bucketId)
      } else {
        modelGroups.set(emb.model, { embedding: emb, bucketIds: [bucketId] })
      }
    }

    // Memory-only mode: skip indexed search entirely
    if (resolvedMode === 'memory') {
      if (!this.graph) {
        return {
          results: [],
          buckets: {},
          query: { text, tenantId, durationMs: Date.now() - startMs, mergeStrategy: 'rrf' },
          warnings: ['Memory mode requires a graph bridge. Configure graph in d8umConfig.'],
        }
      }
      const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, sessionId: opts.sessionId }
      const memoryRunner = new MemoryRunner(this.graph)
      const memResults = await memoryRunner.run(text, identity, count)
      const results: d8umResult[] = memResults.map(r => ({
        content: r.content,
        score: r.normalizedScore,
        scores: { memory: r.rawScores.memory, rrf: r.normalizedScore },
        bucket: {
          id: r.bucketId,
          documentId: r.documentId,
          title: r.title ?? '',
          url: r.url,
          updatedAt: r.updatedAt ?? new Date(),
        },
        chunk: r.chunk ?? { index: 0, total: 1, isNeighbor: false },
        metadata: r.metadata,
        tenantId: r.tenantId,
      }))
      return {
        results,
        buckets: { __memory__: { mode: 'cached', resultCount: results.length, durationMs: Date.now() - startMs, status: 'ok' } },
        query: { text, tenantId, durationMs: Date.now() - startMs, mergeStrategy: 'rrf' },
      }
    }

    // Run indexed search
    const bucketTimings: QueryResponse['buckets'] = {}
    let allResults: NormalizedResult[] = []

    if (modelGroups.size > 0) {
      const runnerStart = Date.now()
      const runner = new IndexedRunner(this.adapter)
      const vectorOnly = resolvedMode === 'fast'
      const results = await runner.run(text, modelGroups, count, tenantId, opts.documentFilter, vectorOnly)
      const runnerDuration = Date.now() - runnerStart

      for (const bucketId of activeBucketIds) {
        const sourceResults = results.filter(r => r.bucketId === bucketId)
        bucketTimings[bucketId] = {
          mode: 'indexed',
          resultCount: sourceResults.length,
          durationMs: runnerDuration,
          status: 'ok',
        }
      }

      allResults = results
    }

    // Neural mode: also run memory + graph runners in parallel
    const runnerArrays: NormalizedResult[][] = [allResults]
    if (resolvedMode === 'neural' && this.graph) {
      const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, sessionId: opts.sessionId }

      // Skip memory runner if store has no memories (avoids empty table query per query)
      const skipMemory = this.graph.hasMemories ? !(await this.graph.hasMemories()) : false
      const memoryPromise = skipMemory
        ? Promise.resolve([] as NormalizedResult[])
        : new MemoryRunner(this.graph).run(text, identity, count).catch(() => [] as NormalizedResult[])

      // 30s timeout on graph runner: if a DB call hangs (e.g., Neon connection stall),
      // fall back to empty results so the query proceeds with indexed results only.
      let graphTimer: ReturnType<typeof setTimeout> | undefined
      const graphPromise = Promise.race([
        new GraphRunner(this.graph).run(text, identity, count),
        new Promise<NormalizedResult[]>(resolve => { graphTimer = setTimeout(() => resolve([]), 30_000) }),
      ]).then(r => { clearTimeout(graphTimer); return r })
        .catch(() => { clearTimeout(graphTimer); return [] as NormalizedResult[] })

      const [memResults, graphResults] = await Promise.all([
        memoryPromise,
        graphPromise,
      ])

      if (memResults.length > 0) {
        runnerArrays.push(memResults)
        bucketTimings['__memory__'] = { mode: 'cached', resultCount: memResults.length, durationMs: Date.now() - startMs, status: 'ok' }
      }
      if (graphResults.length > 0) {
        // Graph as reranker: boost indexed results that also appear in graph output.
        // Graph PPR chunks are too noisy to compete as a separate RRF runner, but
        // overlap with indexed results is a strong relevance signal worth amplifying.
        const graphContentRank = new Map<string, number>()
        for (let i = 0; i < graphResults.length; i++) {
          if (!graphContentRank.has(graphResults[i]!.content)) {
            graphContentRank.set(graphResults[i]!.content, i)
          }
        }

        // Rank-decaying multiplicative boost: graph rank 0 → 1.10×, rank 9 → 1.04×
        const BOOST_MAX = 0.1
        const DECAY = 0.15
        for (const r of allResults) {
          const graphRank = graphContentRank.get(r.content)
          if (graphRank !== undefined) {
            r.normalizedScore *= 1 + BOOST_MAX / (1 + graphRank * DECAY)
          }
        }

        // Re-sort so boosted order is respected in RRF rank positions
        allResults.sort((a, b) => b.normalizedScore - a.normalizedScore)

        bucketTimings['__graph__'] = { mode: 'cached', resultCount: graphResults.length, durationMs: Date.now() - startMs, status: 'ok' }
      }
    }

    // Merge and rank
    const weights = opts.mergeWeights
      ? Object.fromEntries(
          Object.entries(opts.mergeWeights).filter((e): e is [string, number] => e[1] != null)
        )
      : undefined
    const needsMerge = runnerArrays.length > 1 || modelGroups.size > 1
    const mergedResults = needsMerge
      ? mergeAndRank(runnerArrays, count, weights)
      : allResults.slice(0, count)

    // Map NormalizedResult → d8umResult
    const results: d8umResult[] = mergedResults.map(r => ({
      content: r.content,
      score: r.normalizedScore,
      scores: {
        vector: r.rawScores.vector,
        keyword: r.rawScores.keyword,
        rrf: r.normalizedScore,
      },
      bucket: {
        id: r.bucketId,
        documentId: r.documentId,
        title: r.title ?? '',
        url: r.url,
        updatedAt: r.updatedAt ?? new Date(),
        status: r.documentStatus,
        scope: r.documentScope,
        documentType: r.documentType,
        sourceType: r.sourceType,
        userId: r.userId,
        groupId: r.groupId,
      },
      chunk: r.chunk ?? { index: 0, total: 1, isNeighbor: false },
      metadata: r.metadata,
      tenantId: r.tenantId,
    }))

    return {
      results,
      buckets: bucketTimings,
      query: {
        text,
        tenantId,
        durationMs: Date.now() - startMs,
        mergeStrategy: opts.mergeStrategy ?? 'rrf',
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }
}
