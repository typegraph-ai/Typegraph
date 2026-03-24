import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from './document.js'
import type { d8umDocument, DocumentFilter, DocumentStatus, UpsertDocumentInput } from './d8um-document.js'

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
  embeddingModel: string
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

export interface ScoredChunkWithDocument extends ScoredChunk {
  document?: d8umDocument | undefined
}

export interface VectorStoreAdapter {
  initialize(): Promise<void>
  destroy?(): Promise<void>

  /** Ensure a model's storage (e.g., table) exists. Called lazily before first write. */
  ensureModel(model: string, dimensions: number): Promise<void>

  /** Upsert chunks for a document into the vector store. */
  upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void>
  delete(model: string, filter: ChunkFilter): Promise<void>

  search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]>
  hybridSearch?(model: string, embedding: number[], query: string, opts: SearchOpts): Promise<ScoredChunk[]>
  countChunks(model: string, filter: ChunkFilter): Promise<number>

  hashStore: HashStoreAdapter

  // --- Document record methods (optional — adapters that support documents implement these) ---

  /** Create or update a document record. Returns the document with its UUID. */
  upsertDocumentRecord?(input: UpsertDocumentInput): Promise<d8umDocument>
  /** Get a document by UUID. */
  getDocument?(id: string): Promise<d8umDocument | null>
  /** List documents matching a filter. */
  listDocuments?(filter: DocumentFilter): Promise<d8umDocument[]>
  /** Delete documents matching a filter. Returns count deleted. */
  deleteDocuments?(filter: DocumentFilter): Promise<number>
  /** Update a document's status and optionally its chunk count. */
  updateDocumentStatus?(id: string, status: DocumentStatus, chunkCount?: number): Promise<void>

  /** Hybrid search with document-level filtering via JOIN to d8um_documents. */
  searchWithDocuments?(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts & { documentFilter?: DocumentFilter | undefined }
  ): Promise<ScoredChunkWithDocument[]>

  /** Fetch chunks by document and index range (for neighbor expansion). No vector search. */
  getChunksByRange?(
    model: string,
    documentId: string,
    fromIndex: number,
    toIndex: number
  ): Promise<ScoredChunk[]>
}
