import type { typegraphInstance, typegraphConfig, BucketsApi, DocumentsApi, EventsApi, ThreadsApi, JobsApi, GraphApi, RequestOptions, DocumentIngestOptions, MemoryApi } from '../typegraph.js'
import type { Bucket, CreateBucketInput, BucketListFilter } from '../types/bucket.js'
import type { SearchOptions, QueryResponse } from '../types/query.js'
import type { IngestOptions, IndexResult } from '../types/index-types.js'
import type { Embedder } from '../embedding/provider.js'
import type { DocumentInput, Chunk, typegraphDocument, DocumentFilter } from '../types/document.js'
import type { EventFilter, EventInput, typegraphEventRecord } from '../types/event.js'
import type { ThreadFilter, ThreadInput, ThreadTurnInput, ThreadTurnResult as GraphThreadTurnResult, typegraphThread } from '../types/thread.js'
import type { TypeGraphOptions, TypeGraphWriteOptions, typegraphIdentity } from '../types/identity.js'
import type { CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType } from '../types/policy.js'
import type { UndeployResult } from '../types/adapter.js'
import type { PaginationOpts, PaginatedResult } from '../types/pagination.js'
import type { MemoryHealthReport } from '../types/memory.js'
import type { ExternalId, MemoryRecord } from '../memory/types/memory.js'
import type { Job, JobFilter } from '../types/job.js'
import type { EntityResult, EntityDetail, EdgeResult, FactResult, FactSearchOpts, GraphExploreOpts, GraphExploreResult, GraphBackfillOpts, GraphBackfillResult, GraphExplainOpts, GraphSearchTrace, ChunkResult, SubgraphOpts, SubgraphResult, GraphStats, RecallOpts, GraphEntityRef, UpsertGraphEdgeInput, UpsertGraphEntityInput, UpsertGraphFactInput, MergeGraphEntitiesInput, MergeGraphEntitiesResult, DeleteGraphEntityOpts, DeleteGraphEntityResult, RememberOpts, ForgetOpts, CorrectOpts, HealthCheckOpts } from '../types/graph-bridge.js'
import { DEFAULT_BUCKET_ID, normalizeDocumentInput } from '../typegraph.js'
import { HttpClient } from './http-client.js'
import type { CloudConfig } from './http-client.js'
import { assertHasMeaningfulFilter, compactTypeGraphContext, contextToIdentity, optionalCompactObject } from '../utils/input.js'

/**
 * Extended typegraph instance for cloud mode.
 * Includes document/event/thread methods available via the hosted API.
 */
export interface typegraphCloudInstance extends typegraphInstance {}

/**
 * Create a typegraph instance backed by the hosted cloud service.
 * Everything runs server-side — embedding, indexing, storage, memory.
 */
