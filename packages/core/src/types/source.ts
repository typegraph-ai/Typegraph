import type { Connector, ChunkOpts } from './connector.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { AISDKEmbeddingInput } from '../embedding/ai-sdk-adapter.js'

export type SyncMode = 'live' | 'indexed' | 'cached'

/** @deprecated Use AI SDK providers instead. */
export interface EmbeddingProviderConfig {
  provider: 'openai' | 'cohere'
  model?: string | undefined
  apiKey: string
  dimensions?: number | undefined
}

export type EmbeddingInput = EmbeddingProvider | EmbeddingProviderConfig | AISDKEmbeddingInput

export interface IndexConfig extends ChunkOpts {
  idempotencyKey: string[] | ((doc: import('./connector.js').RawDocument) => string)
  propagateMetadata?: string[] | undefined
}

export interface CacheConfig {
  ttl: string | number
}

export interface d8umSource {
  id: string
  connector: Connector
  mode: SyncMode
  index?: IndexConfig | undefined
  cache?: CacheConfig | undefined
  /** Optional per-source embedding model. Overrides the global default from d8umConfig. */
  embedding?: EmbeddingInput | undefined
}
