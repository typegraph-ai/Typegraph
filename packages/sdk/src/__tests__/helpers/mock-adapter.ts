import type { VectorStoreAdapter, HashStoreAdapter, SearchOpts, HashRecord, UndeployResult } from '../../types/adapter.js'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '../../types/chunk.js'
import type { typegraphSource, SourceStatus, SourceFilter, UpsertSourceInput, UpsertedSourceRecord } from '../../types/source.js'
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
  if (filter.bucketIds && filter.bucketIds.length > 0 && !filter.bucketIds.includes(chunk.bucketId)) return false
  if (filter.chunkRefs) {
    if (filter.chunkRefs.length === 0) return false
    const matched = filter.chunkRefs.some(ref =>
      ref.bucketId === chunk.bucketId &&
      ref.sourceId === chunk.sourceId &&
      ref.chunkIndex === chunk.chunkIndex &&
      (ref.embeddingModel == null || ref.embeddingModel === chunk.embeddingModel)
    )
    if (!matched) return false
  }
  if (filter.tenantId && chunk.tenantId !== filter.tenantId) return false
  if (filter.groupId && chunk.groupId !== filter.groupId) return false
  if (filter.userId && chunk.userId !== filter.userId) return false
  if (filter.agentId && chunk.agentId !== filter.agentId) return false
  if (filter.conversationId && chunk.conversationId !== filter.conversationId) return false
  if (filter.sourceId && chunk.sourceId !== filter.sourceId) return false
  if (filter.idempotencyKey && chunk.idempotencyKey !== filter.idempotencyKey) return false
  if (filter.metadata) {
    for (const [k, v] of Object.entries(filter.metadata)) {
      if (chunk.metadata[k] !== v) return false
    }
  }

  // Visibility gate — must mirror PgVectorAdapter.buildWhere() behavior.
  // NULL/undefined visibility = public (always visible). Every other level
  // requires the caller to supply a matching identity at that level.
  const vis = chunk.visibility
  if (vis == null) return true
  if (vis === 'tenant') return filter.tenantId != null && chunk.tenantId === filter.tenantId
  if (vis === 'group') return filter.groupId != null && chunk.groupId === filter.groupId
  if (vis === 'user') return filter.userId != null && chunk.userId === filter.userId
  if (vis === 'agent') return filter.agentId != null && chunk.agentId === filter.agentId
  if (vis === 'conversation') return filter.conversationId != null && chunk.conversationId === filter.conversationId
  return false
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
  _sources: Map<string, typegraphSource>
} {
  const chunks = new Map<string, EmbeddedChunk[]>()
  const sources = new Map<string, typegraphSource>()
  const calls: MockAdapterCall[] = []
  const hashStore = createMockHashStore()

  const adapter: VectorStoreAdapter & {
    calls: MockAdapterCall[]
    _chunks: Map<string, EmbeddedChunk[]>
    _sources: Map<string, typegraphSource>
  } = {
    calls,
    _chunks: chunks,
    _sources: sources,
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

    async upsertSourceChunks(model: string, newChunks: EmbeddedChunk[]) {
      calls.push({ method: 'upsertSourceChunks', args: [model, newChunks] })
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
      const useSemantic = opts.signals?.semantic !== false
      const useKeyword = opts.signals?.keyword ?? true
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
        .slice(0, opts.count)
    },

    async countChunks(model: string, filter: ChunkFilter): Promise<number> {
      calls.push({ method: 'countChunks', args: [model, filter] })
      const store = chunks.get(model) ?? []
      return store.filter(c => matchesFilter(c, filter)).length
    },

    async upsertSourceRecord(input: UpsertSourceInput): Promise<UpsertedSourceRecord> {
      calls.push({ method: 'upsertSourceRecord', args: [input] })
      const existing = [...sources.values()].find(source =>
        source.bucketId === input.bucketId &&
        source.tenantId === input.tenantId &&
        source.contentHash === input.contentHash
      )
      const id = existing?.id ?? input.id ?? createHash('sha256')
        .update(`${input.bucketId}::${input.tenantId ?? ''}::${input.contentHash}`)
        .digest('hex')
        .slice(0, 16)
      const now = new Date()
      const source: typegraphSource = {
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
        graphExtracted: input.graphExtracted ?? false,
        indexedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: input.metadata ?? {},
        subject: input.subject,
      }
      sources.set(id, source)
      return { ...source, wasCreated: !existing }
    },

    async getSource(id: string): Promise<typegraphSource | null> {
      calls.push({ method: 'getSource', args: [id] })
      return sources.get(id) ?? null
    },

    async listSources(filter: SourceFilter): Promise<typegraphSource[]> {
      calls.push({ method: 'listSources', args: [filter] })
      return [...sources.values()].filter(d => {
        if (filter.bucketId && d.bucketId !== filter.bucketId) return false
        if (filter.tenantId && d.tenantId !== filter.tenantId) return false
        if (filter.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
          if (!statuses.includes(d.status)) return false
        }
        return true
      })
    },

    async deleteSources(filter: SourceFilter): Promise<number> {
      calls.push({ method: 'deleteSources', args: [filter] })
      let count = 0
      for (const [id, d] of sources) {
        let match = true
        if (filter.bucketId && d.bucketId !== filter.bucketId) match = false
        if (filter.tenantId && d.tenantId !== filter.tenantId) match = false
        if (match) {
          sources.delete(id)
          count++
        }
      }
      return count
    },

    async updateSourceStatus(id: string, status: SourceStatus, chunkCount?: number) {
      calls.push({ method: 'updateSourceStatus', args: [id, status, chunkCount] })
      const source = sources.get(id)
      if (source) {
        source.status = status
        if (chunkCount !== undefined) source.chunkCount = chunkCount
        source.updatedAt = new Date()
      }
    },

    async getChunksByRange(
      model: string,
      sourceId: string,
      fromIndex: number,
      toIndex: number
    ): Promise<ScoredChunk[]> {
      calls.push({ method: 'getChunksByRange', args: [model, sourceId, fromIndex, toIndex] })
      const store = chunks.get(model) ?? []
      return store
        .filter(c => c.sourceId === sourceId && c.chunkIndex >= fromIndex && c.chunkIndex <= toIndex)
        .map(c => ({ ...c, scores: { semantic: 0 } }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
    },
  }

  return adapter
}
