import type { Bucket } from '../types/bucket.js'
import type { QueryChunkResult, QueryResponse, QueryResults, RetrievalSwitches, RawScores, NormalizedScores, SearchOptions, SearchResource, SearchWeights, SearchFusion, OutputScores, SearchRerankExplanation } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { Embedder } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { EntityResult, FactResult, GraphSearchTrace, KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { typegraphEvent, typegraphEventSink } from '../types/events.js'
import type { typegraphLogger } from '../types/logger.js'
import type { ChunkRef } from '../types/chunk.js'
import type { Reranker } from '../types/extractor.js'
import { ConfigError } from '../types/errors.js'
import { compactTypeGraphContext, contextTelemetry, contextToIdentity, optionalCompactObject } from '../utils/input.js'
import { IndexedRunner } from './runners/indexed.js'
import { GraphRunner, type GraphRunResult } from './runners/graph-runner.js'
import { mergeAndRank, normalizeRRF, normalizeGraphPPR, calibrateSemantic, calibrateKeyword, type RetrievalCandidate } from './merger.js'
import { classifyQuery } from './classifier.js'

type ScoreWeightKey = 'rrf' | 'semantic' | 'keyword' | 'graph' | 'recency'

const DEFAULT_SEARCH_RESOURCES: SearchResource[] = ['documents', 'events', 'threads', 'entities', 'facts']
const DEFAULT_SEARCH_WEIGHTS: Required<Record<keyof SearchWeights, number | false>> = {
  semantic: 1,
  bm25: 0.7,
  graph: 0.5,
  recency: 0.3,
}
const DEFAULT_FUSION: Required<SearchFusion> = { method: 'rrf', k: 60 }
const DEFAULT_SEARCH_LIMIT = 10
const MAX_RERANK_CANDIDATES = 100

function resolveResources(opts?: SearchOptions | null): SearchResource[] {
  const resources = opts?.resources ?? DEFAULT_SEARCH_RESOURCES
  return [...new Set(resources)]
}

function resolveWeights(opts?: SearchOptions | null): Required<Record<keyof SearchWeights, number | false>> {
  return {
    semantic: opts?.weights?.semantic ?? DEFAULT_SEARCH_WEIGHTS.semantic,
    bm25: opts?.weights?.bm25 ?? DEFAULT_SEARCH_WEIGHTS.bm25,
    graph: opts?.weights?.graph ?? DEFAULT_SEARCH_WEIGHTS.graph,
    recency: opts?.weights?.recency ?? DEFAULT_SEARCH_WEIGHTS.recency,
  }
}

function resolveFusion(opts?: SearchOptions | null): Required<SearchFusion> {
  return {
    method: opts?.fusion?.method ?? DEFAULT_FUSION.method,
    k: opts?.fusion?.k ?? DEFAULT_FUSION.k,
  }
}

function hasWeight(value: number | false | undefined): value is number {
  return typeof value === 'number' && value > 0
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function resolveRequestedCount(opts: SearchOptions): number {
  const explicitLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit)
    ? Math.max(0, Math.floor(opts.limit))
    : undefined
  if (explicitLimit !== undefined) return explicitLimit

  const rerankTopK = typeof opts.rerank === 'object' && opts.rerank !== null
    ? positiveInteger(opts.rerank.topK)
    : undefined
  return rerankTopK ?? DEFAULT_SEARCH_LIMIT
}

function resolveRerankTopK(opts: SearchOptions, finalCount: number): number {
  if (typeof opts.rerank === 'object' && opts.rerank !== null) {
    return positiveInteger(opts.rerank.topK) ?? finalCount
  }
  return finalCount
}

function rerankRequested(opts: SearchOptions): boolean {
  return opts.rerank === true || (typeof opts.rerank === 'object' && opts.rerank !== null)
}

function resolveRerankCandidateLimit(topK: number): number {
  return Math.min(Math.max(topK * 3, topK + 10), MAX_RERANK_CANDIDATES)
}

/** Resolve public resources/weights into internal retrieval switches. */
function resolveRetrievalSwitches(opts?: SearchOptions | null): Required<RetrievalSwitches> {
  const normalizedOpts = optionalCompactObject<SearchOptions>(opts, 'resolveRetrievalSwitches') as SearchOptions
  const resources = new Set(resolveResources(normalizedOpts))
  const weights = resolveWeights(normalizedOpts)
  const wantsIndexed = resources.has('documents') || resources.has('events') || resources.has('threads')
  const wantsGraphRecords = resources.has('entities') || resources.has('facts')
  return {
    semantic: wantsIndexed && hasWeight(weights.semantic),
    keyword: wantsIndexed && hasWeight(weights.bm25),
    graph: wantsGraphRecords && hasWeight(weights.graph),
    recency: hasWeight(weights.recency),
  }
}

/** Compute composite score with eligible/ineligible distinction.
 *  - `undefined` value = ineligible (result can't have this score, e.g. a document has no graph score).
 *    Weight is redistributed proportionally to eligible categories.
 *  - `0` value = eligible but scored poorly. Full penalty proportional to category weight.
 *  This prevents one retrieval path from penalizing records that cannot participate in another. */
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

/** Default weight profiles per retrieval combination.
 *  RRF is excluded — it's a rank-fusion technique for merging lists,
 *  not a relevance weight. It's used during merge-time ranking only. */
function getDefaultWeights(switches: Required<RetrievalSwitches>): Record<string, number> {
  const weights: Record<string, number> = {}
  if (switches.semantic) weights.semantic = DEFAULT_SEARCH_WEIGHTS.semantic as number
  if (switches.keyword) weights.keyword = DEFAULT_SEARCH_WEIGHTS.bm25 as number
  if (switches.graph) weights.graph = DEFAULT_SEARCH_WEIGHTS.graph as number
  if (switches.recency) weights.recency = DEFAULT_SEARCH_WEIGHTS.recency as number
  return Object.keys(weights).length > 0 ? weights : { semantic: 1.0 }
}

/** Compute composite score from normalized retrieval scores and weights.
 *  When no explicit weights are provided, derives defaults from active retrieval paths.
 *  Distinguishes ineligible (undefined → redistribute weight) from scored-0 (penalize). */
export function computeCompositeScore(
  normalizedScores: NormalizedScores,
  switches: Required<RetrievalSwitches>,
  userWeights?: Partial<Record<ScoreWeightKey, number>>
): number {
  const weights = (userWeights && Object.keys(userWeights).length > 0)
    ? userWeights
    : getDefaultWeights(switches)

  const components: Array<{ weight: number; value: number | undefined }> = []

  if (weights.semantic) components.push({ weight: weights.semantic, value: normalizedScores.semantic })
  if (weights.keyword) components.push({ weight: weights.keyword, value: normalizedScores.keyword })
  if (weights.graph) components.push({ weight: weights.graph, value: normalizedScores.graph })
  if (weights.recency) components.push({ weight: weights.recency, value: normalizedScores.recency })
  // Allow user to include RRF in explicit weights if they want
  if (weights.rrf) components.push({ weight: weights.rrf, value: normalizedScores.rrf })

  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0)
  const normalizedComponents = totalWeight > 0
    ? components.map(component => ({ ...component, weight: component.weight / totalWeight }))
    : components
  return compositeScore(normalizedComponents)
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

function recencyScore(date?: Date | null, now = Date.now()): number | undefined {
  if (!date) return undefined
  const ageMs = Math.max(0, now - date.getTime())
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000
  return Math.exp(-ageMs / halfLifeMs)
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
  scores: { raw: RawScores; normalized: NormalizedScores; output: OutputScores }
  matchedBy: string[]
  modes: string[]
}

interface RerankState {
  requested: boolean
  applied: boolean
  topK: number
  candidateLimit: number
  candidateCount: number
  finalCount: number
  reranker?: string | undefined
  warning?: string | undefined
}

function scoreCandidate(
  r: RetrievalCandidate,
  switches: Required<RetrievalSwitches>,
  runnerArrayCount: number,
  needsGraph: boolean,
  effectiveScoreWeights?: Partial<Record<ScoreWeightKey, number>>,
): ScoredCandidate {
  const merged = r as RetrievalCandidate & { modes?: string[]; finalScore?: number; compositeScore?: number }
  const agg = merged.rawScores ?? r.rawScores
  const rawRrf = merged.finalScore ?? agg.rrf ?? r.normalizedScore
  const rawScores: RawScores = {}
  const normalizedScores: NormalizedScores = {}
  const modes: string[] = merged.modes ?? [r.mode]

  if (switches.semantic) {
    const semanticScore = agg.semantic
    rawScores.cosineSimilarity = semanticScore
    normalizedScores.semantic = calibrateSemantic(semanticScore ?? 0)
  }

  if (switches.keyword) {
    rawScores.bm25 = agg.keyword
    rawScores.rrf = rawRrf
    normalizedScores.keyword = calibrateKeyword(agg.keyword ?? 0)
    const numListsForRRF = merged.compositeScore != null ? runnerArrayCount : 2
    const baseRRF = normalizeRRF(rawRrf, numListsForRRF)
    const matchedBothLists = (agg.keyword ?? 0) > 0
    normalizedScores.rrf = matchedBothLists ? baseRRF : baseRRF * 0.5
  } else if (switches.semantic && needsGraph && merged.compositeScore != null) {
    rawScores.rrf = rawRrf
    normalizedScores.rrf = normalizeRRF(rawRrf, runnerArrayCount)
  }

  if (switches.graph) {
    rawScores.ppr = agg.graph
    normalizedScores.graph = normalizeGraphPPR(agg.graph ?? 0)
  }

  if (switches.recency) {
    const recency = agg.recency ?? r.rawScores.recency ?? recencyScore(r.updatedAt)
    rawScores.recency = recency
    normalizedScores.recency = recency
  }

  const score = computeCompositeScore(normalizedScores, switches, effectiveScoreWeights)
  return {
    score,
    scores: {
      raw: rawScores,
      normalized: normalizedScores,
      output: {
        semantic: normalizedScores.semantic,
        bm25: normalizedScores.keyword,
        graph: normalizedScores.graph,
        recency: normalizedScores.recency,
        fused: score,
      },
    },
    matchedBy: matchedByForResult(modes, rawScores, switches),
    modes,
  }
}

function toChunkResult(r: RetrievalCandidate, scored: ScoredCandidate): QueryChunkResult {
  return {
    content: r.content,
    score: scored.score,
    scores: scored.scores,
    matchedBy: scored.matchedBy,
    document: {
      id: r.documentId,
      bucketId: r.bucketId,
      graph: r.graphId ?? 'public',
      name: r.name ?? '',
      url: r.url,
      updatedAt: r.updatedAt ?? new Date(),
      status: r.documentStatus,
    },
    chunk: r.chunk ?? { index: 0, total: 1 },
    metadata: r.metadata,
  }
}

function partitionResults(
  candidates: RetrievalCandidate[],
  switches: Required<RetrievalSwitches>,
  runnerArrayCount: number,
  needsGraph: boolean,
  graphFacts: FactResult[],
  graphEntities: EntityResult[],
  graphTrace?: GraphSearchTrace | undefined,
  effectiveScoreWeights?: Partial<Record<ScoreWeightKey, number>>,
): QueryResults {
  const chunks: QueryChunkResult[] = []

  for (const candidate of candidates) {
    const scored = scoreCandidate(candidate, switches, runnerArrayCount, needsGraph, effectiveScoreWeights)
    chunks.push(toChunkResult(candidate, scored))
  }

  return {
    chunks,
    facts: graphFacts.length > 0 ? uniqueById(graphFacts) : [],
    entities: graphEntities.length > 0 ? uniqueById(graphEntities) : [],
    ...(switches.graph && graphTrace ? { graphTrace } : {}),
  }
}

function chunkResultIdentityKey(result: QueryChunkResult): string {
  if (result.document.id && result.chunk.index !== undefined && result.document.bucketId) {
    return `${result.document.bucketId}:${result.document.id}:${result.chunk.index}`
  }
  return result.content
}

function isQueryChunkResult(value: unknown): value is QueryChunkResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<QueryChunkResult>
  return typeof candidate.content === 'string' &&
    typeof candidate.score === 'number' &&
    typeof candidate.document?.id === 'string' &&
    typeof candidate.document?.bucketId === 'string' &&
    typeof candidate.chunk?.index === 'number'
}

