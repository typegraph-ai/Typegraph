// Main public API
export { d8um, d8umCreate, resolveEmbeddingProvider } from './d8um.js'
export type { d8umConfig, d8umInstance } from './d8um.js'
/** @deprecated Use AI SDK providers instead. */
export type { EmbeddingProviderConfig } from './d8um.js'

// Types
export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Connector,
  SyncMode,
  IndexConfig,
  CacheConfig,
  d8umSource,
  EmbeddingInput,
  EmbeddedChunk,
  ChunkFilter,
  ScoredChunk,
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
  d8umQuery,
  d8umResult,
  QueryOpts,
  QueryResponse,
  AssembleOpts,
  IndexOpts,
  IndexProgressEvent,
  IndexResult,
} from './types/index.js'
export { IndexError } from './types/index.js'

// Embedding
export type { EmbeddingProvider } from './embedding/index.js'
export { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/index.js'
export type { AISDKEmbeddingModel, AISDKEmbeddingInput } from './embedding/index.js'
/** @deprecated Use AI SDK providers instead. */
export { OpenAIEmbedding, CohereEmbedding } from './embedding/index.js'
/** @deprecated Use AI SDK providers instead. */
export type { OpenAIEmbeddingConfig, CohereEmbeddingConfig } from './embedding/index.js'

// Index engine
export { IndexEngine, defaultChunker, sha256 } from './index-engine/index.js'

// Query engine
export { assemble } from './query/index.js'
export { mergeAndRank, minMaxNormalize } from './query/index.js'
export type { NormalizedResult } from './query/index.js'
