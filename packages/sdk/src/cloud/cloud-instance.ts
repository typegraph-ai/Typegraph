import type { typegraphInstance, typegraphConfig, BucketsApi, SourcesApi, JobsApi, GraphApi } from '../typegraph.js'
import type { Bucket, CreateBucketInput, BucketListFilter } from '../types/bucket.js'
import type { QueryOpts, QueryResponse } from '../types/query.js'
import type { IngestOptions, IndexResult } from '../types/index-types.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { SourceInput, Chunk } from '../types/connector.js'
import type { typegraphSource, SourceFilter } from '../types/source.js'
import type { typegraphIdentity } from '../types/identity.js'
import type { CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType } from '../types/policy.js'
import type { UndeployResult } from '../types/adapter.js'
import type { PaginationOpts, PaginatedResult } from '../types/pagination.js'
import type { ConversationTurnResult, MemoryHealthReport } from '../types/memory.js'
import type { ExternalId, MemoryRecord } from '../memory/types/memory.js'
import type { Job, JobFilter } from '../types/job.js'
import type { EntityResult, EntityDetail, EdgeResult, FactResult, FactSearchOpts, GraphExploreOpts, GraphExploreResult, GraphBackfillOpts, GraphBackfillResult, GraphExplainOpts, GraphSearchTrace, ChunkResult, SubgraphOpts, SubgraphResult, GraphStats, RecallOpts, GraphEntityRef, UpsertGraphEdgeInput, UpsertGraphEntityInput, UpsertGraphFactInput, MergeGraphEntitiesInput, MergeGraphEntitiesResult, DeleteGraphEntityOpts, DeleteGraphEntityResult } from '../types/graph-bridge.js'
import { DEFAULT_BUCKET_ID, normalizeSourceInput } from '../typegraph.js'
import { HttpClient } from './http-client.js'
import type { CloudConfig } from './http-client.js'

/**
 * Extended typegraph instance for cloud mode.
 * Includes source CRUD methods available via the hosted API.
 */
export interface typegraphCloudInstance extends typegraphInstance {
  listSources(filter?: SourceFilter): Promise<typegraphSource[]>
  getSource(sourceId: string): Promise<typegraphSource>
  updateSource(sourceId: string, update: Partial<typegraphSource>): Promise<typegraphSource>
  deleteSources(filter: SourceFilter): Promise<number>
}

/**
 * Create a typegraph instance backed by the hosted cloud service.
 * Everything runs server-side — embedding, indexing, storage, memory.
 */
