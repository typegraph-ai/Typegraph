import type { EntityRef } from './identity.js'
import type { CompiledOntology, OntologyConfig } from './ontology.js'
import type { TypeCandidate } from '../index-engine/ontology.js'

export interface ExtractorCapabilities {
  supportsBatch: boolean
  supportsStreaming: boolean
  requiresStructuredOutput: boolean
  multimodal: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
  preservesOntology: boolean
}

export interface ExtractorInput {
  id: string
  kind: 'document' | 'event' | 'thread_turn' | 'memory' | 'correction'
  name?: string | undefined
  description?: string | undefined
  content: string
  occurredAt?: Date | undefined
  metadata?: Record<string, unknown> | undefined
  ontology?: OntologyConfig | CompiledOntology | undefined
  participants?: EntityRef[] | undefined
}

export interface ExtractorContext {
  abortSignal?: AbortSignal | undefined
  coreferenceCache?: ExtractionCoreferenceCache | undefined
  ontology?: CompiledOntology | undefined
  log?: {
    debug?: (message: string, data?: Record<string, unknown>) => void
    warn?: (message: string, data?: Record<string, unknown>) => void
    error?: (message: string, data?: Record<string, unknown>) => void
  } | undefined
}

export interface ExtractedEntity {
  type: string
  typeCandidates?: TypeCandidate[] | undefined
  id?: string | undefined
  name: string
  description?: string | undefined
  aliases?: string[] | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ExtractedRelation {
  source: EntityRef
  relation: string
  target: EntityRef
  description?: string | undefined
  evidenceText?: string | undefined
  confidence?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
  warnings?: string[] | undefined
  rawModelOutput?: unknown
}

export interface ExtractionCoreferenceCacheKey {
  tenantId?: string | undefined
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphId?: string | undefined
  ontologyHash?: string | undefined
  bucketId: string
  documentId?: string | undefined
  documentName?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ExtractionCoreferenceCache {
  load(key: ExtractionCoreferenceCacheKey): Promise<ExtractedEntity[]>
  save(key: ExtractionCoreferenceCacheKey, entities: ExtractedEntity[]): Promise<void>
}

export interface Extractor {
  name: string
  capabilities: ExtractorCapabilities
  extract(input: ExtractorInput, ctx: ExtractorContext): Promise<ExtractionResult>
}

export interface RerankerOptions {
  topK?: number | undefined
  abortSignal?: AbortSignal | undefined
}

export interface Reranker<TCandidate = unknown> {
  name: string
  rerank(query: string, candidates: TCandidate[], opts?: RerankerOptions): Promise<TCandidate[]>
}
