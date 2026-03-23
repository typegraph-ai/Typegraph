import type { VectorStoreAdapter, SearchOpts } from '@d8um/core'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@d8um/core'
import { SqliteHashStore } from './hash-store.js'

export interface SqliteVecAdapterConfig {
  dbPath?: string
  dimensions?: number
}

export class SqliteVecAdapter implements VectorStoreAdapter {
  hashStore: SqliteHashStore

  constructor(private config: SqliteVecAdapterConfig = {}) {
    // TODO: initialize better-sqlite3 + sqlite-vec extension
    this.hashStore = new SqliteHashStore(null)
  }

  async initialize(): Promise<void> { throw new Error('Not implemented') }
  async upsertDocument(chunks: EmbeddedChunk[]): Promise<void> { throw new Error('Not implemented') }
  async delete(filter: ChunkFilter): Promise<void> { throw new Error('Not implemented') }
  async search(embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> { throw new Error('Not implemented') }
  async countChunks(filter: ChunkFilter): Promise<number> { throw new Error('Not implemented') }
}
