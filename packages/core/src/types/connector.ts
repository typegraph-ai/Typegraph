export interface RawDocument<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  content: string
  title: string
  updatedAt: Date

  url?: string | undefined
  createdAt?: Date | undefined
  mimeType?: string | undefined
  language?: string | undefined

  metadata: TMeta
}

export interface ChunkOpts {
  chunkSize: number
  chunkOverlap: number
}

export interface Chunk {
  content: string
  chunkIndex: number
  metadata?: Record<string, unknown> | undefined
}

export interface Connector<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  fetch?(): AsyncIterable<RawDocument<TMeta>>

  fetchSince?(since: Date): AsyncIterable<RawDocument<TMeta>>

  query?(q: import('./query.js').D8umQuery): Promise<import('./query.js').D8umResult[]>

  chunk?(doc: RawDocument<TMeta>, opts: ChunkOpts): Chunk[]

  healthCheck?(): Promise<void>
}
