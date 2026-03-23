import type { VectorStoreAdapter, SearchOpts } from '@d8um/core'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@d8um/core'
import { INIT_SQL } from './migrations.js'
import { PgHashStore } from './hash-store.js'

export interface PgVectorAdapterConfig {
  connectionString: string
  chunksTable?: string
  hashesTable?: string
  dimensions?: number
}

export class PgVectorAdapter implements VectorStoreAdapter {
  private sql: any
  readonly hashStore: PgHashStore
  private chunksTable: string
  private hashesTable: string
  private dimensions: number

  constructor(private config: PgVectorAdapterConfig) {
    this.chunksTable = config.chunksTable ?? 'd8um_chunks'
    this.hashesTable = config.hashesTable ?? 'd8um_hashes'
    this.dimensions = config.dimensions ?? 1536
    // TODO: initialize neon() or pg Pool from connectionString
    this.hashStore = new PgHashStore(this.sql, this.hashesTable)
  }

  async initialize(): Promise<void> {
    const ddl = INIT_SQL(this.chunksTable, this.hashesTable, this.dimensions)
    await this.sql(ddl)
    await this.hashStore.initialize()
  }

  async upsertDocument(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    // TODO: single unnest INSERT with ON CONFLICT DO UPDATE
    throw new Error('Not implemented')
  }

  async delete(filter: ChunkFilter): Promise<void> {
    // TODO: build WHERE clause from filter fields, execute DELETE
    throw new Error('Not implemented')
  }

  async search(embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
    // TODO: SET LOCAL hnsw.iterative_scan = relaxed_order + cosine ORDER BY LIMIT
    throw new Error('Not implemented')
  }

  async hybridSearch(
    embedding: number[],
    query: string,
    opts: SearchOpts
  ): Promise<ScoredChunk[]> {
    // TODO: full RRF query — tsq CTE + iterative HNSW + keyword_ranked
    throw new Error('Not implemented')
  }

  async countChunks(filter: ChunkFilter): Promise<number> {
    // TODO: SELECT COUNT(*) WHERE sourceId + tenantId + idempotencyKey
    throw new Error('Not implemented')
  }
}