function normalizeRerankedChunks(original: QueryChunkResult[], returned: unknown[]): QueryChunkResult[] {
  const byKey = new Map(original.map(chunk => [chunkResultIdentityKey(chunk), chunk]))
  const used = new Set<string>()
  const ordered: QueryChunkResult[] = []

  for (const value of returned) {
    if (!isQueryChunkResult(value)) continue
    const key = chunkResultIdentityKey(value)
    if (used.has(key)) continue
    const originalChunk = byKey.get(key)
    if (!originalChunk) continue
    used.add(key)
    ordered.push(originalChunk)
  }

  for (const chunk of original) {
    const key = chunkResultIdentityKey(chunk)
    if (used.has(key)) continue
    used.add(key)
    ordered.push(chunk)
  }

  return ordered
}

function rerankScore(index: number, total: number): number {
  if (total <= 1) return 1
  return (total - index) / total
}

function applyRerankScores(chunks: QueryChunkResult[]): QueryChunkResult[] {
  const total = chunks.length
  return chunks.map((chunk, index) => {
    const score = rerankScore(index, total)
    return {
      ...chunk,
      score,
      scores: {
        ...chunk.scores,
        output: {
          ...chunk.scores.output,
          reranker: score,
        },
      },
    }
  })
}

async function applyReranker(
  query: string,
  chunks: QueryChunkResult[],
  reranker: Reranker<QueryChunkResult>,
  state: RerankState,
  abortSignal?: AbortSignal,
): Promise<QueryChunkResult[]> {
  const reranked = await reranker.rerank(query, chunks, {
    topK: state.topK,
    abortSignal,
  })
  const returned = Array.isArray(reranked) ? reranked : []
  const ordered = normalizeRerankedChunks(chunks, returned)
  state.applied = true
  state.candidateCount = chunks.length
  return applyRerankScores(ordered)
}