export function createCloudInstance(config: CloudConfig): typegraphCloudInstance {
  const client = new HttpClient(config)
  const e = encodeURIComponent
  const tenantId = config.tenantId?.trim() || 'public'

  function normalizeOpts<T extends object>(opts: T | null | undefined, method: string): T {
    return optionalCompactObject<T>(opts, method) as T
  }

  function splitContextOpts<T extends TypeGraphOptions>(
    opts: T | null | undefined,
    method: string,
  ): { identity: typegraphIdentity; rest: Omit<T, 'context'> } {
    const normalized = normalizeOpts<T>(opts, method) as T & Record<string, unknown>
    const { context, ...rest } = normalized
    return {
      identity: contextToIdentity(compactTypeGraphContext(context as TypeGraphOptions['context'], method), tenantId),
      rest: rest as Omit<T, 'context'>,
    }
  }

  function normalizeEventInput(input: EventInput): EventInput {
    return {
      ...input,
      url: input.url ?? undefined,
      documents: input.documents?.map(normalizeDocumentInput),
    }
  }

  function normalizeThreadInput(input: ThreadInput): ThreadInput {
    return {
      ...input,
      url: input.url ?? undefined,
    }
  }

  function normalizeThreadTurnInput(input: ThreadTurnInput): ThreadTurnInput {
    return {
      ...input,
      url: input.url ?? undefined,
    }
  }


  const bucket: BucketsApi = {
    async create(input: CreateBucketInput): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async upsert(input: CreateBucketInput & { id: string }): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async get(bucketId: string): Promise<Bucket | undefined> {
      return client.get<Bucket>(`/v1/buckets/${e(bucketId)}`)
    },
    async list(filter?: BucketListFilter | null, _opts?: TypeGraphOptions | null, pagination?: PaginationOpts | null): Promise<Bucket[] | PaginatedResult<Bucket>> {
      const normalizedFilter = optionalCompactObject<BucketListFilter>(filter, 'bucket.list', 'filter') as BucketListFilter
      const normalizedPagination = pagination == null
        ? undefined
        : optionalCompactObject<PaginationOpts>(pagination, 'bucket.list', 'pagination') as PaginationOpts
      const searchParams = new URLSearchParams()
      if (normalizedFilter.name) searchParams.set('name', normalizedFilter.name)
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

  const document: DocumentsApi = {
    async ingest(input: DocumentInput | DocumentInput[], opts?: DocumentIngestOptions | null): Promise<IndexResult> {
      const normalizedOpts = normalizeOpts<IngestOptions & RequestOptions>(opts, 'document.ingest')
      const bucketId = normalizedOpts.bucketId || DEFAULT_BUCKET_ID
      const documents = (Array.isArray(input) ? input : [input]).map(normalizeDocumentInput)
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/documents/ingest`, { documents, opts: normalizedOpts })
    },

    async ingestPreChunked(input: DocumentInput, chunks: Chunk[], opts?: DocumentIngestOptions | null): Promise<IndexResult> {
      const normalizedOpts = normalizeOpts<IngestOptions & RequestOptions>(opts, 'document.ingestPreChunked')
      const bucketId = normalizedOpts.bucketId || DEFAULT_BUCKET_ID
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/documents/ingest`, { document: normalizeDocumentInput(input), chunks, opts: normalizedOpts })
    },

    async get(id: string): Promise<typegraphDocument | null> {
      return client.get<typegraphDocument | null>(`/v1/documents/${e(id)}`)
    },
    async list(filter?: DocumentFilter | null, _opts?: TypeGraphOptions | null, pagination?: PaginationOpts | null): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>> {
      const normalizedFilter = optionalCompactObject<DocumentFilter>(filter, 'document.list', 'filter') as DocumentFilter
      const normalizedPagination = pagination == null
        ? undefined
        : optionalCompactObject<PaginationOpts>(pagination, 'document.list', 'pagination') as PaginationOpts
      if (normalizedPagination) {
        return client.post<PaginatedResult<typegraphDocument>>('/v1/documents/list', { ...normalizedFilter, ...normalizedPagination })
      }
      return client.post<typegraphDocument[]>('/v1/documents/list', normalizedFilter)
    },
    async update(id: string, input): Promise<typegraphDocument> {
      return client.patch<typegraphDocument>(`/v1/documents/${e(id)}`, input)
    },
    async delete(filter: DocumentFilter | null): Promise<number> {
      const normalizedFilter = optionalCompactObject<DocumentFilter>(filter, 'document.delete', 'filter') as DocumentFilter
      assertHasMeaningfulFilter(normalizedFilter, 'document.delete')
      return client.delete<number>('/v1/documents', normalizedFilter)
    },
  }

  const event: EventsApi = {
    async ingest(input: EventInput | EventInput[], opts?: (RequestOptions & { bucketId?: string | undefined }) | null) {
      const { identity, rest } = splitContextOpts(opts, 'event.ingest')
      const eventInput = Array.isArray(input) ? input.map(normalizeEventInput) : normalizeEventInput(input)
      return client.post('/v1/events/ingest', { event: eventInput, identity, ...rest })
    },
    async get(id: string): Promise<typegraphEventRecord | null> {
      return client.get<typegraphEventRecord | null>(`/v1/events/${e(tenantId)}/${e(id)}`)
    },
    async list(filter?: EventFilter | null): Promise<typegraphEventRecord[]> {
      return client.post<typegraphEventRecord[]>('/v1/events/list', optionalCompactObject<EventFilter>(filter, 'event.list', 'filter'))
    },
  }

  const thread: ThreadsApi = {
    async upsert(input: ThreadInput, opts?: TypeGraphWriteOptions | null): Promise<typegraphThread> {
      const { identity } = splitContextOpts(opts, 'thread.upsert')
      return client.post<typegraphThread>('/v1/threads', { thread: normalizeThreadInput(input), identity })
    },
    async get(id: string): Promise<typegraphThread | null> {
      return client.get<typegraphThread | null>(`/v1/threads/${e(tenantId)}/${e(id)}`)
    },
    async list(filter?: ThreadFilter | null): Promise<typegraphThread[]> {
      return client.post<typegraphThread[]>('/v1/threads/list', optionalCompactObject<ThreadFilter>(filter, 'thread.list', 'filter'))
    },
    async addTurn(threadId: string, turn: ThreadTurnInput, opts?: TypeGraphWriteOptions | null): Promise<GraphThreadTurnResult> {
      const { identity, rest } = splitContextOpts(opts, 'thread.addTurn')
      return client.post<GraphThreadTurnResult>(`/v1/threads/${e(threadId)}/turns`, { turn: normalizeThreadTurnInput(turn), identity, ...rest })
    },
  }

  const job: JobsApi = {
    async get(id: string): Promise<Job | null> {
      return client.get<Job | null>(`/v1/jobs/${e(id)}`)
    },
    async list(filter?: JobFilter | null): Promise<Job[]> {
      return client.post<Job[]>('/v1/jobs/list', optionalCompactObject<JobFilter>(filter, 'job.list', 'filter'))
    },
    async upsert(): Promise<Job> {
      throw new Error('job.upsert() is a server-side primitive and is not available in cloud mode.')
    },
    async updateStatus(): Promise<void> {
      throw new Error('job.updateStatus() is a server-side primitive and is not available in cloud mode.')
    },
    async incrementProgress(): Promise<void> {
      throw new Error('job.incrementProgress() is a server-side primitive and is not available in cloud mode.')
    },
  }

  const graph: GraphApi = {
    async upsertEntity(input: UpsertGraphEntityInput): Promise<EntityDetail> {
      return client.post<EntityDetail>('/v1/graph/entities', input)
    },
    async upsertEntities(inputs: UpsertGraphEntityInput[]): Promise<EntityDetail[]> {
      return client.post<EntityDetail[]>('/v1/graph/entities/batch', { entities: inputs })
    },
    async resolveEntity(ref: GraphEntityRef | string, opts?: TypeGraphOptions | null): Promise<EntityDetail | null> {
      const { identity } = splitContextOpts(opts, 'graph.resolveEntity')
      return client.post<EntityDetail | null>('/v1/graph/entities/resolve', {
        ref,
        identity,
      })
    },
    async linkExternalIds(entityId: string, externalIds: ExternalId[], opts?: TypeGraphOptions | null): Promise<EntityDetail> {
      const { identity } = splitContextOpts(opts, 'graph.linkExternalIds')
      return client.post<EntityDetail>(`/v1/graph/entities/${e(entityId)}/external-ids`, {
        externalIds,
        identity,
      })
    },
    async mergeEntities(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult> {
      return client.post<MergeGraphEntitiesResult>('/v1/graph/entities/merge', input)
    },
    async deleteEntity(entityId: string, opts?: DeleteGraphEntityOpts | null): Promise<DeleteGraphEntityResult> {
      const { identity, rest } = splitContextOpts<DeleteGraphEntityOpts & TypeGraphOptions>(opts as DeleteGraphEntityOpts & TypeGraphOptions | null, 'graph.deleteEntity')
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
    async searchEntities(query: string, opts?: ({
      limit?: number
      entityType?: string
      minConnections?: number
    } & TypeGraphOptions) | null): Promise<EntityResult[]> {
      const { identity, rest } = splitContextOpts(opts, 'graph.searchEntities')
      const normalizedOpts = optionalCompactObject<{
        limit?: number
        entityType?: string
        minConnections?: number
      } & TypeGraphOptions>(rest, 'graph.searchEntities') as {
        limit?: number
        entityType?: string
        minConnections?: number
      }
      return client.post<EntityResult[]>('/v1/graph/entities/search', { query, identity, ...normalizedOpts })
    },
    async getEntity(id: string, opts?: TypeGraphOptions | null): Promise<EntityDetail | null> {
      const params = new URLSearchParams()
      const { identity } = splitContextOpts(opts, 'graph.getEntity')
      for (const [key, value] of Object.entries(identity)) {
        if (typeof value === 'string') params.set(key, value)
      }
      const query = params.toString()
      return client.get<EntityDetail | null>(`/v1/graph/entities/${e(id)}${query ? `?${query}` : ''}`)
    },
    async getEdges(entityId: string, opts?: ({
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & TypeGraphOptions) | null): Promise<EdgeResult[]> {
      const { identity, rest } = splitContextOpts<{
        direction?: 'in' | 'out' | 'both'
        relation?: string
        limit?: number
      } & TypeGraphOptions>(opts, 'graph.getEdges')
      return client.post<EdgeResult[]>(`/v1/graph/entities/${e(entityId)}/edges`, { ...rest, identity })
    },
    async searchFacts(query: string, opts?: FactSearchOpts | null): Promise<FactResult[]> {
      const { identity, rest } = splitContextOpts<FactSearchOpts & TypeGraphOptions>(opts as FactSearchOpts & TypeGraphOptions | null, 'graph.searchFacts')
      return client.post<FactResult[]>('/v1/graph/facts/search', { query, identity, ...rest })
    },
    async explore(query: string, opts?: GraphExploreOpts | null): Promise<GraphExploreResult> {
      const { identity, rest } = splitContextOpts<GraphExploreOpts & TypeGraphOptions>(opts as GraphExploreOpts & TypeGraphOptions | null, 'graph.explore')
      return client.post<GraphExploreResult>('/v1/graph/explore', { query, identity, ...rest })
    },
    async getChunksForEntity(entityId: string, opts?: ({
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & TypeGraphOptions) | null): Promise<ChunkResult[]> {
      const { identity, rest } = splitContextOpts<{
        bucketIds?: string[] | undefined
        limit?: number | undefined
      } & TypeGraphOptions>(opts, 'graph.getChunksForEntity')
      return client.post<ChunkResult[]>(`/v1/graph/entities/${e(entityId)}/chunks`, { ...rest, identity })
    },
    async explainQuery(query: string, opts?: GraphExplainOpts | null): Promise<GraphSearchTrace> {
      const { identity, rest } = splitContextOpts<GraphExplainOpts & TypeGraphOptions>(opts as GraphExplainOpts & TypeGraphOptions | null, 'graph.explainQuery')
      return client.post<GraphSearchTrace>('/v1/graph/query/explain', { query, identity, ...rest })
    },
    async backfill(opts?: (GraphBackfillOpts & TypeGraphOptions) | null): Promise<GraphBackfillResult> {
      const { identity, rest } = splitContextOpts<GraphBackfillOpts & TypeGraphOptions>(opts, 'graph.backfill')
      return client.post<GraphBackfillResult>('/v1/graph/backfill', {
        identity,
        ...rest,
      })
    },
    async getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult> {
      return client.post<SubgraphResult>('/v1/graph/subgraph', optionalCompactObject<SubgraphOpts>(opts, 'graph.getSubgraph'))
    },
    async stats(opts?: TypeGraphOptions | null): Promise<GraphStats> {
      const { identity } = splitContextOpts(opts, 'graph.stats')
      return client.post<GraphStats>('/v1/graph/stats', { identity })
    },
    async getRelationTypes(opts?: TypeGraphOptions | null): Promise<Array<{ relation: string; count: number }>> {
      const { identity } = splitContextOpts(opts, 'graph.getRelationTypes')
      return client.post('/v1/graph/relation-types', { identity })
    },
    async getEntityTypes(opts?: TypeGraphOptions | null): Promise<Array<{ entityType: string; count: number }>> {
      const { identity } = splitContextOpts(opts, 'graph.getEntityTypes')
      return client.post('/v1/graph/entity-types', { identity })
    },
  }

  function recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  function recall(query: string, opts?: RecallOpts | null): Promise<string | MemoryRecord[]> {
    const { identity, rest } = splitContextOpts<RecallOpts>(opts, 'memory.recall')
    if (rest.format) {
      return client.post<string>('/v1/memory/recall', { query, identity, ...rest })
    }
    return client.post<MemoryRecord[]>('/v1/memory/recall', { query, identity, ...rest })
  }

  const memory: MemoryApi = {
    async remember(content: string, opts?: RememberOpts | null): Promise<MemoryRecord> {
      const { identity, rest } = splitContextOpts<RememberOpts>(opts, 'memory.remember')
      return client.post<MemoryRecord>('/v1/memory/remember', { content, identity, ...rest })
    },
    async forget(id: string, opts?: ForgetOpts | null): Promise<void> {
      const { identity, rest } = splitContextOpts<ForgetOpts>(opts, 'memory.forget')
      await client.post('/v1/memory/forget', { id, identity, ...rest })
    },
    async correct(correction: string, opts?: CorrectOpts | null): Promise<{ invalidated: number; created: number; summary: string }> {
      const { identity, rest } = splitContextOpts<CorrectOpts>(opts, 'memory.correct')
      return client.post('/v1/memory/correct', { correction, identity, ...rest })
    },
    recall: recall as MemoryApi['recall'],
    async healthCheck(opts?: HealthCheckOpts | null): Promise<MemoryHealthReport> {
      const { identity, rest } = splitContextOpts<HealthCheckOpts>(opts, 'memory.healthCheck')
      return client.post<MemoryHealthReport>('/v1/memory/health', { identity, ...rest })
    },
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

    bucket,
    document,
    event,
    thread,
    job,
    memory,
    graph,

    policy: {
      async create(input: CreatePolicyInput): Promise<Policy> {
        return client.post<Policy>('/v1/policy', input)
      },
      async get(id: string): Promise<Policy | null> {
        return client.get<Policy | null>(`/v1/policy/${e(id)}`)
      },
      async list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean } | null): Promise<Policy[]> {
        return client.post<Policy[]>('/v1/policy/list', optionalCompactObject<{ tenantId?: string; policyType?: PolicyType; enabled?: boolean }>(filter, 'policy.list', 'filter'))
      },
      async update(id: string, input: UpdatePolicyInput): Promise<Policy> {
        return client.patch<Policy>(`/v1/policy/${e(id)}`, input)
      },
      async delete(id: string): Promise<void> {
        await client.delete(`/v1/policy/${e(id)}`)
      },
    },

    getEmbeddingForBucket(_bucketId: string): Embedder {
      throw new Error('getEmbeddingForBucket() is not available in cloud mode — embedding is managed server-side.')
    },

    getDistinctEmbeddings(): Map<string, Embedder> {
      throw new Error('getDistinctEmbeddings() is not available in cloud mode — embedding is managed server-side.')
    },

    groupBucketsByModel(): Map<string, string[]> {
      throw new Error('groupBucketsByModel() is not available in cloud mode — embedding is managed server-side.')
    },

    getSearchEmbeddingForBucket(_bucketId: string): Embedder {
      throw new Error('getSearchEmbeddingForBucket() is not available in cloud mode — embedding is managed server-side.')
    },

    async search(text: string, opts?: SearchOptions | null): Promise<QueryResponse> {
      return client.post<QueryResponse>('/v1/search', { text, ...normalizeOpts<SearchOptions>(opts, 'search') })
    },

    async flush(): Promise<void> {
      // No-op in cloud mode — the cloud server is responsible for its own telemetry flushing.
    },

    async destroy(): Promise<void> {
      // No-op in cloud mode
    },

  }

  return instance
}
