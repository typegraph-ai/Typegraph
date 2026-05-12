import type { VectorStoreAdapter, HashStoreAdapter, SearchOpts, HashRecord, UndeployResult, ScoredChunkWithDocument } from '../../types/adapter.js'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '../../types/chunk.js'
import type { DocumentFilter, DocumentStatus, typegraphDocument, UpsertDocumentInput, UpsertedDocumentRecord } from '../../types/document.js'
import { createHash } from 'crypto'

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    magA += (a[i] ?? 0) ** 2
    magB += (b[i] ?? 0) ** 2
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB)
  return mag === 0 ? 0 : dot / mag
}

function matchesFilter(chunk: EmbeddedChunk, filter: ChunkFilter | null | undefined): boolean {
  if (!filter) return true
  if (filter.bucketId && chunk.bucketId !== filter.bucketId) return false
  if (filter.bucketIds && filter.bucketIds.length > 0 && !filter.bucketIds.includes(chunk.bucketId)) return false
  if (filter.graphIds && filter.graphIds.length > 0 && !filter.graphIds.includes(chunk.graphId ?? 'public')) return false
  if (filter.chunkRefs) {
    if (filter.chunkRefs.length === 0) return false
    const matched = filter.chunkRefs.some(ref =>
      ref.bucketId === chunk.bucketId &&
      ref.documentId === chunk.documentId &&
      ref.chunkIndex === chunk.chunkIndex &&
      (ref.embeddingModel == null || ref.embeddingModel === chunk.embeddingModel)
    )
    if (!matched) return false
  }
  if (filter.tenantId && chunk.tenantId !== filter.tenantId) return false
  if (filter.groupId && chunk.groupId !== filter.groupId) return false
  if (filter.userId && chunk.userId !== filter.userId) return false
  if (filter.agentId && chunk.agentId !== filter.agentId) return false
  if (filter.threadId && chunk.threadId !== filter.threadId) return false
  if (filter.documentId && chunk.documentId !== filter.documentId) return false
  if (filter.idempotencyKey && chunk.idempotencyKey !== filter.idempotencyKey) return false
  if (filter.metadata) {
    for (const [k, v] of Object.entries(filter.metadata)) {
      if (chunk.metadata[k] !== v) return false
    }
  }
  return true
}

function matchesDocumentFilter(document: typegraphDocument, filter: DocumentFilter | null | undefined): boolean {
  if (!filter) return true
  if (filter.bucketId && document.bucketId !== filter.bucketId) return false
  if ('graphIds' in filter && Array.isArray(filter.graphIds) && filter.graphIds.length > 0 && !filter.graphIds.includes(document.graphId ?? 'public')) return false
  if (filter.tenantId && document.tenantId !== filter.tenantId) return false
  if (filter.groupId && document.groupId !== filter.groupId) return false
  if (filter.userId && document.userId !== filter.userId) return false
  if (filter.agentId && document.agentId !== filter.agentId) return false
  if (filter.threadId && document.threadId !== filter.threadId) return false
  if (filter.documentIds && !filter.documentIds.includes(document.id)) return false
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    if (!statuses.includes(document.status)) return false
  }
  return true
}

function documentKey(tenantId: string | undefined, id: string): string {
  return `${tenantId ?? 'public'}:${id}`
}

export function createMockHashStore(): HashStoreAdapter & {
  _data: Map<string, HashRecord>
  _lastRunTimes: Map<string, Date>
} {
  const data = new Map<string, HashRecord>()
  const lastRunTimes = new Map<string, Date>()

  return {
    _data: data,
    _lastRunTimes: lastRunTimes,

    async initialize() {},

    async get(key: string) {
      return data.get(key) ?? null
    },

    async getMany(keys: string[]) {
      const out = new Map<string, HashRecord>()
      for (const key of keys) {
        const record = data.get(key)
        if (record) out.set(key, record)
      }
      return out
    },

    async set(key: string, record: HashRecord) {
      data.set(key, record)
    },

    async delete(key: string) {
      data.delete(key)
    },

    async listByBucket(bucketId: string, tenantId?: string) {
      return [...data.values()].filter(r =>
        r.bucketId === bucketId && (tenantId === undefined || r.tenantId === tenantId)
      )
    },

    async getLastRunTime(bucketId: string, tenantId?: string) {
      const key = `${bucketId}::${tenantId ?? '__global__'}`
      return lastRunTimes.get(key) ?? null
    },

    async setLastRunTime(bucketId: string, tenantId: string | undefined, time: Date) {
      const key = `${bucketId}::${tenantId ?? '__global__'}`
      lastRunTimes.set(key, time)
    },

    async deleteByBucket(bucketId: string, tenantId?: string) {
      for (const [key, record] of data) {
        if (record.bucketId === bucketId && (tenantId === undefined || record.tenantId === tenantId)) {
          data.delete(key)
        }
      }
    },
  }
}