function rerankExplanation(state: RerankState): SearchRerankExplanation | undefined {
  if (!state.requested) return undefined
  const explanation: SearchRerankExplanation = {
    requested: state.requested,
    applied: state.applied,
    topK: state.topK,
    candidateCount: state.candidateCount,
    finalCount: state.finalCount,
  }
  if (state.reranker) explanation.reranker = state.reranker
  if (state.warning) explanation.warning = state.warning
  return explanation
}

function resultCounts(results: QueryResults): {
  resultCount: number
  chunkCount: number
  factCount: number
  entityCount: number
} {
  const chunkCount = results.chunks.length
  return {
    resultCount: chunkCount,
    chunkCount,
    factCount: results.facts.length,
    entityCount: results.entities.length,
  }
}

function buildExplanation(
  opts: {
    requestedGraph: string
    graphClosure: string[]
    resources: SearchResource[]
    weights: Required<Record<keyof SearchWeights, number | false>>
    fusion: Required<SearchFusion>
    results: QueryResults
    bucketTimings: QueryResponse['buckets']
    graphTrace?: GraphSearchTrace | undefined
    rerank?: SearchRerankExplanation | undefined
    warnings: string[]
    skippedResources?: Partial<Record<SearchResource, string>> | undefined
  }
): QueryResponse['explanation'] {
  const counts = resultCounts(opts.results)
  const explanation: NonNullable<QueryResponse['explanation']> = {
    requestedGraph: opts.requestedGraph,
    graphClosure: opts.graphClosure,
    activeResources: opts.resources,
    activeWeights: opts.weights,
    fusion: opts.fusion,
    candidateCounts: {
      documents: counts.chunkCount,
      facts: counts.factCount,
      entities: counts.entityCount,
    },
    timings: Object.fromEntries(
      Object.entries(opts.bucketTimings).map(([key, value]) => [key, value.durationMs])
    ),
  }
  if (opts.graphTrace) explanation.graphTrace = opts.graphTrace
  if (opts.rerank) explanation.rerank = opts.rerank
  if (opts.warnings.length > 0) explanation.warnings = opts.warnings
  if (opts.skippedResources) explanation.skippedResources = opts.skippedResources
  return explanation
}

