import type { VectorStoreAdapter, HashStoreAdapter, SearchOpts, HashRecord, UndeployResult } from '../../types/adapter.js'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '../../types/document.js'
import type { typegraphDocument, DocumentStatus, DocumentFilter, UpsertDocumentInput } from '../../types/typegraph-document.js'
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

function matchesFilter(chunk: EmbeddedChunk, filter: ChunkFilter): boolean {
  if (filter.bucketId && chunk.bucketId !== filter.bucketId) return false
  if (filter.tenantId && chunk.tenantId !== filter.tenantId) return false
  if (filter.documentId && chunk.documentId !== filter.documentId) return false
  if (filter.idempotencyKey && chunk.idempotencyKey !== filter.idempotencyKey) return false
  if (filter.metadata) {
    for (const [k, v] of Object.entries(filter.metadata)) {
      if (chunk.metadata[k] !== v) return false
    }
  }
  return true
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
      if (!chunks.has(model)) {
        chunks.set(model, [])
      }
    },

    async upsertDocument(model: string, newChunks: EmbeddedChunk[]) {
      calls.push({ method: 'upsertDocument', args: [model, newChunks] })
      if (!chunks.has(model)) {
        chunks.set(model, [])
      }
      const store = chunks.get(model)!
      for (const chunk of newChunks) {
        // Replace existing chunk with same idempotencyKey + chunkIndex
        const existingIdx = store.findIndex(
          c => c.idempotencyKey === chunk.idempotencyKey && c.chunkIndex === chunk.chunkIndex
        )
        if (existingIdx >= 0) {
          store[existingIdx] = chunk
        } else {
          store.push(chunk)
        }
      }
    },

    async delete(model: string, filter: ChunkFilter) {
      calls.push({ method: 'delete', args: [model, filter] })
      const store = chunks.get(model)
      if (!store) return
      const remaining = store.filter(c => !matchesFilter(c, filter))
      chunks.set(model, remaining)
    },

    async search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
      calls.push({ method: 'search', args: [model, embedding, opts] })
      const store = chunks.get(model) ?? []
      let filtered = store
      if (opts.filter) {
        filtered = store.filter(c => matchesFilter(c, opts.filter!))
      }
      return filtered
        .map(c => ({
          ...c,
          scores: {
            semantic: cosineSimilarity(embedding, c.embedding),
          },
        }))
        .sort((a, b) => (b.scores.semantic ?? 0) - (a.scores.semantic ?? 0))
        .slice(0, opts.count)
    },

    async hybridSearch(model: string, embedding: number[], query: string, opts: SearchOpts): Promise<ScoredChunk[]> {
      calls.push({ method: 'hybridSearch', args: [model, embedding, query, opts] })
      const store = chunks.get(model) ?? []
      let filtered = store
      if (opts.filter) {
        filtered = store.filter(c => matchesFilter(c, opts.filter!))
      }

      const queryTerms = query.toLowerCase().split(/\s+/)
      const k = 60

      return filtered
        .map(c => {
          const vectorScore = cosineSimilarity(embedding, c.embedding)
          const contentLower = c.content.toLowerCase()
          const keywordHits = queryTerms.filter(t => contentLower.includes(t)).length
          const keywordScore = keywordHits / Math.max(queryTerms.length, 1)
          // Simple RRF-style combination
          const rrf = vectorScore * 0.7 + keywordScore * 0.3
          return {
            ...c,
            scores: {
              semantic: vectorScore,
              keyword: keywordScore,
              rrf,
            },
          }
        })
        .sort((a, b) => (b.scores.rrf ?? 0) - (a.scores.rrf ?? 0))
        .slice(0, opts.count)
    },

    async countChunks(model: string, filter: ChunkFilter): Promise<number> {
      calls.push({ method: 'countChunks', args: [model, filter] })
      const store = chunks.get(model) ?? []
      return store.filter(c => matchesFilter(c, filter)).length
    },

    async upsertDocumentRecord(input: UpsertDocumentInput): Promise<typegraphDocument> {
      calls.push({ method: 'upsertDocumentRecord', args: [input] })
      const id = createHash('sha256')
        .update(`${input.bucketId}::${input.url ?? input.title}`)
        .digest('hex')
        .slice(0, 16)
      const now = new Date()
      const existing = documents.get(id)
      const doc: typegraphDocument = {
        id,
        bucketId: input.bucketId,
        tenantId: input.tenantId,
        title: input.title,
        url: input.url,
        contentHash: input.contentHash,
        chunkCount: input.chunkCount,
        status: input.status,
        visibility: input.visibility,
        groupId: input.groupId,
        userId: input.userId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        documentType: input.documentType,
        sourceType: input.sourceType,
        indexedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      }
      documents.set(id, doc)
      return doc
    },

    async getDocument(id: string): Promise<typegraphDocument | null> {
      calls.push({ method: 'getDocument', args: [id] })
      return documents.get(id) ?? null
    },

    async listDocuments(filter: DocumentFilter): Promise<typegraphDocument[]> {
      calls.push({ method: 'listDocuments', args: [filter] })
      return [...documents.values()].filter(d => {
        if (filter.bucketId && d.bucketId !== filter.bucketId) return false
        if (filter.tenantId && d.tenantId !== filter.tenantId) return false
        if (filter.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
          if (!statuses.includes(d.status)) return false
        }
        return true
      })
    },

    async deleteDocuments(filter: DocumentFilter): Promise<number> {
      calls.push({ method: 'deleteDocuments', args: [filter] })
      let count = 0
      for (const [id, d] of documents) {
        let match = true
        if (filter.bucketId && d.bucketId !== filter.bucketId) match = false
        if (filter.tenantId && d.tenantId !== filter.tenantId) match = false
        if (match) {
          documents.delete(id)
          count++
        }
      }
      return count
    },

    async updateDocumentStatus(id: string, status: DocumentStatus, chunkCount?: number) {
      calls.push({ method: 'updateDocumentStatus', args: [id, status, chunkCount] })
      const doc = documents.get(id)
      if (doc) {
        doc.status = status
        if (chunkCount !== undefined) doc.chunkCount = chunkCount
        doc.updatedAt = new Date()
      }
    },

    async getChunksByRange(
      model: string,
      documentId: string,
      fromIndex: number,
      toIndex: number
    ): Promise<ScoredChunk[]> {
      calls.push({ method: 'getChunksByRange', args: [model, documentId, fromIndex, toIndex] })
      const store = chunks.get(model) ?? []
      return store
        .filter(c => c.documentId === documentId && c.chunkIndex >= fromIndex && c.chunkIndex <= toIndex)
        .map(c => ({ ...c, scores: { semantic: 0 } }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
    },
  }

  return adapter
}
