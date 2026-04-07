import type { Bucket } from '../types/bucket.js'
import type { QueryOpts, QueryResponse, QuerySignals, d8umResult, RawScores, NormalizedScores } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { GraphBridge } from '../types/graph-bridge.js'
import type { d8umEvent, d8umEventSink } from '../types/events.js'
import { IndexedRunner } from './runners/indexed.js'
import { MemoryRunner } from './runners/memory-runner.js'
import { GraphRunner } from './runners/graph-runner.js'
import { mergeAndRank, normalizeRRF, normalizePPR, type NormalizedResult } from './merger.js'
// classifyQuery is available for users who want auto-classification
// import { classifyQuery } from './classifier.js'

/** Resolve user-provided signals (or defaults) into a fully-specified signal set. */
export function resolveSignals(opts: QueryOpts): Required<QuerySignals> {
  const s = opts.signals ?? {}
  return {
    vector: s.vector ?? true,
    keyword: s.keyword ?? false,
    graph: s.graph ?? false,
    memory: s.memory ?? false,
  }
}

/** Human-readable label from active signals (e.g. "vector+keyword", "graph+memory"). */
export function signalLabel(signals: QuerySignals): string {
  const active: string[] = []
  if (signals.vector) active.push('vector')
  if (signals.keyword) active.push('keyword')
  if (signals.graph) active.push('graph')
  if (signals.memory) active.push('memory')
  return active.join('+') || 'none'
}

/** Compute composite score from normalized signal scores and weights.
 *  When no explicit weights are provided, derives defaults from which signals are active. */