function boostScopedCandidates(candidates: RetrievalCandidate[], chunkRefs: ChunkRef[]): void {
  if (chunkRefs.length === 0) return
    const scoped = new Set(chunkRefs.map(ref => `${ref.bucketId}:${ref.documentId}:${ref.chunkIndex}`))
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
    private bucketEmbeddings: Map<string, Embedder>,
    private bucketSearchEmbeddings: Map<string, Embedder>,
    private knowledgeGraph?: KnowledgeGraphBridge,
    private eventSink?: typegraphEventSink,
    private logger?: typegraphLogger,
    private tenantId?: string,
    private reranker?: Reranker<QueryChunkResult>,
  ) {}

  async execute(text: string, opts?: SearchOptions | null): Promise<QueryResponse> {
    const normalizedOpts = optionalCompactObject<SearchOptions>(opts, 'QueryPlanner.execute') as SearchOptions
    const startMs = Date.now()
    const count = resolveRequestedCount(normalizedOpts)
    const resources = resolveResources(normalizedOpts)
    const publicWeights = resolveWeights(normalizedOpts)
    const fusion = resolveFusion(normalizedOpts)
    const context = compactTypeGraphContext(normalizedOpts.context, 'search')
    const telemetry = contextTelemetry(context)
    const identity = contextToIdentity(context, this.tenantId)
    const switches = resolveRetrievalSwitches(normalizedOpts)
    const requestedGraph = normalizedOpts.graph ?? 'public'
    const graphIds = normalizedOpts.graphIds ?? [requestedGraph]
    const onBucketError = normalizedOpts.onBucketError ?? 'throw'
    const shouldRerank = rerankRequested(normalizedOpts)
    const rerankTopK = resolveRerankTopK(normalizedOpts, count)
    const rerankState: RerankState = {
      requested: shouldRerank,
      applied: false,
      topK: rerankTopK,
      candidateLimit: count,
      candidateCount: count,
      finalCount: count,
    }
    if (shouldRerank && this.reranker && count > 0) {
      rerankState.reranker = this.reranker.name
      rerankState.candidateLimit = resolveRerankCandidateLimit(rerankTopK)
    }
    const retrievalCount = shouldRerank && this.reranker && count > 0 ? rerankState.candidateLimit : count

    // Auto-weights: classify query type and use optimized weight profile.
    // User-provided weights always override.
    let effectiveScoreWeights: Partial<Record<ScoreWeightKey, number>> | undefined = {
      ...(publicWeights.semantic !== false ? { semantic: publicWeights.semantic } : {}),
      ...(publicWeights.bm25 !== false ? { keyword: publicWeights.bm25 } : {}),
      ...(publicWeights.graph !== false ? { graph: publicWeights.graph } : {}),
      ...(publicWeights.recency !== false ? { recency: publicWeights.recency } : {}),
    }
    if (Object.keys(effectiveScoreWeights).length === 0) effectiveScoreWeights = undefined
    if (normalizedOpts.autoWeights && !normalizedOpts.weights) {
      const classification = classifyQuery(text)
      const classified: Partial<Record<ScoreWeightKey, number>> = {}
      if (classification.weights.semantic !== undefined) classified.semantic = classification.weights.semantic
      if (classification.weights.keyword !== undefined) classified.keyword = classification.weights.keyword
      if (classification.weights.graph !== undefined) classified.graph = classification.weights.graph
      if (publicWeights.recency !== false) classified.recency = publicWeights.recency
      effectiveScoreWeights = classified
      this.logger?.debug('Auto-weights', { queryType: classification.type, confidence: classification.confidence, weights: classification.weights })
    }

    this.logger?.debug('Search start', { text: text.slice(0, 100), retrieval: switches, count, retrievalCount, rerank: shouldRerank })

    // Filter to requested buckets or use all
    const activeBucketIds = normalizedOpts.buckets
      ? normalizedOpts.buckets.filter(id => this.bucketIds.includes(id))
      : this.bucketIds

    // Group documents by ingest embedding model (determines table routing).
    // Attach query embedder (may differ from ingest model).
    const modelGroups = new Map<string, { embedding: Embedder; ingestModelId: string; bucketIds: string[] }>()
    const warnings: string[] = []

    for (const bucketId of activeBucketIds) {
      const ingestEmb = this.bucketEmbeddings.get(bucketId)
      if (!ingestEmb) {
        warnings.push(`Bucket "${bucketId}" has no embedder - skipped`)
        continue
      }
      const queryEmb = this.bucketSearchEmbeddings.get(bucketId) ?? ingestEmb
      const ingestModelId = embeddingModelKey(ingestEmb)

      const existing = modelGroups.get(ingestModelId)
      if (existing) {
        existing.bucketIds.push(bucketId)
      } else {
        modelGroups.set(ingestModelId, { embedding: queryEmb, ingestModelId, bucketIds: [bucketId] })
      }
    }

    const needsIndexedSearch = switches.semantic || switches.keyword
    const needsGraph = Boolean(switches.graph && this.knowledgeGraph)
    const entityScopeMode = normalizedOpts.entityScope?.mode ?? 'filter'
    let scopedEntityIds: string[] = []
    let scopedChunkRefs: ChunkRef[] = []
    const graphScopedQuery = Boolean(normalizedOpts.entityScope && (needsIndexedSearch || switches.graph))
    if (normalizedOpts.entityScope && graphScopedQuery) {
      if (!this.knowledgeGraph?.resolveEntityScope) {
        throw new ConfigError('entityScope requires a knowledge graph bridge with entity scope resolution.')
      }
      const resolved = await this.knowledgeGraph.resolveEntityScope(normalizedOpts.entityScope, identity, {
        bucketIds: activeBucketIds,
        limit: Math.max(retrievalCount * 50, 200),
      })
      scopedEntityIds = resolved.entityIds
      scopedChunkRefs = resolved.chunkRefs
      if (resolved.warnings) warnings.push(...resolved.warnings)
    }

    // Timeouts (user-configurable or defaults)
    const timeouts = {
      indexed: normalizedOpts.timeouts?.indexed ?? 30_000,
      graph: normalizedOpts.timeouts?.graph ?? 30_000,
    }

    // Graph-only (no indexed search)
    if (!needsIndexedSearch && needsGraph) {
      const runnerArrays: RetrievalCandidate[][] = []
      let graphFacts: FactResult[] = []
      let graphEntities: EntityResult[] = []
      let graphTrace: GraphSearchTrace | undefined

      // Graph runner
      if (needsGraph) {
        try {
          const graphRunner = new GraphRunner(this.knowledgeGraph!)
          const graphRun = await withTimeout(
            graphRunner.run(text, identity, retrievalCount, activeBucketIds, {
              ...normalizedOpts.graphOptions,
              ...(normalizedOpts.entityScope ? { entityScope: normalizedOpts.entityScope, resolvedEntityIds: scopedEntityIds } : {}),
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
        ? mergeAndRank(runnerArrays, retrievalCount, undefined, switches, effectiveScoreWeights)
        : (runnerArrays[0] ?? []).slice(0, retrievalCount)

      const results = partitionResults(allResults, switches, Math.max(1, runnerArrays.length), needsGraph, graphFacts, graphEntities, graphTrace, effectiveScoreWeights)
      let rerankWarning: string | undefined
      if (shouldRerank && !this.reranker) {
        rerankWarning = 'Search rerank was requested but no reranker is configured; returning non-reranked results.'
        rerankState.warning = rerankWarning
        warnings.push(rerankWarning)
        this.logger?.warn(rerankWarning)
      } else if (shouldRerank && this.reranker && results.chunks.length > 0) {
        try {
          results.chunks = await applyReranker(text, results.chunks, this.reranker, rerankState, normalizedOpts.abortSignal)
        } catch (err) {
          rerankWarning = `Search reranker failed: ${err instanceof Error ? err.message : String(err)}; returning non-reranked results.`
          rerankState.warning = rerankWarning
          warnings.push(rerankWarning)
          this.logger?.warn(rerankWarning)
        }
      }
      rerankState.candidateCount = results.chunks.length
      results.chunks = results.chunks.slice(0, count)

      const bucketTimings: QueryResponse['buckets'] = {}
      if (needsGraph) bucketTimings['__graph__'] = { mode: 'graph', resultCount: results.chunks.filter(result => result.matchedBy.includes('graph')).length, durationMs: Date.now() - startMs, status: 'ok' }

      const durationMs = Date.now() - startMs
      const counts = resultCounts(results)

      if (this.eventSink) {
        const event: typegraphEvent = {
          id: crypto.randomUUID(),
          eventType: 'query.execute',
          identity,
          payload: {
            query: text,
            retrieval: switches,
            requested_count: count,
            candidate_count: rerankState.candidateCount,
            candidate_limit: retrievalCount,
            result_count: counts.resultCount,
            chunk_count: counts.chunkCount,
            fact_count: counts.factCount,
            entity_count: counts.entityCount,
            bucket_count: activeBucketIds.length,
            requested_graph: requestedGraph,
            graph_closure: graphIds,
            active_bucket_ids: activeBucketIds,
            rerank_requested: rerankState.requested,
            rerank_applied: rerankState.applied,
            reranker: rerankState.reranker,
          },
          durationMs,
          traceId: telemetry.traceId,
          spanId: telemetry.spanId,
          timestamp: new Date(),
        }
        void this.eventSink.emit(event)
      }

      this.logger?.debug('Query complete', { durationMs, resultCount: counts.resultCount })

      return {
        results,
        buckets: bucketTimings,
        query: { text, durationMs, mergeStrategy: rerankState.applied ? 'rrf+rerank' : 'rrf' },
        explanation: normalizedOpts.explain
          ? buildExplanation({ requestedGraph, graphClosure: graphIds, resources, weights: publicWeights, fusion, results, bucketTimings, graphTrace, rerank: rerankExplanation(rerankState), warnings })
          : undefined,
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
            retrievalCount,
            identity,
            { ...(normalizedOpts.documentFilter ?? {}), tenantId: identity.tenantId, graphIds },
            switches,
            telemetry.traceId,
            telemetry.spanId,
            normalizedOpts.asOf === 'now' ? undefined : normalizedOpts.asOf,
            normalizedOpts.entityScope && entityScopeMode === 'filter' ? scopedChunkRefs : undefined,
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
            const documentResults = results.filter(r => r.bucketId === bucketId)
            bucketTimings[bucketId] = {
              mode: 'indexed',
              resultCount: documentResults.length,
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

    // Run graph runner if weights/resources request it.
    const runnerArrays: RetrievalCandidate[][] = [allResults]
    let graphFacts: FactResult[] = []
    let graphEntities: EntityResult[] = []
    let graphTrace: GraphSearchTrace | undefined
    if (normalizedOpts.entityScope && entityScopeMode === 'boost') {
      boostScopedCandidates(allResults, scopedChunkRefs)
    }
    if (needsIndexedSearch && this.knowledgeGraph?.searchKnowledge) {
      try {
        const direct = await this.knowledgeGraph.searchKnowledge(text, identity, {
          count: retrievalCount,
          retrieval: switches,
          entityScope: normalizedOpts.entityScope,
          resolvedEntityIds: scopedEntityIds,
          asOf: normalizedOpts.asOf,
          validBetween: normalizedOpts.validBetween,
          includeInvalidated: normalizedOpts.includeInvalidated,
        })
        graphFacts = direct.facts
        graphEntities = direct.entities
      } catch (err) {
        const msg = `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}`
        warnings.push(msg)
        this.logger?.warn(msg)
      }
    }
    if (needsGraph) {
      const graphRun = await withTimeout(
        new GraphRunner(this.knowledgeGraph!).run(text, identity, retrievalCount, activeBucketIds, {
          ...normalizedOpts.graphOptions,
          asOf: normalizedOpts.asOf,
          validBetween: normalizedOpts.validBetween,
          includeInvalidated: normalizedOpts.includeInvalidated,
          ...(normalizedOpts.entityScope ? { entityScope: normalizedOpts.entityScope, resolvedEntityIds: scopedEntityIds } : {}),
        })
          .catch((err) => { this.logger?.warn(`GraphRunner failed: ${err instanceof Error ? err.message : err}`); warnings.push(`Graph search failed: ${err instanceof Error ? err.message : String(err)}`); return { results: [], facts: [], entities: [] } as GraphRunResult }),
        timeouts.graph,
        { results: [], facts: [], entities: [] } as GraphRunResult
      )
      const graphResults = graphRun.results
      graphFacts = [...graphFacts, ...graphRun.facts]
      graphEntities = [...graphEntities, ...graphRun.entities]
      graphTrace = graphRun.trace

      if (graphResults.length > 0) {
        const reinforcement = normalizedOpts.graphReinforcement ?? 'off'

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
      ? mergeAndRank(runnerArrays, retrievalCount, undefined, switches, effectiveScoreWeights)
      : allResults.slice(0, retrievalCount)

    const results = partitionResults(mergedResults, switches, Math.max(1, runnerArrays.length), needsGraph, graphFacts, graphEntities, graphTrace, effectiveScoreWeights)
    let rerankWarning: string | undefined
    if (shouldRerank && !this.reranker) {
      rerankWarning = 'Search rerank was requested but no reranker is configured; returning non-reranked results.'
      rerankState.warning = rerankWarning
      warnings.push(rerankWarning)
      this.logger?.warn(rerankWarning)
    } else if (shouldRerank && this.reranker && results.chunks.length > 0) {
      try {
        results.chunks = await applyReranker(text, results.chunks, this.reranker, rerankState, normalizedOpts.abortSignal)
      } catch (err) {
        rerankWarning = `Search reranker failed: ${err instanceof Error ? err.message : String(err)}; returning non-reranked results.`
        rerankState.warning = rerankWarning
        warnings.push(rerankWarning)
        this.logger?.warn(rerankWarning)
      }
    }
    rerankState.candidateCount = results.chunks.length
    results.chunks = results.chunks.slice(0, count)

    const durationMs = Date.now() - startMs
    const counts = resultCounts(results)

    if (this.eventSink) {
      const event: typegraphEvent = {
        id: crypto.randomUUID(),
        eventType: 'query.execute',
        identity,
        payload: {
          query: text,
          retrieval: switches,
          requested_count: count,
          candidate_count: rerankState.candidateCount,
          candidate_limit: retrievalCount,
          result_count: counts.resultCount,
          chunk_count: counts.chunkCount,
          fact_count: counts.factCount,
          entity_count: counts.entityCount,
          bucket_count: activeBucketIds.length,
          requested_graph: requestedGraph,
          graph_closure: graphIds,
          active_bucket_ids: activeBucketIds,
          rerank_requested: rerankState.requested,
          rerank_applied: rerankState.applied,
          reranker: rerankState.reranker,
        },
        durationMs,
        traceId: telemetry.traceId,
        spanId: telemetry.spanId,
        timestamp: new Date(),
      }
      void this.eventSink.emit(event)
    }

    this.logger?.debug('Search complete', { durationMs, resultCount: counts.resultCount, retrieval: switches })

    return {
      results,
      buckets: bucketTimings,
      query: {
        text,
        durationMs,
        mergeStrategy: rerankState.applied ? 'rrf+rerank' : 'rrf',
      },
      explanation: normalizedOpts.explain
        ? buildExplanation({ requestedGraph, graphClosure: graphIds, resources, weights: publicWeights, fusion, results, bucketTimings, graphTrace, rerank: rerankExplanation(rerankState), warnings })
        : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }
}

/** Map internal runner mode names to user-facing retrieval labels. */
function modeToRetrievalLabel(mode: string): string {
  switch (mode) {
    case 'indexed': return 'semantic'
    case 'graph': return 'graph'
    default: return mode
  }
}

function matchedByForResult(modes: string[], rawScores: RawScores, switches: Required<RetrievalSwitches>): string[] {
  const matchedBy = new Set<string>()
  for (const mode of modes) {
    if (mode === 'indexed') {
      if (switches.semantic && rawScores.cosineSimilarity != null) matchedBy.add('semantic')
      if (switches.keyword && rawScores.bm25 != null) matchedBy.add('bm25')
      continue
    }
    matchedBy.add(modeToRetrievalLabel(mode))
  }
  return [...matchedBy]
}

function resultIdentityKey(result: RetrievalCandidate): string {
  if (result.documentId && result.chunk?.index !== undefined && result.bucketId) {
    return `${result.bucketId}:${result.documentId}:${result.chunk.index}`
  }
  return result.content
}

/** Dot product of two vectors — equivalent to cosine similarity when vectors are L2-normalized
 *  (which embedding models typically return). */
