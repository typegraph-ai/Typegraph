import type { ExternalId } from '../memory/types/memory.js'
import type { EntityType } from '../index-engine/ontology.js'

export type SourceSubjectExternalId =
  Omit<ExternalId, 'identityType'> &
  { identityType?: ExternalId['identityType'] | undefined }

export interface SourceSubject {
  entityId?: string | undefined
  externalIds?: SourceSubjectExternalId[] | undefined
  name?: string | undefined
  entityType?: EntityType | string | undefined
  aliases?: string[] | undefined
  description?: string | undefined
  properties?: Record<string, unknown> | undefined
}

export interface SourceInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id?: string | undefined
  content: string
  title: string
  updatedAt?: Date | undefined

  url?: string | null | undefined
  createdAt?: Date | undefined
  mimeType?: string | undefined
  language?: string | undefined

  metadata?: TMeta | undefined
  subject?: SourceSubject | undefined
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
