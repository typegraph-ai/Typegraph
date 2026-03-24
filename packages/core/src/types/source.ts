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
  /** If true, strip markdown syntax from chunk content before embedding. Original content is stored as-is. */
  stripMarkdownForEmbedding?: boolean | undefined
  /** Custom preprocessing function for embedding. Takes chunk content, returns text to embed. Overrides stripMarkdownForEmbedding. */
  preprocessForEmbedding?: ((content: string) => string) | undefined
  /** App-specific document type applied to all documents from this source (e.g. 'pdf', 'webpage'). */
  documentType?: string | undefined
  /** App-specific source type applied to all documents from this source (e.g. 'upload', 'web_scrape'). */
  sourceType?: string | undefined
  /** Access scope for all documents from this source. */
  scope?: import('./d8um-document.js').DocumentScope | undefined
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