export interface MockAdapterCall {
  method: string
  args: unknown[]
}

export function createMockAdapter(): VectorStoreAdapter & {
  calls: MockAdapterCall[]
  _chunks: Map<string, EmbeddedChunk[]>
  _documents: Map<string, typegraphDocument>
} {
  const chunks = new Map<string, EmbeddedChunk[]>()
  const documents = new Map<string, typegraphDocument>()
  const calls: MockAdapterCall[] = []
  const hashStore = createMockHashStore()

  function scoreChunks(model: string, embedding: number[], opts: SearchOpts | null): ScoredChunk[] {
    const store = chunks.get(model) ?? []
    const filtered = opts?.filter ? store.filter(c => matchesFilter(c, opts.filter)) : store
    const count = opts?.count ?? 10
    return filtered
      .map(c => ({
        ...c,
        scores: {
          semantic: cosineSimilarity(embedding, c.embedding),
        },
      }))
      .sort((a, b) => (b.scores.semantic ?? 0) - (a.scores.semantic ?? 0))
      .slice(0, count)
  }

  function hybridScoreChunks(model: string, embedding: number[], query: string, opts: SearchOpts | null): ScoredChunk[] {
    const store = chunks.get(model) ?? []
    const filtered = opts?.filter ? store.filter(c => matchesFilter(c, opts.filter)) : store
    const count = opts?.count ?? 10
    const queryTerms = query.toLowerCase().split(/\s+/)
    const useSemantic = opts?.retrieval?.semantic !== false
    const useKeyword = opts?.retrieval?.keyword ?? true
    if (!useSemantic && !useKeyword) return []

    return filtered
      .map(c => {
        const vectorScore = cosineSimilarity(embedding, c.embedding)
        const contentLower = c.content.toLowerCase()
        const keywordHits = queryTerms.filter(t => contentLower.includes(t)).length
        const keywordScore = keywordHits / Math.max(queryTerms.length, 1)
        const activeScores = [
          useSemantic ? vectorScore : undefined,
          useKeyword ? keywordScore : undefined,
        ].filter((score): score is number => score != null)
        const rrf = activeScores.length > 0
          ? activeScores.reduce((sum, score) => sum + score, 0) / activeScores.length
          : 0
        return {
          ...c,
          scores: {
            semantic: useSemantic ? vectorScore : undefined,
            keyword: useKeyword ? keywordScore : undefined,
            rrf,
          },
        }
      })
      .sort((a, b) => (b.scores.rrf ?? 0) - (a.scores.rrf ?? 0))
      .slice(0, count)
  }

  const adapter: VectorStoreAdapter & {
    calls: MockAdapterCall[]
    _chunks: Map<string, EmbeddedChunk[]>
    _documents: Map<string, typegraphDocument>
  } = {
    calls,
    _chunks: chunks,
    _documents: documents,
    hashStore,

    async deploy() {
      calls.push({ method: 'deploy', args: [] })
    },

    async connect() {
      calls.push({ method: 'connect', args: [] })
    },

    async undeploy(): Promise<UndeployResult> {
      calls.push({ method: 'undeploy', args: [] })
      return { success: true, message: 'All typegraph tables dropped.' }
    },

    async destroy() {
      calls.push({ method: 'destroy', args: [] })
    },

    async ensureModel(model: string, dimensions: number) {
      calls.push({ method: 'ensureModel', args: [model, dimensions] })
      if (!chunks.has(model)) chunks.set(model, [])
    },

    async upsertDocumentChunks(model: string, newChunks: EmbeddedChunk[]) {
      calls.push({ method: 'upsertDocumentChunks', args: [model, newChunks] })
      if (!chunks.has(model)) chunks.set(model, [])
      const store = chunks.get(model)!
      for (const chunk of newChunks) {
        const existingIdx = store.findIndex(
          c => c.bucketId === chunk.bucketId && c.idempotencyKey === chunk.idempotencyKey && c.chunkIndex === chunk.chunkIndex
        )
        if (existingIdx >= 0) {
          store[existingIdx] = chunk
        } else {
          store.push(chunk)
        }
      }
    },

    async delete(model: string, filter: ChunkFilter | null) {
      calls.push({ method: 'delete', args: [model, filter] })
      const store = chunks.get(model)
      if (!store) return
      const remaining = store.filter(c => !matchesFilter(c, filter))
      chunks.set(model, remaining)
    },

    async search(model: string, embedding: number[], opts: SearchOpts | null): Promise<ScoredChunk[]> {
      calls.push({ method: 'search', args: [model, embedding, opts] })
      return scoreChunks(model, embedding, opts)
    },

    async hybridSearch(model: string, embedding: number[], query: string, opts: SearchOpts | null): Promise<ScoredChunk[]> {
      calls.push({ method: 'hybridSearch', args: [model, embedding, query, opts] })
      return hybridScoreChunks(model, embedding, query, opts)
    },

    async countChunks(model: string, filter: ChunkFilter | null): Promise<number> {
      calls.push({ method: 'countChunks', args: [model, filter] })
      const store = chunks.get(model) ?? []
      return store.filter(c => matchesFilter(c, filter)).length
    },

    async upsertDocumentRecord(input: UpsertDocumentInput): Promise<UpsertedDocumentRecord> {
      calls.push({ method: 'upsertDocumentRecord', args: [input] })
      const existing = [...documents.values()].find(document =>
        document.bucketId === input.bucketId &&
        document.tenantId === input.tenantId &&
        document.contentHash === input.contentHash
      )
      const id = existing?.id ?? input.id ?? createHash('sha256')
        .update(`${input.bucketId}::${input.tenantId}::${input.contentHash}`)
        .digest('hex')
        .slice(0, 16)
      const now = new Date()
      const document: typegraphDocument = {
        id,
        bucketId: input.bucketId,
        tenantId: input.tenantId,
        graphId: input.graphId ?? 'public',
        name: input.name,
        description: input.description,
        url: input.url,
        contentHash: input.contentHash,
        chunkCount: input.chunkCount,
        status: input.status,
        groupId: input.groupId,
        userId: input.userId,
        agentId: input.agentId,
        threadId: input.threadId,
        indexedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      }
      documents.set(documentKey(input.tenantId, id), document)
      return { ...document, wasCreated: !existing }
    },

    async getDocument(tenantId: string, id: string): Promise<typegraphDocument | null> {
      calls.push({ method: 'getDocument', args: [tenantId, id] })
      return documents.get(documentKey(tenantId, id)) ?? null
    },

    async listDocuments(filter?: DocumentFilter | null): Promise<typegraphDocument[]> {
      calls.push({ method: 'listDocuments', args: [filter] })
      return [...documents.values()].filter(document => matchesDocumentFilter(document, filter))
    },

    async deleteDocuments(filter: DocumentFilter | null): Promise<number> {
      calls.push({ method: 'deleteDocuments', args: [filter] })
      let count = 0
      const deleted = new Set<string>()
      for (const [key, document] of documents) {
        if (matchesDocumentFilter(document, filter)) {
          documents.delete(key)
          deleted.add(`${document.tenantId}:${document.bucketId}:${document.id}`)
          count++
        }
      }
      for (const [model, store] of chunks) {
        chunks.set(model, store.filter(chunk => !deleted.has(`${chunk.tenantId}:${chunk.bucketId}:${chunk.documentId}`)))
      }
      return count
    },

    async updateDocumentStatus(tenantId: string, id: string, status: DocumentStatus, chunkCount?: number) {
      calls.push({ method: 'updateDocumentStatus', args: [tenantId, id, status, chunkCount] })
      const document = documents.get(documentKey(tenantId, id))
      if (document) {
        document.status = status
        if (chunkCount !== undefined) document.chunkCount = chunkCount
        document.updatedAt = new Date()
      }
    },

    async updateDocument(
      tenantId: string,
      id: string,
      input: Partial<Pick<typegraphDocument, 'name' | 'description' | 'url' | 'metadata'>>
    ): Promise<typegraphDocument> {
      calls.push({ method: 'updateDocument', args: [tenantId, id, input] })
      const document = documents.get(documentKey(tenantId, id))
      if (!document) throw new Error(`Document ${id} not found`)
      Object.assign(document, input, { updatedAt: new Date() })
      return document
    },

    async searchWithDocuments(
      model: string,
      embedding: number[],
      query: string,
      opts: (SearchOpts & { documentFilter?: DocumentFilter | undefined }) | null
    ): Promise<ScoredChunkWithDocument[]> {
      calls.push({ method: 'searchWithDocuments', args: [model, embedding, query, opts] })
      const scored = hybridScoreChunks(model, embedding, query, opts)
      return scored
        .map(chunk => ({ ...chunk, document: documents.get(documentKey(chunk.tenantId, chunk.documentId)) }))
        .filter(chunk => chunk.document && matchesDocumentFilter(chunk.document, opts?.documentFilter))
    },

    async getChunksByRange(
      model: string,
      tenantId: string,
      documentId: string,
      fromIndex: number,
      toIndex: number
    ): Promise<ScoredChunk[]> {
      calls.push({ method: 'getChunksByRange', args: [model, tenantId, documentId, fromIndex, toIndex] })
      const store = chunks.get(model) ?? []
      return store
        .filter(c => c.tenantId === tenantId && c.documentId === documentId && c.chunkIndex >= fromIndex && c.chunkIndex <= toIndex)
        .map(c => ({ ...c, scores: { semantic: 0 } }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
    },
  }

  return adapter
}
