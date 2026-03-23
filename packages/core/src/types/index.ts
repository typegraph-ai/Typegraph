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
  D8umSource,
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
  D8umQuery,
  D8umResult,
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
