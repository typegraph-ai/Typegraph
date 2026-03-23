import type { VectorStoreAdapter } from './types/adapter.js'
import type { D8umSource } from './types/source.js'
import type { QueryOpts, QueryResponse, AssembleOpts, D8umResult } from './types/query.js'
import type { IndexOpts, IndexResult } from './types/index-types.js'
import type { EmbeddingProvider } from './embedding/provider.js'
import { OpenAIEmbedding } from './embedding/openai.js'
import { CohereEmbedding } from './embedding/cohere.js'
import { IndexEngine } from './index-engine/engine.js'
import { assemble as assembleResults } from './query/assemble.js'

export interface D8umConfig {
  vectorStore: VectorStoreAdapter
  embedding: EmbeddingProvider | EmbeddingProviderConfig
  tenantId?: string | undefined
  tokenizer?: ((text: string) => number) | undefined
}

export interface EmbeddingProviderConfig {
  provider: 'openai' | 'cohere'
  model?: string | undefined
  apiKey: string
  dimensions?: number | undefined
}

function isEmbeddingProviderConfig(
  value: EmbeddingProvider | EmbeddingProviderConfig
): value is EmbeddingProviderConfig {
  return 'provider' in value && 'apiKey' in value
}

function resolveEmbeddingProvider(config: EmbeddingProvider | EmbeddingProviderConfig): EmbeddingProvider {
  if (!isEmbeddingProviderConfig(config)) return config

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

export class D8um {
  private sources = new Map<string, D8umSource>()
  private adapter: VectorStoreAdapter
  private embedding: EmbeddingProvider
  private config: D8umConfig
  private initialized = false

  constructor(config: D8umConfig) {
    this.config = config
    this.adapter = config.vectorStore
    this.embedding = resolveEmbeddingProvider(config.embedding)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.adapter.initialize()
    this.initialized = true
  }

  addSource(source: D8umSource): this {
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
    return this
  }

  async index(sourceId?: string, opts?: IndexOpts): Promise<IndexResult | IndexResult[]> {
    await this.ensureInitialized()
    const engine = new IndexEngine(this.adapter, this.embedding)

    if (sourceId) {
      const source = this.sources.get(sourceId)
      if (!source) throw new Error(`Source "${sourceId}" not found`)
      if (source.mode !== 'indexed') throw new Error(`Source "${sourceId}" is not indexed`)
      return engine.indexSource(source, opts)
    }

    const indexedSources = [...this.sources.values()].filter(s => s.mode === 'indexed')
    const results: IndexResult[] = []
    for (const source of indexedSources) {
      results.push(await engine.indexSource(source, opts))
    }
    return results
  }

  async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
    await this.ensureInitialized()
    // TODO: implement via QueryPlanner
    throw new Error('Not implemented')
  }

  assemble(results: D8umResult[], opts?: AssembleOpts): string {
    return assembleResults(results, opts)
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }

  async destroy(): Promise<void> {
    await this.adapter.destroy?.()
  }
}
