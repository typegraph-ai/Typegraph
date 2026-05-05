import type { Bucket } from '../types/bucket.js'
import type { QueryChunkResult, QueryMemoryResult, QueryOpts, QueryResponse, QueryResults, QuerySignals, RawScores, NormalizedScores } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { EntityResult, FactResult, GraphSearchTrace, MemoryBridge, KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { typegraphEvent, typegraphEventSink } from '../types/events.js'
import type { typegraphLogger } from '../types/logger.js'
import type { ChunkRef } from '../types/chunk.js'
import { ConfigError } from '../types/errors.js'
import { IndexedRunner } from './runners/indexed.js'
import { MemoryRunner } from './runners/memory-runner.js'
import { GraphRunner, type GraphRunResult } from './runners/graph-runner.js'
import { mergeAndRank, normalizeRRF, normalizeGraphPPR, calibrateSemantic, calibrateKeyword, type RetrievalCandidate } from './merger.js'
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
 *  - `undefined` value = ineligible (result can't have this score, e.g. bucket source has no memory score).
 *    Weight is redistributed proportionally to eligible categories.
 *  - `0` value = eligible but scored poorly. Full penalty proportional to category weight.
 *  This ensures bucket sources aren't penalized for lacking a memory score,
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
  if (!s && k && !g && !m) return { keyword: 1.0 }
  if (!s && k && g && !m) return { keyword: 0.20, graph: 0.80 }
  if (!s && k && !g && m) return { keyword: 0.20, memory: 0.80 }
  if (!s && k && g && m) return { keyword: 0.10, graph: 0.45, memory: 0.45 }
  if (!s && !k && g && m) return { graph: 0.50, memory: 0.50 }
  if (!s && !k && g && !m) return { graph: 1.0 }
  if (!s && !k && !g && m) return { memory: 1.0 }
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

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>()
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()]
}

interface ScoredCandidate {
  score: number
  scores: { raw: RawScores; normalized: NormalizedScores }
  sources: string[]
  modes: string[]
}

