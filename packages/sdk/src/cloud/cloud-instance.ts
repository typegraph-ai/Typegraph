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
import type { EntityResult, EntityDetail, EdgeResult, FactResult, FactSearchOpts, GraphExploreOpts, GraphExploreResult, GraphBackfillOpts, GraphBackfillResult, GraphExplainOpts, GraphSearchTrace, ChunkResult, SubgraphOpts, SubgraphResult, GraphStats, RecallOpts, GraphEntityRef, UpsertGraphEdgeInput, UpsertGraphEntityInput, UpsertGraphFactInput, MergeGraphEntitiesInput, MergeGraphEntitiesResult, DeleteGraphEntityOpts, DeleteGraphEntityResult, RememberOpts, ForgetOpts, CorrectOpts, HealthCheckOpts, AddConversationTurnOpts } from '../types/graph-bridge.js'
import { DEFAULT_BUCKET_ID, normalizeSourceInput } from '../typegraph.js'
import { HttpClient } from './http-client.js'
import type { CloudConfig } from './http-client.js'
import { assertHasMeaningfulFilter, compactIdentity, optionalCompactObject, withDefaultTenant } from '../utils/input.js'

/**
 * Extended typegraph instance for cloud mode.
 * Includes source CRUD methods available via the hosted API.
 */
export interface typegraphCloudInstance extends typegraphInstance {
  listSources(filter?: SourceFilter | null): Promise<typegraphSource[]>
  getSource(sourceId: string): Promise<typegraphSource>
  updateSource(sourceId: string, update: Partial<typegraphSource>): Promise<typegraphSource>
  deleteSources(filter: SourceFilter | null): Promise<number>
}

/**
 * Create a typegraph instance backed by the hosted cloud service.
 * Everything runs server-side — embedding, indexing, storage, memory.
 */
