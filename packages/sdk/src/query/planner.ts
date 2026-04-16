import type { Bucket } from '../types/bucket.js'
import type { QueryOpts, QueryResponse, QuerySignals, typegraphResult, RawScores, NormalizedScores } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { MemoryBridge, KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { typegraphEvent, typegraphEventSink } from '../types/events.js'
import type { typegraphLogger } from '../types/logger.js'
import { IndexedRunner } from './runners/indexed.js'
import { MemoryRunner } from './runners/memory-runner.js'
import { GraphRunner } from './runners/graph-runner.js'
import { mergeAndRank, normalizeRRF, normalizePPR, calibrateSemantic, calibrateKeyword, type NormalizedResult } from './merger.js'
import { classifyQuery } from './classifier.js'

/** Resolve user-provided signals (or defaults) into a fully-specified signal set. */
export function resolveSignals(opts: QueryOpts): Required<QuerySignals> {
  const s = opts.signals ?? {}
  return {
    semantic: s.semantic ?? true,
    keyword: s.keyword ?? false,
    graph: s.graph ?? false,
    memory: s.memory ?? false,
  }
}

/** Human-readable label from active signals (e.g. "semantic+keyword", "graph+memory"). */
export function signalLabel(signals: QuerySignals): string {
  const active: string[] = []
  if (signals.semantic) active.push('semantic')
  if (signals.keyword) active.push('keyword')
  if (signals.graph) active.push('graph')
  if (signals.memory) active.push('memory')
  return active.join('+') || 'none'
}

/** Compute composite score with eligible/ineligible distinction.
 *  - `undefined` value = ineligible (result can't have this score, e.g. bucket doc has no memory score).
 *    Weight is redistributed proportionally to eligible categories.
 *  - `0` value = eligible but scored poorly. Full penalty proportional to category weight.
 *  This ensures bucket documents aren't penalized for lacking a memory score,
 *  while memories that score 0 in keyword search are properly penalized. */
function compositeScore(
  components: Array<{ weight: number; value: number | undefined }>
): number {
  const eligible = components.filter(c => c.value !== undefined)
  if (eligible.length === 0) return 0

  const ineligibleWeight = components
    .filter(c => c.value === undefined)
    .reduce((s, c) => s + c.weight, 0)
  const eligibleTotalWeight = eligible.reduce((s, c) => s + c.weight, 0)

  return eligible.reduce((score, c) => {
    const adjusted = c.weight + ineligibleWeight * (c.weight / eligibleTotalWeight)
    return score + adjusted * c.value!
  }, 0)
}

/** Default weight profiles per signal combination.
 *  RRF is excluded — it's a rank-fusion technique for merging lists,
 *  not a relevance signal. It's used during merge-time ranking only. */
function getDefaultWeights(signals: Required<QuerySignals>): Record<string, number> {
  const s = signals.semantic
  const k = signals.keyword
  const g = signals.graph
  const m = signals.memory

  if (s && !k && !g && !m) return { semantic: 1.0 }
  if (s && k && !g && !m) return { semantic: 0.85, keyword: 0.15 }
  if (s && !k && g && !m) return { semantic: 0.55, graph: 0.45 }
  if (s && !k && !g && m) return { semantic: 0.55, memory: 0.45 }
  if (s && k && g && !m) return { semantic: 0.45, keyword: 0.10, graph: 0.45 }
  if (s && k && !g && m) return { semantic: 0.45, keyword: 0.10, memory: 0.45 }
  if (s && k && g && m) return { semantic: 0.35, keyword: 0.05, graph: 0.30, memory: 0.30 }
  if (s && !k && g && m) return { semantic: 0.35, graph: 0.35, memory: 0.30 }
  // Non-semantic combinations (graph-only, memory-only, etc.)
  if (!s && g && m) return { graph: 0.50, memory: 0.50 }
  if (!s && g && !m) return { graph: 1.0 }
  if (!s && !g && m) return { memory: 1.0 }
  if (!s && k && g) return { keyword: 0.20, graph: 0.80 }
  if (!s && k && m) return { keyword: 0.20, memory: 0.80 }
  // Fallback
  return { semantic: 1.0 }
}

/** Compute composite score from normalized signal scores and weights.
 *  When no explicit weights are provided, derives defaults from which signals are active.
 *  Distinguishes ineligible (undefined → redistribute weight) from scored-0 (penalize). */
export function computeCompositeScore(
  normalizedScores: NormalizedScores,
  signals: Required<QuerySignals>,
  userWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>
): number {
  const weights = (userWeights && Object.keys(userWeights).length > 0)
    ? userWeights
    : getDefaultWeights(signals)

  const components: Array<{ weight: number; value: number | undefined }> = []

  if (weights.semantic) components.push({ weight: weights.semantic, value: normalizedScores.semantic })
  if (weights.keyword) components.push({ weight: weights.keyword, value: normalizedScores.keyword })
  if (weights.graph) components.push({ weight: weights.graph, value: normalizedScores.graph })
  if (weights.memory) components.push({ weight: weights.memory, value: normalizedScores.memory })
  // Allow user to include RRF in explicit weights if they want
  if (weights.rrf) components.push({ weight: weights.rrf, value: normalizedScores.rrf })

  return compositeScore(components)
}

/** Race a promise against a timeout. Returns the result or fallback on timeout.
 *  Errors from the underlying promise propagate to the caller — only timeouts degrade. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms) }),
  ]).finally(() => { clearTimeout(timer) })
}

export class QueryPlanner {
  constructor(
    private adapter: VectorStoreAdapter,
    private bucketIds: string[],
    private bucketEmbeddings: Map<string, EmbeddingProvider>,
    private bucketQueryEmbeddings: Map<string, EmbeddingProvider>,
    private memory?: MemoryBridge,
    private knowledgeGraph?: KnowledgeGraphBridge,
    private eventSink?: typegraphEventSink,
    private logger?: typegraphLogger,
  ) {}

  async execute(text: string, opts: QueryOpts = {}): Promise<QueryResponse> {
    const startMs = Date.now()
    const count = opts.count ?? 10
    const tenantId = opts.tenantId
    const signals = resolveSignals(opts)
    const onBucketError = opts.onBucketError ?? 'throw'

    // Auto-weights: classify query type and use optimized weight profile.
    // User-provided scoreWeights always override.
    let effectiveScoreWeights = opts.scoreWeights
    if (opts.autoWeights && !effectiveScoreWeights) {
      const classification = classifyQuery(text)
      effectiveScoreWeights = classification.weights as Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>
      this.logger?.debug('Auto-weights', { queryType: classification.type, confidence: classification.confidence, weights: classification.weights })
    }

    this.logger?.debug('Query start', { text: text.slice(0, 100), signals, count })

    // Filter to requested sources or use all
    const activeBucketIds = opts.buckets
      ? opts.buckets.filter(id => this.bucketIds.includes(id))
      : this.bucketIds

    // Group sources by ingest embedding model (determines table routing).
    // Attach query embedding provider (may differ from ingest model).
    const modelGroups = new Map<string, { embedding: EmbeddingProvider; ingestModelId: string; bucketIds: string[] }>()
    const warnings: string[] = []

    for (const bucketId of activeBucketIds) {
      const ingestEmb = this.bucketEmbeddings.get(bucketId)
      if (!ingestEmb) {
        warnings.push(`Bucket "${bucketId}" has no embedding provider - skipped`)
        continue
      }
      const queryEmb = this.bucketQueryEmbeddings.get(bucketId) ?? ingestEmb
      const ingestModelId = embeddingModelKey(ingestEmb)

      const existing = modelGroups.get(ingestModelId)
      if (existing) {
        existing.bucketIds.push(bucketId)
      } else {
        modelGroups.set(ingestModelId, { embedding: queryEmb, ingestModelId, bucketIds: [bucketId] })
      }
    }

    const needsIndexedSearch = signals.semantic || signals.keyword
    const needsGraph = signals.graph && !!this.knowledgeGraph
    const needsMemory = signals.memory && !!this.memory
    const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }

    // Timeouts (user-configurable or defaults)
    const timeouts = {
      indexed: opts.timeouts?.indexed ?? 30_000,
      graph: opts.timeouts?.graph ?? 30_000,
      memory: opts.timeouts?.memory ?? 10_000,
    }

    // Memory-only or graph-only (no indexed search)
    if (!needsIndexedSearch && (needsMemory || needsGraph)) {
      const runnerArrays: NormalizedResult[][] = []

      // Memory runner
      if (needsMemory) {
        try {
          const memoryRunner = new MemoryRunner(this.memory!)
          const memResults = await withTimeout(
            memoryRunner.run(text, identity, count, { useKeyword: signals.keyword }),
            timeouts.memory,
            [] as NormalizedResult[]
          )
          if (memResults.length > 0) runnerArrays.push(memResults)
        } catch (err) {
          const msg = `Memory search failed: ${err instanceof Error ? err.message : String(err)}`
          warnings.push(msg)
          this.logger?.warn(msg)
        }
      }

      // Graph runner
      if (needsGraph) {
        try {
          const graphRunner = new GraphRunner(this.knowledgeGraph!)
          const graphResults = await withTimeout(
            graphRunner.run(text, identity, count),
            timeouts.graph,
            [] as NormalizedResult[]
          )
          if (graphResults.length > 0) runnerArrays.push(graphResults)
        } catch (err) {
          const msg = `Graph search failed: ${err instanceof Error ? err.message : String(err)}`
          warnings.push(msg)
          this.logger?.warn(msg)
        }
      }

      const allResults = runnerArrays.length > 1
        ? mergeAndRank(runnerArrays, count, undefined, signals, effectiveScoreWeights)
        : (runnerArrays[0] ?? []).slice(0, count)

      const results: typegraphResult[] = allResults.map(r => {
        const merged = r as any
        const agg = merged.rawScores ?? r.rawScores
        const rawScores: RawScores = {}
        const normalizedScores: NormalizedScores = {}

        const modes: string[] = merged.modes ?? [r.mode]
        const isFromMemory = modes.includes('memory')

        // Graph: sqrt normalization for stable absolute scores
        if (signals.graph) {
          rawScores.ppr = agg.graph
          normalizedScores.graph = Math.min(Math.sqrt(agg.graph ?? 0), 1)
        }
        if (signals.memory) {
          rawScores.importance = agg.memory
          rawScores.memorySimilarity = agg.memorySimilarity
          rawScores.memoryImportance = agg.memoryImportance
          rawScores.memoryRecency = agg.memoryRecency
          normalizedScores.memory = isFromMemory
            ? Math.min(Math.max(agg.memory ?? 0, 0), 1)
            : undefined
        }
        // Memory results have semantic similarity from embedding search
        if (signals.semantic && isFromMemory && agg.memorySimilarity != null) {
          rawScores.cosineSimilarity = agg.memorySimilarity
          normalizedScores.semantic = calibrateSemantic(agg.memorySimilarity)
        }

        const topScore = computeCompositeScore(normalizedScores, signals, effectiveScoreWeights)

        const sources = modes.map(modeToSource)

        return {
          content: r.content,
          score: topScore,
          scores: { raw: rawScores, normalized: normalizedScores },
          sources,
          document: {
            id: r.documentId,
            bucketId: r.bucketId,
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

      this.logger?.debug('Query complete', { durationMs: Date.now() - startMs, resultCount: results.length })

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

      try {
        const results = await withTimeout(
          runner.run(text, modelGroups, count, identity, opts.documentFilter, vectorOnly, opts.traceId, opts.spanId, opts.temporalAt),
          timeouts.indexed,
          [] as NormalizedResult[]
        )
        const runnerDuration = Date.now() - runnerStart

        if (results.length === 0 && runnerDuration >= timeouts.indexed) {
          const msg = `Indexed search timed out after ${timeouts.indexed}ms`
          warnings.push(msg)
          this.logger?.warn(msg)
          for (const bucketId of activeBucketIds) {
            bucketTimings[bucketId] = { mode: 'indexed', resultCount: 0, durationMs: runnerDuration, status: 'timeout' }
          }
        } else {
          for (const bucketId of activeBucketIds) {
            const sourceResults = results.filter(r => r.bucketId === bucketId)
            bucketTimings[bucketId] = {
              mode: 'indexed',
              resultCount: sourceResults.length,
              durationMs: runnerDuration,
              status: 'ok',
            }
          }
        }

        allResults = results
      } catch (err) {
        const runnerDuration = Date.now() - runnerStart
        if (onBucketError === 'throw') throw err
        if (onBucketError === 'warn') {
          const msg = `Indexed search failed: ${err instanceof Error ? err.message : String(err)}`
          warnings.push(msg)
          this.logger?.warn(msg)
        }
        for (const bucketId of activeBucketIds) {
          bucketTimings[bucketId] = { mode: 'indexed', resultCount: 0, durationMs: runnerDuration, status: 'error', error: err instanceof Error ? err : new Error(String(err)) }
        }
      }
    }

    // Run graph + memory runners in parallel if signals request them
    const runnerArrays: NormalizedResult[][] = [allResults]
    if (needsGraph || needsMemory) {
      // Skip memory runner if store has no memories (avoids empty table query per query)
      const skipMemory = !needsMemory || (this.memory?.hasMemories ? !(await this.memory.hasMemories()) : false)
      const memoryPromise = skipMemory
        ? Promise.resolve([] as NormalizedResult[])
        : withTimeout(
            new MemoryRunner(this.memory!).run(text, identity, count, {
              ...(opts.temporalAt ? { temporalAt: opts.temporalAt } : {}),
              ...(opts.includeInvalidated != null ? { includeInvalidated: opts.includeInvalidated } : {}),
              useKeyword: signals.keyword,
            }).catch((err) => { this.logger?.warn(`MemoryRunner failed: ${err instanceof Error ? err.message : err}`); warnings.push(`Memory search failed: ${err instanceof Error ? err.message : String(err)}`); return [] as NormalizedResult[] }),
            timeouts.memory,
            [] as NormalizedResult[]
          )

      const graphPromise = !needsGraph
        ? Promise.resolve([] as NormalizedResult[])
        : withTimeout(
            new GraphRunner(this.knowledgeGraph!).run(text, identity, count)
              .catch((err) => { this.logger?.warn(`GraphRunner failed: ${err instanceof Error ? err.message : err}`); warnings.push(`Graph search failed: ${err instanceof Error ? err.message : String(err)}`); return [] as NormalizedResult[] }),
            timeouts.graph,
            [] as NormalizedResult[]
          )

      const [memResults, graphResults] = await Promise.all([
        memoryPromise,
        graphPromise,
      ])

      if (memResults.length > 0) {
        // Memory results already carry semantic similarity scores from the memory
        // store's embedding search (via metadata._similarity → rawScores.semantic).
        // No need to re-embed here — the MemoryRunner handles this.
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
      ? mergeAndRank(runnerArrays, count, undefined, signals, effectiveScoreWeights)
      : allResults.slice(0, count)

    // Map NormalizedResult → typegraphResult with raw/normalized score structure
    const results: typegraphResult[] = mergedResults.map(r => {
      const merged = r as any

      // Get aggregated raw scores (from merger if merged, raw if not)
      const agg = merged.rawScores ?? r.rawScores
      const rawRrf = merged.finalScore ?? agg.rrf ?? r.normalizedScore

      // Build raw scores (algorithm-level, mixed ranges)
      const rawScores: RawScores = {}
      // Build normalized scores (capability-level, all 0-1)
      const normalizedScores: NormalizedScores = {}

      // Determine result origin for eligible/ineligible scoring
      const modes: string[] = merged.modes ?? [r.mode]
      const isFromMemory = modes.includes('memory')
      const isFromIndexed = modes.includes('indexed')

      // Semantic: calibrate raw cosine similarity to 0-1 relevance scale.
      // Both indexed chunks and memories use cosine similarity — same algorithm.
      if (signals.semantic || signals.keyword) {
        const semanticScore = agg.semantic ?? (isFromMemory ? agg.memorySimilarity : undefined)
        rawScores.cosineSimilarity = semanticScore
        normalizedScores.semantic = calibrateSemantic(semanticScore ?? 0)
      }

      // Keyword: calibrate raw ts_rank() BM25 to 0-1 scale.
      if (signals.keyword) {
        rawScores.bm25 = agg.keyword
        rawScores.rrf = rawRrf
        normalizedScores.keyword = calibrateKeyword(agg.keyword ?? 0)
        const numListsForRRF = merged.compositeScore != null ? runnerArrays.length : 2
        const baseRRF = normalizeRRF(rawRrf, numListsForRRF)
        const matchedBothLists = (agg.keyword ?? 0) > 0
        normalizedScores.rrf = matchedBothLists ? baseRRF : baseRRF * 0.5
      } else if (signals.semantic && (needsGraph || needsMemory) && merged.compositeScore != null) {
        rawScores.rrf = rawRrf
        normalizedScores.rrf = normalizeRRF(rawRrf, runnerArrays.length)
      }

      // Graph: sqrt normalization for stable absolute scores.
      // When graph signal is active, ALL results get a score — never undefined.
      if (signals.graph) {
        rawScores.ppr = agg.graph
        normalizedScores.graph = Math.min(Math.sqrt(agg.graph ?? 0), 1)
      }

      // Memory: eligible for memory results, ineligible for bucket documents
      if (signals.memory) {
        rawScores.importance = agg.memory
        rawScores.memorySimilarity = agg.memorySimilarity
        rawScores.memoryImportance = agg.memoryImportance
        rawScores.memoryRecency = agg.memoryRecency
        normalizedScores.memory = isFromMemory
          ? Math.min(Math.max(agg.memory ?? 0, 0), 1)
          : undefined // Bucket documents are ineligible for memory scoring
      }

      // Composite score with calibrated signals and eligible/ineligible awareness.
      const topScore = computeCompositeScore(normalizedScores, signals, effectiveScoreWeights)

      // Sources: which retrieval systems contributed (user-facing labels)
      const sources = modes.map(modeToSource)

      return {
        content: r.content,
        score: topScore,
        scores: { raw: rawScores, normalized: normalizedScores },
        sources,
        document: {
          id: r.documentId,
          bucketId: r.bucketId,
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
      const event: typegraphEvent = {
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

    this.logger?.debug('Query complete', { durationMs, resultCount: results.length, signals })

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

/** Map internal runner mode names to user-facing source labels. */
function modeToSource(mode: string): string {
  switch (mode) {
    case 'indexed': return 'semantic'
    case 'graph': return 'graph'
    case 'memory': return 'memory'
    case 'cached': return 'memory'
    case 'live': return 'semantic'
    default: return mode
  }
}

/** Dot product of two vectors — equivalent to cosine similarity when vectors are L2-normalized
 *  (which embedding models typically return). */
