import type { Connector, ChunkOpts } from './connector.js'

export type SyncMode = 'live' | 'indexed' | 'cached'

export interface IndexConfig extends ChunkOpts {
  idempotencyKey: string[] | ((doc: import('./connector.js').RawDocument) => string)
  propagateMetadata?: string[] | undefined
}

export interface CacheConfig {
  ttl: string | number
}

export interface D8umSource {
  id: string
  connector: Connector
  mode: SyncMode
  index?: IndexConfig | undefined
  cache?: CacheConfig | undefined
}
