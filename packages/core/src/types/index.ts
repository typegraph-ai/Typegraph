export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Connector,
} from './connector.js'

export type {
  SyncMode,
  IndexConfig,
  CacheConfig,
  d8umSource,
  EmbeddingInput,
  EmbeddingProviderConfig,
} from './source.js'

export type {
  EmbeddedChunk,
  ChunkFilter,
  ScoredChunk,
} from './document.js'

export type {
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
} from './adapter.js'

export type {
  d8umQuery,
  d8umResult,
  QueryOpts,
  QueryResponse,
  AssembleOpts,
} from './query.js'

export type {
  IndexOpts,
  IndexProgressEvent,
  IndexResult,
} from './index-types.js'

export { IndexError } from './index-types.js'