function scoreCandidate(
  r: RetrievalCandidate,
  signals: Required<QuerySignals>,
  runnerArrayCount: number,
  needsGraph: boolean,
  needsMemory: boolean,
  effectiveScoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>,
): ScoredCandidate {
  const merged = r as RetrievalCandidate & { modes?: string[]; finalScore?: number; compositeScore?: number }
  const agg = merged.rawScores ?? r.rawScores
  const rawRrf = merged.finalScore ?? agg.rrf ?? r.normalizedScore
  const rawScores: RawScores = {}
  const normalizedScores: NormalizedScores = {}
  const modes: string[] = merged.modes ?? [r.mode]
  const isFromMemory = modes.includes('memory')

  if (signals.semantic) {
    const semanticScore = agg.semantic ?? (isFromMemory ? agg.memorySimilarity : undefined)
    rawScores.cosineSimilarity = semanticScore
    normalizedScores.semantic = calibrateSemantic(semanticScore ?? 0)
  }

  if (signals.keyword) {
    rawScores.bm25 = agg.keyword
    rawScores.rrf = rawRrf
    normalizedScores.keyword = calibrateKeyword(agg.keyword ?? 0)
    const numListsForRRF = merged.compositeScore != null ? runnerArrayCount : 2
    const baseRRF = normalizeRRF(rawRrf, numListsForRRF)
    const matchedBothLists = (agg.keyword ?? 0) > 0
    normalizedScores.rrf = matchedBothLists ? baseRRF : baseRRF * 0.5
  } else if (signals.semantic && (needsGraph || needsMemory) && merged.compositeScore != null) {
    rawScores.rrf = rawRrf
    normalizedScores.rrf = normalizeRRF(rawRrf, runnerArrayCount)
  }

  if (signals.graph) {
    rawScores.ppr = agg.graph
    normalizedScores.graph = normalizeGraphPPR(agg.graph ?? 0)
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

  const score = computeCompositeScore(normalizedScores, signals, effectiveScoreWeights)
  return {
    score,
    scores: { raw: rawScores, normalized: normalizedScores },
    sources: sourcesForResult(modes, rawScores, signals),
    modes,
  }
}

function toChunkResult(r: RetrievalCandidate, scored: ScoredCandidate): QueryChunkResult {
  return {
    content: r.content,
    score: scored.score,
    scores: scored.scores,
    sources: scored.sources,
    source: {
      id: r.sourceId,
      bucketId: r.bucketId,
      title: r.title ?? '',
      url: r.url,
      updatedAt: r.updatedAt ?? new Date(),
      status: r.sourceStatus,
      visibility: r.sourceVisibility,
      tenantId: r.tenantId,
      userId: r.userId,
      groupId: r.groupId,
      agentId: r.agentId,
      conversationId: r.conversationId,
      subject: r.sourceSubject,
    },
    chunk: r.chunk ?? { index: 0, total: 1 },
    metadata: r.metadata,
    tenantId: r.tenantId,
  }
}

function fallbackMemoryRecord(r: RetrievalCandidate): Omit<QueryMemoryResult, 'score' | 'scores'> {
  const now = new Date()
  return {
    id: r.sourceId,
    category: 'semantic',
    status: 'active',
    content: r.content,
    importance: r.rawScores.memoryImportance ?? 0,
    accessCount: 0,
    lastAccessedAt: now,
    metadata: r.metadata,
    scope: {
      tenantId: r.tenantId,
      groupId: r.groupId,
      userId: r.userId,
      agentId: r.agentId,
      conversationId: r.conversationId,
    },
    validAt: now,
    createdAt: r.updatedAt ?? now,
    visibility: undefined,
  }
}

function toMemoryResult(r: RetrievalCandidate, scored: ScoredCandidate): QueryMemoryResult {
  const memory = r.memoryRecord ?? fallbackMemoryRecord(r)
  return {
    ...memory,
    score: scored.score,
    scores: scored.scores,
  }
}

function partitionResults(
  candidates: RetrievalCandidate[],
  signals: Required<QuerySignals>,
  runnerArrayCount: number,
  needsGraph: boolean,
  needsMemory: boolean,
  graphFacts: FactResult[],
  graphEntities: EntityResult[],
  graphTrace?: GraphSearchTrace | undefined,
  effectiveScoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>,
): QueryResults {
  const chunks: QueryChunkResult[] = []
  const memories: QueryMemoryResult[] = []

  for (const candidate of candidates) {
    const scored = scoreCandidate(candidate, signals, runnerArrayCount, needsGraph, needsMemory, effectiveScoreWeights)
    const memoryOnly = scored.modes.includes('memory')
      && !scored.modes.some(mode => mode === 'indexed' || mode === 'graph')
    if (memoryOnly) {
      memories.push(toMemoryResult(candidate, scored))
    } else {
      chunks.push(toChunkResult(candidate, scored))
    }
  }

  return {
    chunks,
    facts: graphFacts.length > 0 ? uniqueById(graphFacts) : [],
    entities: graphEntities.length > 0 ? uniqueById(graphEntities) : [],
    memories: signals.memory ? memories : [],
    ...(signals.graph && graphTrace ? { graphTrace } : {}),
  }
}

function resultCounts(results: QueryResults): {
  resultCount: number
  chunkCount: number
  factCount: number
  entityCount: number
  memoryCount: number
} {
  const chunkCount = results.chunks.length
  const memoryCount = results.memories.length
  return {
    resultCount: chunkCount + memoryCount,
    chunkCount,
    factCount: results.facts.length,
    entityCount: results.entities.length,
    memoryCount,
  }
}

function boostScopedCandidates(candidates: RetrievalCandidate[], chunkRefs: ChunkRef[]): void {
  if (chunkRefs.length === 0) return
  const scoped = new Set(chunkRefs.map(ref => `${ref.bucketId}:${ref.sourceId}:${ref.chunkIndex}`))
  for (const candidate of candidates) {
    if (!scoped.has(resultIdentityKey(candidate))) continue
    candidate.normalizedScore = Math.min(1, candidate.normalizedScore * 1.15 + 0.05)
    candidate.rawScores.semantic = Math.min(1, (candidate.rawScores.semantic ?? candidate.normalizedScore) * 1.15 + 0.05)
  }
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
    const needsGraph = Boolean(signals.graph && this.knowledgeGraph)
    const needsMemory = Boolean(signals.memory && this.memory)
    const identity = { tenantId: opts.tenantId, groupId: opts.groupId, userId: opts.userId, agentId: opts.agentId, conversationId: opts.conversationId }
    const entityScopeMode = opts.entityScope?.mode ?? 'filter'
    let scopedEntityIds: string[] = []
    let scopedChunkRefs: ChunkRef[] = []
    const graphScopedQuery = Boolean(opts.entityScope && (needsIndexedSearch || signals.graph))
    if (opts.entityScope && graphScopedQuery) {
      if (!this.knowledgeGraph?.resolveEntityScope) {
        throw new ConfigError('entityScope requires a knowledge graph bridge with entity scope resolution.')
      }
      const resolved = await this.knowledgeGraph.resolveEntityScope(opts.entityScope, identity, {
        bucketIds: activeBucketIds,
        limit: Math.max(count * 50, 200),
      })
      scopedEntityIds = resolved.entityIds
      scopedChunkRefs = resolved.chunkRefs
      if (resolved.warnings) warnings.push(...resolved.warnings)
    }

    // Timeouts (user-configurable or defaults)
    const timeouts = {
      indexed: opts.timeouts?.indexed ?? 30_000,
      graph: opts.timeouts?.graph ?? 30_000,
      memory: opts.timeouts?.memory ?? 10_000,
    }

    // Memory-only or graph-only (no indexed search)
    if (!needsIndexedSearch && (needsMemory || needsGraph)) {
      const runnerArrays: RetrievalCandidate[][] = []
      let graphFacts: FactResult[] = []
      let graphEntities: EntityResult[] = []
      let graphTrace: GraphSearchTrace | undefined

      // Memory runner
      if (needsMemory) {
        try {
          const memoryRunner = new MemoryRunner(this.memory!)
          const memResults = await withTimeout(
            memoryRunner.run(text, identity, count, { useKeyword: signals.keyword, entityScope: opts.entityScope }),
            timeouts.memory,
            [] as RetrievalCandidate[]
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
          const graphRun = await withTimeout(
            graphRunner.run(text, identity, count, activeBucketIds, {
              ...opts.graph,
              ...(opts.entityScope ? { entityScope: opts.entityScope, resolvedEntityIds: scopedEntityIds } : {}),
            }),
            timeouts.graph,
            { results: [], facts: [], entities: [] } as GraphRunResult
          )
          graphFacts = graphRun.facts
          graphEntities = graphRun.entities
          graphTrace = graphRun.trace
          const graphResults = graphRun.results
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

      const results = partitionResults(allResults, signals, Math.max(1, runnerArrays.length), needsGraph, needsMemory, graphFacts, graphEntities, graphTrace, effectiveScoreWeights)

      const bucketTimings: QueryResponse['buckets'] = {}
      if (needsMemory) bucketTimings['__memory__'] = { mode: 'memory', resultCount: results.memories.length, durationMs: Date.now() - startMs, status: 'ok' }
      if (needsGraph) bucketTimings['__graph__'] = { mode: 'graph', resultCount: results.chunks.filter(result => result.sources.includes('graph')).length, durationMs: Date.now() - startMs, status: 'ok' }

      const durationMs = Date.now() - startMs
      const counts = resultCounts(results)

      if (this.eventSink) {
        const event: typegraphEvent = {
          id: crypto.randomUUID(),
          eventType: 'query.execute',
          identity,
          payload: {
            query: text,
            signals,
            requested_count: count,
            result_count: counts.resultCount,
            chunk_count: counts.chunkCount,
            fact_count: counts.factCount,
            entity_count: counts.entityCount,
            memory_count: counts.memoryCount,
            bucket_count: activeBucketIds.length,
          },
          durationMs,
          traceId: opts.traceId,
          spanId: opts.spanId,
          timestamp: new Date(),
        }
        void this.eventSink.emit(event)
      }

      this.logger?.debug('Query complete', { durationMs, resultCount: counts.resultCount })

      return {
        results,
        buckets: bucketTimings,
        query: { text, tenantId, durationMs, mergeStrategy: 'rrf' },
        warnings: warnings.length > 0 ? warnings : undefined,
      }
    }

    // Run indexed search (vector, keyword, or both)
    const bucketTimings: QueryResponse['buckets'] = {}
    let allResults: RetrievalCandidate[] = []

    if (modelGroups.size > 0) {
      const runnerStart = Date.now()
      const runner = new IndexedRunner(this.adapter, this.eventSink)

      try {
        const results = await withTimeout(
          runner.run(
            text,
            modelGroups,
            count,
            identity,
            opts.sourceFilter,
            signals,
            opts.traceId,
            opts.spanId,
            opts.temporalAt,
            opts.entityScope && entityScopeMode === 'filter' ? scopedChunkRefs : undefined,
          ),
          timeouts.indexed,
          [] as RetrievalCandidate[]
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
    const runnerArrays: RetrievalCandidate[][] = [allResults]
    let graphFacts: FactResult[] = []
    let graphEntities: EntityResult[] = []
    let graphTrace: GraphSearchTrace | undefined
    if (opts.entityScope && entityScopeMode === 'boost') {
      boostScopedCandidates(allResults, scopedChunkRefs)
    }
    if (needsIndexedSearch && this.knowledgeGraph?.searchKnowledge) {
      try {
        const direct = await this.knowledgeGraph.searchKnowledge(text, identity, {
          count,
          signals,
          entityScope: opts.entityScope,
          resolvedEntityIds: scopedEntityIds,
        })
        graphFacts = direct.facts
        graphEntities = direct.entities
      } catch (err) {
        const msg = `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}`
        warnings.push(msg)
        this.logger?.warn(msg)
      }
    }
    if (needsGraph || needsMemory) {
      // Skip memory runner if store has no memories (avoids empty table query per query)
      const skipMemory = !needsMemory || (this.memory?.hasMemories ? !(await this.memory.hasMemories()) : false)
      const memoryPromise = skipMemory
        ? Promise.resolve([] as RetrievalCandidate[])
        : withTimeout(
            new MemoryRunner(this.memory!).run(text, identity, count, {
              ...(opts.temporalAt ? { temporalAt: opts.temporalAt } : {}),
              ...(opts.includeInvalidated != null ? { includeInvalidated: opts.includeInvalidated } : {}),
              ...(opts.entityScope ? { entityScope: opts.entityScope } : {}),
              useKeyword: signals.keyword,
            }).catch((err) => { this.logger?.warn(`MemoryRunner failed: ${err instanceof Error ? err.message : err}`); warnings.push(`Memory search failed: ${err instanceof Error ? err.message : String(err)}`); return [] as RetrievalCandidate[] }),
            timeouts.memory,
            [] as RetrievalCandidate[]
          )

      const graphPromise = !needsGraph
        ? Promise.resolve({ results: [], facts: [], entities: [] } as GraphRunResult)
        : withTimeout(
            new GraphRunner(this.knowledgeGraph!).run(text, identity, count, activeBucketIds, {
              ...opts.graph,
              ...(opts.entityScope ? { entityScope: opts.entityScope, resolvedEntityIds: scopedEntityIds } : {}),
            })
              .catch((err) => { this.logger?.warn(`GraphRunner failed: ${err instanceof Error ? err.message : err}`); warnings.push(`Graph search failed: ${err instanceof Error ? err.message : String(err)}`); return { results: [], facts: [], entities: [] } as GraphRunResult }),
            timeouts.graph,
            { results: [], facts: [], entities: [] } as GraphRunResult
          )

      const [memResults, graphRun] = await Promise.all([
        memoryPromise,
        graphPromise,
      ])
      const graphResults = graphRun.results
      graphFacts = [...graphFacts, ...graphRun.facts]
      graphEntities = [...graphEntities, ...graphRun.entities]
      graphTrace = graphRun.trace

      if (memResults.length > 0) {
        // Memory results already carry semantic similarity scores from the memory
        // store's embedding search (via metadata._similarity → rawScores.semantic).
        // No need to re-embed here — the MemoryRunner handles this.
        runnerArrays.push(memResults)
        bucketTimings['__memory__'] = { mode: 'memory', resultCount: memResults.length, durationMs: Date.now() - startMs, status: 'ok' }
      }
      if (graphResults.length > 0) {
        const reinforcement = opts.graphReinforcement ?? 'off'

        if (reinforcement === 'off') {
          // Include all graph results as-is
          runnerArrays.push(graphResults)
        } else if (reinforcement === 'prefer') {
          // Keep all graph results but boost those matching indexed chunks
          if (allResults.length > 0) {
            const indexedChunks = new Set(allResults.map(resultIdentityKey))
            for (const gr of graphResults) {
              if (indexedChunks.has(resultIdentityKey(gr))) {
                // Boost reinforcing graph results
                gr.rawScores.graph = (gr.rawScores.graph ?? 0) * 1.5
              }
            }
          }
          runnerArrays.push(graphResults)
        } else {
          // 'only': keep graph results whose chunk identity matches an indexed result
          if (allResults.length > 0) {
            const indexedChunks = new Set(allResults.map(resultIdentityKey))
            const reinforcing = graphResults.filter(r => indexedChunks.has(resultIdentityKey(r)))
            if (reinforcing.length > 0) {
              runnerArrays.push(reinforcing)
            }
          } else {
            runnerArrays.push(graphResults)
          }
        }
        bucketTimings['__graph__'] = { mode: 'graph', resultCount: graphResults.length, durationMs: Date.now() - startMs, status: 'ok' }
      }
    }

    // Merge and rank
    const needsMerge = runnerArrays.length > 1 || modelGroups.size > 1
    const mergedResults = needsMerge
      ? mergeAndRank(runnerArrays, count, undefined, signals, effectiveScoreWeights)
      : allResults.slice(0, count)

    const results = partitionResults(mergedResults, signals, Math.max(1, runnerArrays.length), needsGraph, needsMemory, graphFacts, graphEntities, graphTrace, effectiveScoreWeights)

    const durationMs = Date.now() - startMs
    const counts = resultCounts(results)

    if (this.eventSink) {
      const event: typegraphEvent = {
        id: crypto.randomUUID(),
        eventType: 'query.execute',
        identity,
        payload: {
          query: text,
          signals,
          requested_count: count,
          result_count: counts.resultCount,
          chunk_count: counts.chunkCount,
          fact_count: counts.factCount,
          entity_count: counts.entityCount,
          memory_count: counts.memoryCount,
          bucket_count: activeBucketIds.length,
        },
        durationMs,
        traceId: opts.traceId,
        spanId: opts.spanId,
        timestamp: new Date(),
      }
      void this.eventSink.emit(event)
    }

    this.logger?.debug('Query complete', { durationMs, resultCount: counts.resultCount, signals })

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
    default: return mode
  }
}

function sourcesForResult(modes: string[], rawScores: RawScores, signals: Required<QuerySignals>): string[] {
  const sources = new Set<string>()
  for (const mode of modes) {
    if (mode === 'indexed') {
      if (signals.semantic && rawScores.cosineSimilarity != null) sources.add('semantic')
      if (signals.keyword && rawScores.bm25 != null) sources.add('keyword')
      continue
    }
    sources.add(modeToSource(mode))
  }
  return [...sources]
}

function resultIdentityKey(result: RetrievalCandidate): string {
  if (result.sourceId && result.chunk?.index !== undefined && result.bucketId) {
    return `${result.bucketId}:${result.sourceId}:${result.chunk.index}`
  }
  return result.content
}

/** Dot product of two vectors — equivalent to cosine similarity when vectors are L2-normalized
 *  (which embedding models typically return). */