export function computeCompositeScore(
  normalizedScores: NormalizedScores,
  signals: Required<QuerySignals>,
  userWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>
): number {
  if (userWeights && Object.keys(userWeights).length > 0) {
    // User-provided weights — use directly
    let score = 0
    score += (userWeights.rrf ?? 0) * (normalizedScores.rrf ?? 0)
    score += (userWeights.semantic ?? 0) * (normalizedScores.semantic ?? 0)
    score += (userWeights.keyword ?? 0) * (normalizedScores.keyword ?? 0)
    score += (userWeights.graph ?? 0) * (normalizedScores.graph ?? 0)
    score += (userWeights.memory ?? 0) * (normalizedScores.memory ?? 0)
    return score
  }

  // Auto-derive defaults based on active signals
  const hasKeyword = signals.keyword
  const hasGraph = signals.graph
  const hasMemory = signals.memory

  if (!hasKeyword && !hasGraph && !hasMemory) {
    // Vector-only (fast)
    return normalizedScores.semantic ?? 0
  }

  if (hasKeyword && !hasGraph && !hasMemory) {
    // Vector + keyword (hybrid)
    const nRRF = normalizedScores.rrf ?? 0
    const semantic = normalizedScores.semantic ?? 0
    const kw = normalizedScores.keyword ?? 0
    return 0.4 * nRRF + 0.5 * semantic + 0.1 * kw
  }

  // Multi-signal (any combination with graph/memory)
  const nRRF = normalizedScores.rrf ?? 0
  const semantic = normalizedScores.semantic ?? 0
  const kw = normalizedScores.keyword ?? 0
  const graph = normalizedScores.graph ?? 0
  const memory = normalizedScores.memory ?? 0
  return 0.25 * nRRF + 0.35 * semantic + 0.1 * kw + 0.15 * graph + 0.15 * memory
}

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
    const signals = resolveSignals(opts)

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

    const needsIndexedSearch = signals.vector || signals.keyword
    const needsGraph = signals.graph && !!this.graph
    const needsMemory = signals.memory && !!this.graph
    const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }

    // Memory-only or graph-only (no indexed search)
    if (!needsIndexedSearch && (needsMemory || needsGraph)) {
      if (!this.graph) {
        return {
          results: [],
          buckets: {},
          query: { text, tenantId, durationMs: Date.now() - startMs, mergeStrategy: 'rrf' },
          warnings: ['Graph/memory signals require a graph bridge. Configure graph in d8umConfig.'],
        }
      }

      const runnerArrays: NormalizedResult[][] = []

      // Memory runner
      if (needsMemory) {
        const memoryRunner = new MemoryRunner(this.graph)
        const memResults = await memoryRunner.run(text, identity, count)
        if (memResults.length > 0) runnerArrays.push(memResults)
      }

      // Graph runner
      if (needsGraph) {
        const graphRunner = new GraphRunner(this.graph)
        try {
          const graphResults = await graphRunner.run(text, identity, count)
          if (graphResults.length > 0) runnerArrays.push(graphResults)
        } catch { /* graph runner failure — continue with memory results */ }
      }

      const allResults = runnerArrays.length > 1
        ? mergeAndRank(runnerArrays, count, undefined, signals, opts.scoreWeights)
        : (runnerArrays[0] ?? []).slice(0, count)

      const results: d8umResult[] = allResults.map(r => {
        const merged = r as any
        const agg = merged.rawScores ?? r.rawScores
        const rawScores: RawScores = {}
        const normalizedScores: NormalizedScores = {}

        if (agg.graph != null) {
          rawScores.ppr = agg.graph
          normalizedScores.graph = normalizePPR(agg.graph)
        }
        if (agg.memory != null) {
          rawScores.importance = agg.memory
          normalizedScores.memory = agg.memory
        }

        const topScore = merged.compositeScore ?? computeCompositeScore(normalizedScores, signals, opts.scoreWeights)

        return {
          content: r.content,
          score: topScore,
          scores: { raw: rawScores, normalized: normalizedScores },
          sources: merged.modes ?? [r.mode],
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

      const bucketTimings: QueryResponse['buckets'] = {}
      if (needsMemory) bucketTimings['__memory__'] = { mode: 'cached', resultCount: results.length, durationMs: Date.now() - startMs, status: 'ok' }
      if (needsGraph) bucketTimings['__graph__'] = { mode: 'cached', resultCount: results.length, durationMs: Date.now() - startMs, status: 'ok' }

      return {
        results,
        buckets: bucketTimings,
        query: { text, tenantId, durationMs: Date.now() - startMs, mergeStrategy: 'rrf' },
      }
    }

    // Run indexed search (vector, keyword, or both)
    const bucketTimings: QueryResponse['buckets'] = {}
    let allResults: NormalizedResult[] = []

    if (modelGroups.size > 0) {
      const runnerStart = Date.now()
      const runner = new IndexedRunner(this.adapter, this.eventSink)
      const vectorOnly = !signals.keyword
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

    // Run graph + memory runners in parallel if signals request them
    const runnerArrays: NormalizedResult[][] = [allResults]
    if ((needsGraph || needsMemory) && this.graph) {
      // Skip memory runner if store has no memories (avoids empty table query per query)
      const skipMemory = !needsMemory || (this.graph.hasMemories ? !(await this.graph.hasMemories()) : false)
      const memoryPromise = skipMemory
        ? Promise.resolve([] as NormalizedResult[])
        : new MemoryRunner(this.graph).run(text, identity, count).catch(() => [] as NormalizedResult[])

      // 30s timeout on graph runner: if a DB call hangs (e.g., Neon connection stall),
      // fall back to empty results so the query proceeds with indexed results only.
      let graphTimer: ReturnType<typeof setTimeout> | undefined
      const graphPromise = !needsGraph
        ? Promise.resolve([] as NormalizedResult[])
        : Promise.race([
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
        const reinforcement = opts.graphReinforcement ?? 'only'

        if (reinforcement === 'off') {
          // Include all graph results as-is
          runnerArrays.push(graphResults)
        } else if (reinforcement === 'prefer') {
          // Keep all graph results but boost those matching indexed content
          if (allResults.length > 0) {
            const indexedContent = new Set(allResults.map(r => r.content))
            for (const gr of graphResults) {
              if (indexedContent.has(gr.content)) {
                // Boost reinforcing graph results
                gr.rawScores.graph = (gr.rawScores.graph ?? 0) * 1.5
              }
            }
          }
          runnerArrays.push(graphResults)
        } else {
          // 'only' (default): keep graph results whose content matches an indexed result
          if (allResults.length > 0) {
            const indexedContent = new Set(allResults.map(r => r.content))
            const reinforcing = graphResults.filter(r => indexedContent.has(r.content))
            if (reinforcing.length > 0) {
              runnerArrays.push(reinforcing)
            }
          } else {
            runnerArrays.push(graphResults)
          }
        }
        bucketTimings['__graph__'] = { mode: 'cached', resultCount: graphResults.length, durationMs: Date.now() - startMs, status: 'ok' }
      }
    }

    // Merge and rank
    const needsMerge = runnerArrays.length > 1 || modelGroups.size > 1
    const mergedResults = needsMerge
      ? mergeAndRank(runnerArrays, count, undefined, signals, opts.scoreWeights)
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

      // Always populate vector score if we ran vector search
      if (signals.vector || signals.keyword) {
        rawScores.cosineSimilarity = agg.vector
        normalizedScores.semantic = agg.vector ?? 0
      }

      if (signals.keyword) {
        rawScores.bm25 = agg.keyword
        rawScores.rrf = rawRrf
        normalizedScores.keyword = agg.keyword ?? 0
        const numListsForRRF = merged.compositeScore != null ? runnerArrays.length : 2
        normalizedScores.rrf = normalizeRRF(rawRrf, numListsForRRF)
      } else if (signals.vector && (needsGraph || needsMemory) && merged.compositeScore != null) {
        // Vector + graph/memory without keyword: still have RRF from multi-runner merge
        rawScores.rrf = rawRrf
        normalizedScores.rrf = normalizeRRF(rawRrf, runnerArrays.length)
      }

      if (signals.graph) {
        rawScores.ppr = agg.graph
        normalizedScores.graph = normalizePPR(agg.graph ?? 0)
      }
      if (signals.memory) {
        rawScores.importance = agg.memory
        normalizedScores.memory = agg.memory ?? 0
      }

      // Compute top-level composite score (always 0-1)
      let topScore: number
      if (merged.compositeScore != null) {
        topScore = merged.compositeScore
      } else {
        topScore = computeCompositeScore(normalizedScores, signals, opts.scoreWeights)
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
      const event: d8umEvent = {
        id: crypto.randomUUID(),
        eventType: 'query.execute',
        identity,
        payload: {
          signals,
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
        mergeStrategy: 'rrf',
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