export function createCloudInstance(config: CloudConfig): typegraphCloudInstance {
  const client = new HttpClient(config)
  const e = encodeURIComponent

  function normalizeOpts<T extends typegraphIdentity>(opts: T | null | undefined, method: string): T {
    return withDefaultTenant(opts, config.tenantId, method) as T
  }

  function splitIdentityOpts<T extends typegraphIdentity>(
    opts: T | null | undefined,
    method: string,
  ): { identity: typegraphIdentity; rest: Omit<T, keyof typegraphIdentity> } {
    const normalized = normalizeOpts(opts, method) as T & Record<string, unknown>
    const {
      tenantId,
      groupId,
      userId,
      agentId,
      conversationId,
      agentName,
      agentDescription,
      agentVersion,
      ...rest
    } = normalized
    return {
      identity: compactIdentity({
        tenantId: tenantId as string | undefined,
        groupId: groupId as string | undefined,
        userId: userId as string | undefined,
        agentId: agentId as string | undefined,
        conversationId: conversationId as string | undefined,
        agentName: agentName as string | undefined,
        agentDescription: agentDescription as string | undefined,
        agentVersion: agentVersion as string | undefined,
      }),
      rest: rest as Omit<T, keyof typegraphIdentity>,
    }
  }

  const buckets: BucketsApi = {
    async create(input: CreateBucketInput): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async get(bucketId: string): Promise<Bucket | undefined> {
      return client.get<Bucket>(`/v1/buckets/${e(bucketId)}`)
    },
    async list(filter?: BucketListFilter | null, pagination?: PaginationOpts | null): Promise<Bucket[] | PaginatedResult<Bucket>> {
      const normalizedFilter = optionalCompactObject<BucketListFilter>(filter, 'buckets.list', 'filter') as BucketListFilter
      const normalizedPagination = pagination == null
        ? undefined
        : optionalCompactObject<PaginationOpts>(pagination, 'buckets.list', 'pagination') as PaginationOpts
      const searchParams = new URLSearchParams()
      if (normalizedFilter.tenantId) searchParams.set('tenantId', normalizedFilter.tenantId)
      if (normalizedFilter.groupId) searchParams.set('groupId', normalizedFilter.groupId)
      if (normalizedFilter.userId) searchParams.set('userId', normalizedFilter.userId)
      if (normalizedFilter.agentId) searchParams.set('agentId', normalizedFilter.agentId)
      if (normalizedFilter.conversationId) searchParams.set('conversationId', normalizedFilter.conversationId)
      if (normalizedPagination?.limit != null) searchParams.set('limit', String(normalizedPagination.limit))
      if (normalizedPagination?.offset != null) searchParams.set('offset', String(normalizedPagination.offset))
      const qs = searchParams.toString()
      if (normalizedPagination) {
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
    async list(filter?: SourceFilter | null, pagination?: PaginationOpts | null): Promise<typegraphSource[] | PaginatedResult<typegraphSource>> {
      const normalizedFilter = optionalCompactObject<SourceFilter>(filter, 'sources.list', 'filter') as SourceFilter
      const normalizedPagination = pagination == null
        ? undefined
        : optionalCompactObject<PaginationOpts>(pagination, 'sources.list', 'pagination') as PaginationOpts
      if (normalizedPagination) {
        return client.post<PaginatedResult<typegraphSource>>('/v1/sources/list', { ...normalizedFilter, ...normalizedPagination })
      }
      return client.post<typegraphSource[]>('/v1/sources/list', normalizedFilter)
    },
    async update(id: string, input): Promise<typegraphSource> {
      return client.patch<typegraphSource>(`/v1/sources/${e(id)}`, input)
    },
    async delete(filter: SourceFilter | null): Promise<number> {
      const normalizedFilter = optionalCompactObject<SourceFilter>(filter, 'sources.delete', 'filter') as SourceFilter
      assertHasMeaningfulFilter(normalizedFilter, 'sources.delete')
      return client.delete<number>('/v1/sources', normalizedFilter)
    },
  }

  const jobs: JobsApi = {
    async get(id: string): Promise<Job | null> {
      return client.get<Job | null>(`/v1/jobs/${e(id)}`)
    },
    async list(filter?: JobFilter | null): Promise<Job[]> {
      return client.post<Job[]>('/v1/jobs/list', optionalCompactObject<JobFilter>(filter, 'jobs.list', 'filter'))
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
    async resolveEntity(ref: GraphEntityRef | string, identity?: typegraphIdentity | null): Promise<EntityDetail | null> {
      return client.post<EntityDetail | null>('/v1/graph/entities/resolve', {
        ref,
        identity: normalizeOpts(identity, 'graph.resolveEntity'),
      })
    },
    async linkExternalIds(entityId: string, externalIds: ExternalId[], identity?: typegraphIdentity | null): Promise<EntityDetail> {
      return client.post<EntityDetail>(`/v1/graph/entities/${e(entityId)}/external-ids`, {
        externalIds,
        identity: normalizeOpts(identity, 'graph.linkExternalIds'),
      })
    },
    async mergeEntities(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult> {
      return client.post<MergeGraphEntitiesResult>('/v1/graph/entities/merge', input)
    },
    async deleteEntity(entityId: string, opts?: DeleteGraphEntityOpts | null): Promise<DeleteGraphEntityResult> {
      const { identity, rest } = splitIdentityOpts<DeleteGraphEntityOpts>(opts, 'graph.deleteEntity')
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
    async searchEntities(query: string, identity: typegraphIdentity | null, opts?: {
      limit?: number
      entityType?: string
      minConnections?: number
    } | null): Promise<EntityResult[]> {
      const normalizedIdentity = normalizeOpts(identity, 'graph.searchEntities')
      const normalizedOpts = optionalCompactObject<{
        limit?: number
        entityType?: string
        minConnections?: number
      }>(opts, 'graph.searchEntities') as {
        limit?: number
        entityType?: string
        minConnections?: number
      }
      return client.post<EntityResult[]>('/v1/graph/entities/search', { query, identity: normalizedIdentity, ...normalizedOpts })
    },
    async getEntity(id: string, opts?: typegraphIdentity | null): Promise<EntityDetail | null> {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(normalizeOpts(opts, 'graph.getEntity'))) {
        if (typeof value === 'string') params.set(key, value)
      }
      const query = params.toString()
      return client.get<EntityDetail | null>(`/v1/graph/entities/${e(id)}${query ? `?${query}` : ''}`)
    },
    async getEdges(entityId: string, opts?: ({
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & typegraphIdentity) | null): Promise<EdgeResult[]> {
      const { identity, rest } = splitIdentityOpts<{
        direction?: 'in' | 'out' | 'both'
        relation?: string
        limit?: number
      } & typegraphIdentity>(opts, 'graph.getEdges')
      return client.post<EdgeResult[]>(`/v1/graph/entities/${e(entityId)}/edges`, { ...rest, identity })
    },
    async searchFacts(query: string, opts?: FactSearchOpts | null): Promise<FactResult[]> {
      const { identity, rest } = splitIdentityOpts<FactSearchOpts>(opts, 'graph.searchFacts')
      return client.post<FactResult[]>('/v1/graph/facts/search', { query, identity, ...rest })
    },
    async explore(query: string, opts?: GraphExploreOpts | null): Promise<GraphExploreResult> {
      const { identity, rest } = splitIdentityOpts<GraphExploreOpts>(opts, 'graph.explore')
      return client.post<GraphExploreResult>('/v1/graph/explore', { query, identity, ...rest })
    },
    async getChunksForEntity(entityId: string, opts?: ({
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & typegraphIdentity) | null): Promise<ChunkResult[]> {
      const { identity, rest } = splitIdentityOpts<{
        bucketIds?: string[] | undefined
        limit?: number | undefined
      } & typegraphIdentity>(opts, 'graph.getChunksForEntity')
      return client.post<ChunkResult[]>(`/v1/graph/entities/${e(entityId)}/chunks`, { ...rest, identity })
    },
    async explainQuery(query: string, opts?: GraphExplainOpts | null): Promise<GraphSearchTrace> {
      const { identity, rest } = splitIdentityOpts<GraphExplainOpts>(opts, 'graph.explainQuery')
      return client.post<GraphSearchTrace>('/v1/graph/query/explain', { query, identity, ...rest })
    },
    async backfill(identity: typegraphIdentity | null, opts?: GraphBackfillOpts | null): Promise<GraphBackfillResult> {
      return client.post<GraphBackfillResult>('/v1/graph/backfill', {
        identity: normalizeOpts(identity, 'graph.backfill'),
        ...optionalCompactObject<GraphBackfillOpts>(opts, 'graph.backfill'),
      })
    },
    async getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult> {
      return client.post<SubgraphResult>('/v1/graph/subgraph', optionalCompactObject<SubgraphOpts>(opts, 'graph.getSubgraph'))
    },
    async stats(identity: typegraphIdentity | null): Promise<GraphStats> {
      return client.post<GraphStats>('/v1/graph/stats', { identity: normalizeOpts(identity, 'graph.stats') })
    },
    async getRelationTypes(identity: typegraphIdentity | null): Promise<Array<{ relation: string; count: number }>> {
      return client.post('/v1/graph/relation-types', { identity: normalizeOpts(identity, 'graph.getRelationTypes') })
    },
    async getEntityTypes(identity: typegraphIdentity | null): Promise<Array<{ entityType: string; count: number }>> {
      return client.post('/v1/graph/entity-types', { identity: normalizeOpts(identity, 'graph.getEntityTypes') })
    },
  }

  function recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  function recall(query: string, opts?: RecallOpts | null): Promise<string | MemoryRecord[]> {
    const { identity, rest } = splitIdentityOpts<RecallOpts>(opts, 'recall')
    if (rest.format) {
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
      async list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean } | null): Promise<Policy[]> {
        return client.post<Policy[]>('/v1/policies/list', optionalCompactObject<{ tenantId?: string; policyType?: PolicyType; enabled?: boolean }>(filter, 'policies.list', 'filter'))
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

    async query(text: string, opts?: QueryOpts | null): Promise<QueryResponse> {
      return client.post<QueryResponse>('/v1/query', { text, ...normalizeOpts<QueryOpts>(opts, 'query') })
    },

    async ingest(sources: SourceInput[], opts?: IngestOptions | null): Promise<IndexResult> {
      const normalizedOpts = normalizeOpts<IngestOptions>(opts, 'ingest')
      const bucketId = normalizedOpts.bucketId || DEFAULT_BUCKET_ID
      const normalizedSources = sources.map(normalizeSourceInput)
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/ingest`, { sources: normalizedSources, opts: normalizedOpts })
    },

    async ingestPreChunked(source: SourceInput, chunks: Chunk[], opts?: IngestOptions | null): Promise<IndexResult> {
      const normalizedOpts = normalizeOpts<IngestOptions>(opts, 'ingestPreChunked')
      const bucketId = normalizedOpts.bucketId || DEFAULT_BUCKET_ID
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/ingest`, { source: normalizeSourceInput(source), chunks, opts: normalizedOpts })
    },

    async remember(content: string, opts?: RememberOpts | null): Promise<MemoryRecord> {
      const { identity, rest } = splitIdentityOpts<RememberOpts>(opts, 'remember')
      return client.post<MemoryRecord>('/v1/memory/remember', { content, identity, ...rest })
    },

    async forget(id: string, opts?: ForgetOpts | null): Promise<void> {
      const { identity, rest } = splitIdentityOpts<ForgetOpts>(opts, 'forget')
      await client.post('/v1/memory/forget', { id, identity, ...rest })
    },

    async correct(correction: string, opts?: CorrectOpts | null): Promise<{ invalidated: number; created: number; summary: string }> {
      const { identity, rest } = splitIdentityOpts<CorrectOpts>(opts, 'correct')
      return client.post('/v1/memory/correct', { correction, identity, ...rest })
    },

    recall: recall as typegraphInstance['recall'],

    async healthCheck(opts?: HealthCheckOpts | null): Promise<MemoryHealthReport> {
      const { identity, rest } = splitIdentityOpts<HealthCheckOpts>(opts, 'healthCheck')
      return client.post<MemoryHealthReport>('/v1/memory/health', { identity, ...rest })
    },

    async addConversationTurn(
      messages: Array<{ role: string; content: string; timestamp?: Date }>,
      opts?: AddConversationTurnOpts | null,
    ): Promise<ConversationTurnResult> {
      const { identity, rest } = splitIdentityOpts<AddConversationTurnOpts>(opts, 'addConversationTurn')
      return client.post<ConversationTurnResult>('/v1/memory/conversation', { messages, identity, ...rest })
    },

    async flush(): Promise<void> {
      // No-op in cloud mode — the cloud server is responsible for its own telemetry flushing.
    },

    async destroy(): Promise<void> {
      // No-op in cloud mode
    },

    // ── Source CRUD (cloud-only extensions) ──

    async listSources(filter?: SourceFilter | null): Promise<typegraphSource[]> {
      return client.post<typegraphSource[]>('/v1/sources/list', optionalCompactObject<SourceFilter>(filter, 'listSources', 'filter'))
    },

    async getSource(sourceId: string): Promise<typegraphSource> {
      return client.get<typegraphSource>(`/v1/sources/${e(sourceId)}`)
    },

    async updateSource(sourceId: string, update: Partial<typegraphSource>): Promise<typegraphSource> {
      return client.patch<typegraphSource>(`/v1/sources/${e(sourceId)}`, update)
    },

    async deleteSources(filter: SourceFilter | null): Promise<number> {
      const normalizedFilter = optionalCompactObject<SourceFilter>(filter, 'deleteSources', 'filter') as SourceFilter
      assertHasMeaningfulFilter(normalizedFilter, 'deleteSources')
      return client.delete<number>('/v1/sources', normalizedFilter)
    },
  }

  return instance
}
