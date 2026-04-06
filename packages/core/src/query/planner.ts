import type { Bucket } from '../types/bucket.js'
import type { QueryOpts, QueryResponse, d8umResult, RawScores, NormalizedScores } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { GraphBridge } from '../types/graph-bridge.js'
import type { d8umEvent, d8umEventSink } from '../types/events.js'
import { IndexedRunner } from './runners/indexed.js'
import { MemoryRunner } from './runners/memory-runner.js'
import { GraphRunner } from './runners/graph-runner.js'
import { mergeAndRank, normalizeRRF, normalizePPR, type NormalizedResult } from './merger.js'
import { classifyQuery } from './classifier.js'

export class QueryPlanner {
  constructor(
    private adapter: VectorStoreAdapter,
    private bucketIds: string[],
    private bucketEmbeddings: Map<string, EmbeddingProvider>,
    private graph?: GraphBridge,
    private eventSink?: d8umEventSink
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
      const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }
      const memoryRunner = new MemoryRunner(this.graph)
      const memResults = await memoryRunner.run(text, identity, count)
      const results: d8umResult[] = memResults.map(r => {
        const importanceScore = r.rawScores.memory ?? r.normalizedScore
        return {
          content: r.content,
          score: importanceScore,
          scores: {
            raw: { importance: importanceScore },
            normalized: { memory: importanceScore },
          },
          sources: ['memory'],
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
        }
      })
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
      const runner = new IndexedRunner(this.adapter, this.eventSink)
      const vectorOnly = resolvedMode === 'fast'
      const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }
      const results = await runner.run(text, modelGroups, count, identity, opts.documentFilter, vectorOnly, opts.traceId, opts.spanId)
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
      const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }

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
        // Score memories with vector similarity so they compete on the same
        // dimensions as documents (semantic, rrf) instead of only importance.
        const firstEmb = [...this.bucketEmbeddings.values()][0]
        if (firstEmb) {
          try {
            const queryEmbedding = await firstEmb.embed(text)
            for (const mem of memResults) {
              const memEmbedding = await firstEmb.embed(mem.content)
              const similarity = dotProduct(queryEmbedding, memEmbedding)
              mem.rawScores.vector = similarity
              mem.normalizedScore = similarity
            }
          } catch {
            // Embedding failed — memories still compete via importance + RRF
          }
        }
        runnerArrays.push(memResults)
        bucketTimings['__memory__'] = { mode: 'cached', resultCount: memResults.length, durationMs: Date.now() - startMs, status: 'ok' }
      }
      if (graphResults.length > 0) {
        // Reinforcement-only: keep graph results whose content matches an indexed result.
        // Graph retrieves from the same chunk pool as indexed search — novel graph results
        // are noise that displaces better-ranked indexed chunks from top-K.
        if (allResults.length > 0) {
          const indexedContent = new Set(allResults.map(r => r.content))
          const reinforcing = graphResults.filter(r => indexedContent.has(r.content))
          if (reinforcing.length > 0) {
            runnerArrays.push(reinforcing)
          }
        } else {
          runnerArrays.push(graphResults)
        }
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

    // Map NormalizedResult → d8umResult with raw/normalized score structure
    const results: d8umResult[] = mergedResults.map(r => {
      const merged = r as any

      // Get aggregated raw scores (from merger if merged, raw if not)
      const agg = merged.rawScores ?? r.rawScores
      const rawRrf = merged.finalScore ?? agg.rrf ?? r.normalizedScore

      // Build raw scores (algorithm-level, mixed ranges)
      const rawScores: RawScores = {}
      // Build normalized scores (capability-level, all 0-1)
      const normalizedScores: NormalizedScores = {}

      if (resolvedMode === 'fast') {
        rawScores.cosineSimilarity = agg.vector
        normalizedScores.semantic = agg.vector ?? 0
      } else {
        // hybrid or neural — always have vector, keyword, rrf
        rawScores.cosineSimilarity = agg.vector
        rawScores.bm25 = agg.keyword
        rawScores.rrf = rawRrf
        normalizedScores.semantic = agg.vector ?? 0
        normalizedScores.keyword = agg.keyword ?? 0
        // For non-merge path, RRF comes from adapter (2 lists: vector+keyword)
        // For merge path, RRF comes from merger (numLists runners)
        const numListsForRRF = merged.compositeScore != null ? runnerArrays.length : 2
        normalizedScores.rrf = normalizeRRF(rawRrf, numListsForRRF)

        if (resolvedMode === 'neural') {
          rawScores.ppr = agg.graph
          rawScores.importance = agg.memory
          normalizedScores.graph = normalizePPR(agg.graph ?? 0)
          normalizedScores.memory = agg.memory ?? 0
        }
      }

      // Compute top-level composite score (always 0-1)
      let topScore: number
      if (merged.compositeScore != null) {
        // From mergeAndRank (multi-runner merge)
        topScore = merged.compositeScore
      } else if (resolvedMode === 'fast') {
        topScore = normalizedScores.semantic!
      } else {
        // Non-merge hybrid path
        const nRRF = normalizedScores.rrf!
        const semantic = normalizedScores.semantic ?? 0
        const kw = normalizedScores.keyword ?? 0
        topScore = 0.4 * nRRF + 0.5 * semantic + 0.1 * kw
      }

      // Sources: which retrieval systems contributed
      const sources: string[] = merged.modes ?? [r.mode]

      return {
        content: r.content,
        score: topScore,
        scores: { raw: rawScores, normalized: normalizedScores },
        sources,
        bucket: {
          id: r.bucketId,
          documentId: r.documentId,
          title: r.title ?? '',
          url: r.url,
          updatedAt: r.updatedAt ?? new Date(),
          status: r.documentStatus,
          visibility: r.documentVisibility,
          documentType: r.documentType,
          sourceType: r.sourceType,
          tenantId: r.tenantId,
          userId: r.userId,
          groupId: r.groupId,
          agentId: r.agentId,
          conversationId: r.conversationId,
        },
        chunk: r.chunk ?? { index: 0, total: 1, isNeighbor: false },
        metadata: r.metadata,
        tenantId: r.tenantId,
      }
    })

    const durationMs = Date.now() - startMs

    if (this.eventSink) {
      const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }
      const event: d8umEvent = {
        id: crypto.randomUUID(),
        eventType: 'query.execute',
        identity,
        payload: {
          mode: resolvedMode,
          text,
          resultCount: results.length,
          bucketCount: activeBucketIds.length,
        },
        durationMs,
        traceId: opts.traceId,
        spanId: opts.spanId,
        timestamp: new Date(),
      }
      void this.eventSink.emit(event)
    }

    return {
      results,
      buckets: bucketTimings,
      query: {
        text,
        tenantId,
        durationMs,
        mergeStrategy: opts.mergeStrategy ?? 'rrf',
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }
}

/** Dot product of two vectors — equivalent to cosine similarity when vectors are L2-normalized
 *  (which embedding models typically return). */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}