export function createCloudInstance(config: CloudConfig): typegraphCloudInstance {
  const client = new HttpClient(config)
  const e = encodeURIComponent

  const buckets: BucketsApi = {
    async create(input: CreateBucketInput): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async get(bucketId: string): Promise<Bucket | undefined> {
      return client.get<Bucket>(`/v1/buckets/${e(bucketId)}`)
    },
    async list(filter?: BucketListFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>> {
      const searchParams = new URLSearchParams()
      if (filter?.tenantId) searchParams.set('tenantId', filter.tenantId)
      if (filter?.groupId) searchParams.set('groupId', filter.groupId)
      if (filter?.userId) searchParams.set('userId', filter.userId)
      if (filter?.agentId) searchParams.set('agentId', filter.agentId)
      if (filter?.conversationId) searchParams.set('conversationId', filter.conversationId)
      if (pagination?.limit != null) searchParams.set('limit', String(pagination.limit))
      if (pagination?.offset != null) searchParams.set('offset', String(pagination.offset))
      const qs = searchParams.toString()
      if (pagination) {
        return client.get<PaginatedResult<Bucket>>(`/v1/buckets${qs ? `?${qs}` : ''}`)
      }
      return client.get<Bucket[]>(`/v1/buckets${qs ? `?${qs}` : ''}`)
    },
    async update(bucketId: string, input): Promise<Bucket> {
      return client.patch<Bucket>(`/v1/buckets/${e(bucketId)}`, input)
    },
    async delete(bucketId: string): Promise<void> {
      await client.delete(`/v1/buckets/${e(bucketId)}`)
    },
  }

  const sources: SourcesApi = {
    async get(id: string): Promise<typegraphSource | null> {
      return client.get<typegraphSource | null>(`/v1/sources/${e(id)}`)
    },
    async list(filter?: SourceFilter, pagination?: PaginationOpts): Promise<typegraphSource[] | PaginatedResult<typegraphSource>> {
      if (pagination) {
        return client.post<PaginatedResult<typegraphSource>>('/v1/sources/list', { ...filter, ...pagination })
      }
      return client.post<typegraphSource[]>('/v1/sources/list', filter)
    },
    async update(id: string, input): Promise<typegraphSource> {
      return client.patch<typegraphSource>(`/v1/sources/${e(id)}`, input)
    },
    async delete(filter: SourceFilter): Promise<number> {
      return client.delete<number>('/v1/sources', filter)
    },
  }

  const jobs: JobsApi = {
    async get(id: string): Promise<Job | null> {
      return client.get<Job | null>(`/v1/jobs/${e(id)}`)
    },
    async list(filter?: JobFilter): Promise<Job[]> {
      return client.post<Job[]>('/v1/jobs/list', filter)
    },
    async upsert(): Promise<Job> {
      throw new Error('jobs.upsert() is a server-side primitive and is not available in cloud mode.')
    },
    async updateStatus(): Promise<void> {
      throw new Error('jobs.updateStatus() is a server-side primitive and is not available in cloud mode.')
    },
    async incrementProgress(): Promise<void> {
      throw new Error('jobs.incrementProgress() is a server-side primitive and is not available in cloud mode.')
    },
  }

  const graph: GraphApi = {
    async upsertEntity(input: UpsertGraphEntityInput): Promise<EntityDetail> {
      return client.post<EntityDetail>('/v1/graph/entities', input)
    },
    async upsertEntities(inputs: UpsertGraphEntityInput[]): Promise<EntityDetail[]> {
      return client.post<EntityDetail[]>('/v1/graph/entities/batch', { entities: inputs })
    },
    async resolveEntity(ref: GraphEntityRef | string, identity?: typegraphIdentity): Promise<EntityDetail | null> {
      return client.post<EntityDetail | null>('/v1/graph/entities/resolve', { ref, identity })
    },
    async linkExternalIds(entityId: string, externalIds: ExternalId[], identity?: typegraphIdentity): Promise<EntityDetail> {
      return client.post<EntityDetail>(`/v1/graph/entities/${e(entityId)}/external-ids`, { externalIds, identity })
    },
    async mergeEntities(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult> {
      return client.post<MergeGraphEntitiesResult>('/v1/graph/entities/merge', input)
    },
    async deleteEntity(entityId: string, opts?: DeleteGraphEntityOpts): Promise<DeleteGraphEntityResult> {
      const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts ?? {}
      const identity = { tenantId, groupId, userId, agentId, conversationId }
      return client.delete<DeleteGraphEntityResult>(`/v1/graph/entities/${e(entityId)}`, { ...rest, identity })
    },
    async upsertEdge(input: UpsertGraphEdgeInput): Promise<EdgeResult> {
      return client.post<EdgeResult>('/v1/graph/edges', input)
    },
    async upsertEdges(inputs: UpsertGraphEdgeInput[]): Promise<EdgeResult[]> {
      return client.post<EdgeResult[]>('/v1/graph/edges/batch', { edges: inputs })
    },
    async upsertFact(input: UpsertGraphFactInput): Promise<FactResult> {
      return client.post<FactResult>('/v1/graph/facts', input)
    },
    async upsertFacts(inputs: UpsertGraphFactInput[]): Promise<FactResult[]> {
      return client.post<FactResult[]>('/v1/graph/facts/batch', { facts: inputs })
    },
    async searchEntities(query: string, identity: typegraphIdentity, opts?: {
      limit?: number
      entityType?: string
      minConnections?: number
    }): Promise<EntityResult[]> {
      return client.post<EntityResult[]>('/v1/graph/entities/search', { query, identity, ...opts })
    },
    async getEntity(id: string, opts?: typegraphIdentity): Promise<EntityDetail | null> {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(opts ?? {})) {
        if (typeof value === 'string') params.set(key, value)
      }
      const query = params.toString()
      return client.get<EntityDetail | null>(`/v1/graph/entities/${e(id)}${query ? `?${query}` : ''}`)
    },
    async getEdges(entityId: string, opts?: {
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & typegraphIdentity): Promise<EdgeResult[]> {
      const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts ?? {}
      const identity = { tenantId, groupId, userId, agentId, conversationId }
      return client.post<EdgeResult[]>(`/v1/graph/entities/${e(entityId)}/edges`, { ...rest, identity })
    },
    async searchFacts(query: string, opts?: FactSearchOpts): Promise<FactResult[]> {
      const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts ?? {}
      const identity = { tenantId, groupId, userId, agentId, conversationId }
      return client.post<FactResult[]>('/v1/graph/facts/search', { query, identity, ...rest })
    },
    async explore(query: string, opts?: GraphExploreOpts): Promise<GraphExploreResult> {
      const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts ?? {}
      const identity = { tenantId, groupId, userId, agentId, conversationId }
      return client.post<GraphExploreResult>('/v1/graph/explore', { query, identity, ...rest })
    },
    async getChunksForEntity(entityId: string, opts?: {
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & typegraphIdentity): Promise<ChunkResult[]> {
      const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts ?? {}
      const identity = { tenantId, groupId, userId, agentId, conversationId }
      return client.post<ChunkResult[]>(`/v1/graph/entities/${e(entityId)}/chunks`, { ...rest, identity })
    },
    async explainQuery(query: string, opts?: GraphExplainOpts): Promise<GraphSearchTrace> {
      const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts ?? {}
      const identity = { tenantId, groupId, userId, agentId, conversationId }
      return client.post<GraphSearchTrace>('/v1/graph/query/explain', { query, identity, ...rest })
    },
    async backfill(identity: typegraphIdentity, opts?: GraphBackfillOpts): Promise<GraphBackfillResult> {
      return client.post<GraphBackfillResult>('/v1/graph/backfill', { identity, ...opts })
    },
    async getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult> {
      return client.post<SubgraphResult>('/v1/graph/subgraph', opts)
    },
    async stats(identity: typegraphIdentity): Promise<GraphStats> {
      return client.post<GraphStats>('/v1/graph/stats', { identity })
    },
    async getRelationTypes(identity: typegraphIdentity): Promise<Array<{ relation: string; count: number }>> {
      return client.post('/v1/graph/relation-types', { identity })
    },
    async getEntityTypes(identity: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>> {
      return client.post('/v1/graph/entity-types', { identity })
    },
  }

  function recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recall(query: string, opts: RecallOpts): Promise<MemoryRecord[]>
  function recall(query: string, opts: RecallOpts): Promise<string | MemoryRecord[]> {
    const { tenantId, groupId, userId, agentId, conversationId, ...rest } = opts
    const identity = { tenantId, groupId, userId, agentId, conversationId }
    if (opts.format) {
      return client.post<string>('/v1/memory/recall', { query, identity, ...rest })
    }
    return client.post<MemoryRecord[]>('/v1/memory/recall', { query, identity, ...rest })
  }

  const instance: typegraphCloudInstance = {
    async deploy(_config: typegraphConfig): Promise<typegraphCloudInstance> {
      return instance
    },

    async initialize(_config: typegraphConfig): Promise<typegraphCloudInstance> {
      return instance
    },

    async undeploy(): Promise<UndeployResult> {
      return { success: false, message: 'undeploy() is not available in cloud mode — infrastructure is managed server-side.' }
    },

    buckets,
    sources,
    jobs,
    graph,

    policies: {
      async create(input: CreatePolicyInput): Promise<Policy> {
        return client.post<Policy>('/v1/policies', input)
      },
      async get(id: string): Promise<Policy | null> {
        return client.get<Policy | null>(`/v1/policies/${e(id)}`)
      },
      async list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]> {
        return client.post<Policy[]>('/v1/policies/list', filter)
      },
      async update(id: string, input: UpdatePolicyInput): Promise<Policy> {
        return client.patch<Policy>(`/v1/policies/${e(id)}`, input)
      },
      async delete(id: string): Promise<void> {
        await client.delete(`/v1/policies/${e(id)}`)
      },
    },

    getEmbeddingForBucket(_bucketId: string): EmbeddingProvider {
      throw new Error('getEmbeddingForBucket() is not available in cloud mode — embedding is managed server-side.')
    },

    getDistinctEmbeddings(): Map<string, EmbeddingProvider> {
      throw new Error('getDistinctEmbeddings() is not available in cloud mode — embedding is managed server-side.')
    },

    groupBucketsByModel(): Map<string, string[]> {
      throw new Error('groupBucketsByModel() is not available in cloud mode — embedding is managed server-side.')
    },

    getQueryEmbeddingForBucket(_bucketId: string): EmbeddingProvider {
      throw new Error('getQueryEmbeddingForBucket() is not available in cloud mode — embedding is managed server-side.')
    },

    async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
      return client.post<QueryResponse>('/v1/query', { text, ...opts })
    },

    async ingest(sources: SourceInput[], opts: IngestOptions = {}): Promise<IndexResult> {
      const bucketId = opts.bucketId || DEFAULT_BUCKET_ID
      const normalizedSources = sources.map(normalizeSourceInput)
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/ingest`, { sources: normalizedSources, opts })
    },

    async ingestPreChunked(source: SourceInput, chunks: Chunk[], opts: IngestOptions = {}): Promise<IndexResult> {
      const bucketId = opts.bucketId || DEFAULT_BUCKET_ID
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/ingest`, { source: normalizeSourceInput(source), chunks, opts })
    },

    async remember(content: string, identity: typegraphIdentity, category?: string, opts?: {
      importance?: number
      metadata?: Record<string, unknown>
    }): Promise<MemoryRecord> {
      return client.post<MemoryRecord>('/v1/memory/remember', { content, identity, category, ...opts })
    },

    async forget(id: string, identity: typegraphIdentity): Promise<void> {
      await client.post('/v1/memory/forget', { id, identity })
    },

    async correct(correction: string, identity: typegraphIdentity): Promise<{ invalidated: number; created: number; summary: string }> {
      return client.post('/v1/memory/correct', { correction, identity })
    },

    recall: recall as typegraphInstance['recall'],

    async healthCheck(identity: typegraphIdentity): Promise<MemoryHealthReport> {
      return client.post<MemoryHealthReport>('/v1/memory/health', { identity })
    },

    async addConversationTurn(
      messages: Array<{ role: string; content: string; timestamp?: Date }>,
      identity: typegraphIdentity,
      conversationId?: string,
    ): Promise<ConversationTurnResult> {
      return client.post<ConversationTurnResult>('/v1/memory/conversation', { messages, identity, conversationId })
    },

    async flush(): Promise<void> {
      // No-op in cloud mode — the cloud server is responsible for its own telemetry flushing.
    },

    async destroy(): Promise<void> {
      // No-op in cloud mode
    },

    // ── Source CRUD (cloud-only extensions) ──

    async listSources(filter?: SourceFilter): Promise<typegraphSource[]> {
      return client.post<typegraphSource[]>('/v1/sources/list', filter)
    },

    async getSource(sourceId: string): Promise<typegraphSource> {
      return client.get<typegraphSource>(`/v1/sources/${e(sourceId)}`)
    },

    async updateSource(sourceId: string, update: Partial<typegraphSource>): Promise<typegraphSource> {
      return client.patch<typegraphSource>(`/v1/sources/${e(sourceId)}`, update)
    },

    async deleteSources(filter: SourceFilter): Promise<number> {
      return client.delete<number>('/v1/sources', filter)
    },
  }

  return instance
}
