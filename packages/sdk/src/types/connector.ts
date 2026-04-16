export interface RawDocument<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id?: string | undefined
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

