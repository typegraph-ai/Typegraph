import type { VectorStoreAdapter } from './types/adapter.js'
import type { d8umSource, EmbeddingInput } from './types/source.js'
import type { QueryOpts, QueryResponse, AssembleOpts, d8umResult } from './types/query.js'
import type { IndexOpts, IndexResult } from './types/index-types.js'
import type { EmbeddingProvider } from './embedding/provider.js'
import type { AISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { OpenAIEmbedding } from './embedding/openai.js'
import { CohereEmbedding } from './embedding/cohere.js'
import { IndexEngine } from './index-engine/engine.js'
import { QueryPlanner } from './query/planner.js'
import { assemble as assembleResults } from './query/assemble.js'

export interface d8umConfig {
  vectorStore: VectorStoreAdapter
  embedding: EmbeddingInput
  tenantId?: string | undefined
  tokenizer?: ((text: string) => number) | undefined
}

/**
 * @deprecated Use AI SDK providers with `AISDKEmbeddingInput` instead.
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai'
 * // Instead of: { provider: 'openai', apiKey: '...' }
 * // Use:        { model: openai.embedding('text-embedding-3-small'), dimensions: 1536 }
 * ```
 */
export interface EmbeddingProviderConfig {
  provider: 'openai' | 'cohere'
  model?: string | undefined
  apiKey: string
  dimensions?: number | undefined
}

function isEmbeddingProviderConfig(
  value: EmbeddingInput
): value is EmbeddingProviderConfig {
  return 'provider' in value && 'apiKey' in value
}

function isEmbeddingProvider(
  value: EmbeddingInput
): value is EmbeddingProvider {
  return 'embed' in value && 'embedBatch' in value && 'dimensions' in value
}

export function resolveEmbeddingProvider(config: EmbeddingInput): EmbeddingProvider {
  if (isEmbeddingProvider(config)) return config
  if (isAISDKEmbeddingInput(config)) return aiSdkEmbeddingProvider(config)

  // Legacy path — deprecated
  if (isEmbeddingProviderConfig(config)) {
    switch (config.provider) {
      case 'openai':
        return new OpenAIEmbedding({
          apiKey: config.apiKey,
          model: config.model,
          dimensions: config.dimensions,
        })
      case 'cohere':
        return new CohereEmbedding({
          apiKey: config.apiKey,
          model: config.model,
          dimensions: config.dimensions,
        })
      default:
        throw new Error(`Unknown embedding provider: ${config.provider}`)
    }
  }

  throw new Error('Invalid embedding configuration')
}

/** The d8um instance interface — all public methods. */
export interface d8umInstance {
  initialize(config: d8umConfig): this
  addSource(source: d8umSource): this
  getEmbeddingForSource(sourceId: string): EmbeddingProvider
  getDistinctEmbeddings(sourceIds?: string[]): Map<string, EmbeddingProvider>
  groupSourcesByModel(sourceIds?: string[]): Map<string, string[]>
  index(sourceId?: string, opts?: IndexOpts): Promise<IndexResult | IndexResult[]>
  query(text: string, opts?: QueryOpts): Promise<QueryResponse>
  assemble(results: d8umResult[], opts?: AssembleOpts): string
  destroy(): Promise<void>
}

class d8umImpl implements d8umInstance {
  private sources = new Map<string, d8umSource>()
  private sourceEmbeddings = new Map<string, EmbeddingProvider>()
  private adapter!: VectorStoreAdapter
  private defaultEmbedding!: EmbeddingProvider
  private config!: d8umConfig
  private configured = false
  private initialized = false

  initialize(config: d8umConfig): this {
    this.config = config
    this.adapter = config.vectorStore
    this.defaultEmbedding = resolveEmbeddingProvider(config.embedding)
    this.configured = true
    this.initialized = false
    return this
  }

  addSource(source: d8umSource): this {
    this.assertConfigured()
    if (source.mode === 'indexed' && !source.index) {
      throw new Error(`Source "${source.id}": mode 'indexed' requires an index config`)
    }
    if (source.mode === 'cached' && !source.cache) {
      throw new Error(`Source "${source.id}": mode 'cached' requires a cache config`)
    }
    if (source.mode === 'live' && !source.connector.query) {
      throw new Error(`Source "${source.id}": mode 'live' requires connector.query()`)
    }

    this.sources.set(source.id, source)

    const embedding = source.embedding
      ? resolveEmbeddingProvider(source.embedding)
      : this.defaultEmbedding
    this.sourceEmbeddings.set(source.id, embedding)

    return this
  }

  getEmbeddingForSource(sourceId: string): EmbeddingProvider {
    const embedding = this.sourceEmbeddings.get(sourceId)
    if (!embedding) throw new Error(`Source "${sourceId}" not found`)
    return embedding
  }

  getDistinctEmbeddings(sourceIds?: string[]): Map<string, EmbeddingProvider> {
    const map = new Map<string, EmbeddingProvider>()
    const ids = sourceIds ?? [...this.sources.keys()]
    for (const id of ids) {
      const emb = this.sourceEmbeddings.get(id)
      if (emb) map.set(emb.model, emb)
    }
    return map
  }

  groupSourcesByModel(sourceIds?: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    const ids = sourceIds ?? [...this.sources.keys()]
    for (const id of ids) {
      const emb = this.sourceEmbeddings.get(id)
      if (!emb) continue
      const group = groups.get(emb.model) ?? []
      group.push(id)
      groups.set(emb.model, group)
    }
    return groups
  }

  async index(sourceId?: string, opts?: IndexOpts): Promise<IndexResult | IndexResult[]> {
    await this.ensureInitialized()

    if (sourceId) {
      const source = this.sources.get(sourceId)
      if (!source) throw new Error(`Source "${sourceId}" not found`)
      if (source.mode !== 'indexed') throw new Error(`Source "${sourceId}" is not indexed`)
      const embedding = this.getEmbeddingForSource(sourceId)
      const engine = new IndexEngine(this.adapter, embedding)
      return engine.indexSource(source, opts)
    }

    const indexedSources = [...this.sources.values()].filter(s => s.mode === 'indexed')
    const results: IndexResult[] = []
    for (const source of indexedSources) {
      const embedding = this.getEmbeddingForSource(source.id)
      const engine = new IndexEngine(this.adapter, embedding)
      results.push(await engine.indexSource(source, opts))
    }
    return results
  }

  async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
    await this.ensureInitialized()
    const planner = new QueryPlanner(this.adapter, this.sources, this.sourceEmbeddings)
    return planner.execute(text, {
      ...opts,
      tenantId: opts?.tenantId ?? this.config.tenantId,
    })
  }

  assemble(results: d8umResult[], opts?: AssembleOpts): string {
    return assembleResults(results, opts)
  }

  async destroy(): Promise<void> {
    await this.adapter?.destroy?.()
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('d8um not initialized. Call d8um.initialize({ vectorStore, embedding }) first.')
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.assertConfigured()
    if (!this.initialized) {
      await this.adapter.initialize()
      this.initialized = true
    }
  }
}

/** Create a new independent d8um instance. */
export function d8umCreate(config: d8umConfig): d8umInstance {
  return new d8umImpl().initialize(config)
}

/** Global singleton d8um instance. Call d8um.initialize() before use. */
export const d8um: d8umInstance = new d8umImpl()
