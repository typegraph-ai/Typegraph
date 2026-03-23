// Main public API
export { D8um } from './d8um.js'
export type { D8umConfig, EmbeddingProviderConfig } from './d8um.js'

// Types
export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Connector,
  SyncMode,
  IndexConfig,
  CacheConfig,
  D8umSource,
  EmbeddedChunk,
  ChunkFilter,
  ScoredChunk,
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
  D8umQuery,
  D8umResult,
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
export { OpenAIEmbedding, CohereEmbedding } from './embedding/index.js'
export type { OpenAIEmbeddingConfig } from './embedding/index.js'
export type { CohereEmbeddingConfig } from './embedding/index.js'

// Index engine
export { IndexEngine, defaultChunker, sha256 } from './index-engine/index.js'

// Query engine
export { assemble } from './query/index.js'
export { mergeAndRank, minMaxNormalize } from './query/index.js'
export type { NormalizedResult } from './query/index.js'
