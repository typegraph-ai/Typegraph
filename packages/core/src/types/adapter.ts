import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from './document.js'

export interface SearchOpts {
  topK: number
  filter?: ChunkFilter | undefined
  approximate?: boolean | undefined
  iterativeScan?: boolean | undefined
}

export interface HashRecord {
  idempotencyKey: string
  contentHash: string
  sourceId: string
  tenantId?: string | undefined
  indexedAt: Date
  chunkCount: number
}

export interface HashStoreAdapter {
  initialize(): Promise<void>
  get(key: string): Promise<HashRecord | null>
  set(key: string, record: HashRecord): Promise<void>
  delete(key: string): Promise<void>
  listBySource(sourceId: string, tenantId?: string | undefined): Promise<HashRecord[]>
  getLastRunTime(sourceId: string, tenantId?: string | undefined): Promise<Date | null>
  setLastRunTime(sourceId: string, tenantId: string | undefined, time: Date): Promise<void>
  deleteBySource(sourceId: string, tenantId?: string | undefined): Promise<void>
}

export interface VectorStoreAdapter {
  initialize(): Promise<void>
  destroy?(): Promise<void>

  upsertDocument(chunks: EmbeddedChunk[]): Promise<void>
  delete(filter: ChunkFilter): Promise<void>

  search(embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]>
  hybridSearch?(embedding: number[], query: string, opts: SearchOpts): Promise<ScoredChunk[]>
  countChunks(filter: ChunkFilter): Promise<number>

  hashStore: HashStoreAdapter
}
