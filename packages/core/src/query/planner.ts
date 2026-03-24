import type { d8umSource } from '../types/source.js'
import type { QueryOpts, QueryResponse, d8umResult } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import { IndexedRunner } from './runners/indexed.js'
import { mergeAndRank, type NormalizedResult } from './merger.js'

export class QueryPlanner {
  constructor(
    private adapter: VectorStoreAdapter,
    private sources: Map<string, d8umSource>,
    private sourceEmbeddings: Map<string, EmbeddingProvider>
  ) {}

  async execute(text: string, opts: QueryOpts = {}): Promise<QueryResponse> {
    const startMs = Date.now()
    const topK = opts.topK ?? 10
    const tenantId = opts.tenantId
    const warnings: string[] = []

    // Filter to requested sources or use all
    const sourceIds = opts.sources ?? [...this.sources.keys()]
    const activeSources = sourceIds
      .map(id => this.sources.get(id))
      .filter((s): s is d8umSource => s != null)

    // Separate by mode — only indexed supported in this iteration
    const indexedSources = activeSources.filter(s => s.mode === 'indexed')
    const liveSources = activeSources.filter(s => s.mode === 'live')
    const cachedSources = activeSources.filter(s => s.mode === 'cached')

    if (liveSources.length > 0) {
      warnings.push(`${liveSources.length} live source(s) skipped — live mode not yet supported`)
    }
    if (cachedSources.length > 0) {
      warnings.push(`${cachedSources.length} cached source(s) skipped — cached mode not yet supported`)
    }

    // Group indexed sources by embedding model
    const modelGroups = new Map<string, { embedding: EmbeddingProvider; sourceIds: string[] }>()
    for (const source of indexedSources) {
      const emb = this.sourceEmbeddings.get(source.id)
      if (!emb) {
        warnings.push(`Source "${source.id}" has no embedding provider — skipped`)
        continue
      }
      const existing = modelGroups.get(emb.model)
      if (existing) {
        existing.sourceIds.push(source.id)
      } else {
        modelGroups.set(emb.model, { embedding: emb, sourceIds: [source.id] })
      }
    }

    // Run indexed search
    const sourceTimings: QueryResponse['sources'] = {}
    let allResults: NormalizedResult[] = []

    if (modelGroups.size > 0) {
      const runnerStart = Date.now()
      const runner = new IndexedRunner(this.adapter)
      const results = await runner.run(text, modelGroups, topK, tenantId)
      const runnerDuration = Date.now() - runnerStart

      // Record per-source timings
      for (const source of indexedSources) {
        const sourceResults = results.filter(r => r.sourceId === source.id)
        sourceTimings[source.id] = {
          mode: 'indexed',
          resultCount: sourceResults.length,
          durationMs: runnerDuration,
          status: 'ok',
        }
      }

      allResults = results
    }

    // Merge and rank if we have results from multiple model groups
    const weights = opts.mergeWeights
      ? Object.fromEntries(
          Object.entries(opts.mergeWeights).filter((e): e is [string, number] => e[1] != null)
        )
      : undefined
    const mergedResults = modelGroups.size > 1
      ? mergeAndRank([allResults], topK, weights)
      : allResults.slice(0, topK)

    // Map NormalizedResult → d8umResult
    const results: d8umResult[] = mergedResults.map(r => ({
      content: r.content,
      score: r.normalizedScore,
      scores: {
        vector: r.rawScores.vector,
        keyword: r.rawScores.keyword,
        rrf: r.normalizedScore,
      },
      source: {
        id: r.sourceId,
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
      sources: sourceTimings,
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
