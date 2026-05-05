import type { VectorStoreAdapter, UndeployResult } from './types/adapter.js'
import type { Bucket, CreateBucketInput, BucketListFilter, EmbeddingConfig } from './types/bucket.js'
import type { QueryOpts, QueryResponse } from './types/query.js'
import type { IngestOptions, IndexResult } from './types/index-types.js'
import type { EmbeddingProvider } from './embedding/provider.js'
import { embeddingModelKey } from './embedding/provider.js'
import type { RawDocument, Chunk } from './types/connector.js'
import type { typegraphDocument, DocumentFilter, UpsertDocumentInput } from './types/typegraph-document.js'
import type { typegraphHooks } from './types/hooks.js'
import type { LLMProvider, LLMConfig } from './types/llm-provider.js'
import type {
  MemoryBridge, KnowledgeGraphBridge,
  EntityResult, EntityDetail, EdgeResult, FactResult, FactSearchOpts, GraphExploreOpts, GraphExploreResult, GraphBackfillOpts, GraphBackfillResult, GraphExplainOpts, GraphSearchOpts, GraphSearchTrace, ChunkResult,
  SubgraphOpts, SubgraphResult, GraphStats, GraphEntityRef, UpsertGraphEdgeInput, UpsertGraphEntityInput, UpsertGraphFactInput,
  RememberOpts, ForgetOpts, CorrectOpts, AddConversationTurnOpts,
  RecallOpts, HealthCheckOpts,
} from './types/graph-bridge.js'
import type { ExtractionConfig } from './types/extraction-config.js'
import type { typegraphIdentity } from './types/identity.js'
import type { typegraphEventSink, typegraphEventType, TelemetryOpts } from './types/events.js'
import type { PolicyStoreAdapter, CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType, PolicyAction } from './types/policy.js'
import type { ConversationTurnResult, MemoryHealthReport } from './types/memory.js'
import type { ExternalId, MemoryRecord } from './memory/types/memory.js'
import type { typegraphLogger } from './types/logger.js'
import type { Job, JobFilter, UpsertJobInput, JobStatusPatch } from './types/job.js'
import type { PaginationOpts, PaginatedResult } from './types/pagination.js'
import { PolicyEngine, PolicyViolationError } from './governance/policy-engine.js'
import type { AISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { aiSdkLlmProvider, isAISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { IndexEngine } from './index-engine/engine.js'
import { TripleExtractor } from './index-engine/triple-extractor.js'
import { defaultChunker } from './index-engine/chunker.js'
import { QueryPlanner } from './query/planner.js'
import { buildContext } from './query/assemble.js'
import { createCloudInstance } from './cloud/cloud-instance.js'
import { NotFoundError, NotInitializedError, ConfigError } from './types/errors.js'
import { generateId } from './utils/id.js'

// ── Default Bucket ──

export const DEFAULT_BUCKET_ID = 'bkt_default'
export const DEFAULT_BUCKET_NAME = 'Default'
export const DEFAULT_BUCKET_DESCRIPTION = 'System default bucket. All ingested documents without an explicit bucket assignment are stored here. Cannot be deleted.'

// Fills in defaults for optional fields the engine relies on.
export function normalizeRawDocument<TMeta extends Record<string, unknown>>(doc: RawDocument<TMeta>): RawDocument<TMeta> {
  return {
    ...doc,
    url: doc.url ?? undefined,
    updatedAt: doc.updatedAt ?? new Date(),
    metadata: doc.metadata ?? ({} as TMeta),
  }
}

/** @deprecated Use LLMConfig instead. */
export type LLMInput = LLMConfig

export interface typegraphConfig {
  // ── Cloud mode (mutually exclusive with vectorStore/embedding) ──
  /** API key for typegraph cloud. When provided, vectorStore and embedding are not required. */
  apiKey?: string | undefined
  /** Base URL for the cloud API. Defaults to 'https://api.typegraph.dev'. */
  baseUrl?: string | undefined
  /** Request timeout in milliseconds for cloud mode. Default: 30000. */
  timeout?: number | undefined

  // ── Self-hosted mode ──
  vectorStore?: VectorStoreAdapter | undefined
  /** Default embedding provider for ingest and query. Required in self-hosted mode. */
  embedding?: EmbeddingConfig | undefined
  /** Optional separate default query embedding. Must embed into the same vector space as `embedding`.
   *  When set, all buckets use this for queries unless overridden per-bucket. */
  queryEmbedding?: EmbeddingConfig | undefined
  /** Register additional embedding providers for per-bucket overrides.
   *  Each provider is keyed by its `.model` string. Buckets reference these by model name. */
  additionalEmbeddings?: EmbeddingConfig[] | undefined
  tenantId?: string | undefined
  tokenizer?: ((text: string) => number) | undefined
  hooks?: typegraphHooks | undefined
  /** Optional LLM provider for triple extraction, query classification, and memory operations. */
  llm?: LLMConfig | undefined
  /** Memory bridge for conversational memory operations. */
  memory?: MemoryBridge | undefined
  /** Knowledge graph bridge for entity graph and neural retrieval. */
  knowledgeGraph?: KnowledgeGraphBridge | undefined
  /** Configure triple extraction behavior (single-pass vs two-pass, per-pass models). */
  extraction?: ExtractionConfig | undefined
  /** Optional event sink for observability. Events are emitted fire-and-forget. */
  eventSink?: typegraphEventSink | undefined
  /** Optional policy store for governance. When provided, actions are checked against active policies. */
  policyStore?: PolicyStoreAdapter | undefined
  /** Optional logger for debugging. */
  logger?: typegraphLogger | undefined
}

function isEmbeddingProvider(
  value: EmbeddingConfig
): value is EmbeddingProvider {
  return 'embed' in value && 'embedBatch' in value && 'dimensions' in value
}

export function resolveEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  if (isEmbeddingProvider(config)) return config
  if (isAISDKEmbeddingInput(config)) return aiSdkEmbeddingProvider(config)

  throw new ConfigError('Invalid embedding configuration. Pass an EmbeddingProvider ({ embed, embedBatch, dimensions, model }) or an AI SDK embedding model ({ model, dimensions }).')
}

function isLLMProvider(value: LLMConfig): value is LLMProvider {
  return 'generateText' in value && 'generateJSON' in value
}

export function resolveLLMProvider(config: LLMConfig): LLMProvider {
  if (isLLMProvider(config)) return config
  // { model } wrapper
  if (isAISDKLLMInput(config)) return aiSdkLlmProvider(config as AISDKLLMInput)
  // Bare AI SDK model (has doGenerate but not generateText)
  if (typeof config === 'object' && config !== null && 'doGenerate' in config) {
    return aiSdkLlmProvider({ model: config as any })
  }

  throw new ConfigError('Invalid LLM configuration. Pass an LLMProvider ({ generateText, generateJSON }), a bare AI SDK language model, or { model }.')
}

/** Validate typegraph configuration. Throws ConfigError for invalid configs. */
function validateConfig(config: typegraphConfig): void {
  if (config.apiKey && (config.vectorStore || config.embedding)) {
    throw new ConfigError('Both apiKey (cloud mode) and vectorStore/embedding (self-hosted mode) provided. Choose one.')
  }
  if (!config.apiKey) {
    if (!config.vectorStore) {
      throw new ConfigError('Self-hosted mode requires a vectorStore adapter. Pass vectorStore to typegraphConfig.')
    }
    if (!config.embedding) {
      throw new ConfigError('Self-hosted mode requires an embedding provider. Pass embedding to typegraphConfig.')
    }
  }
  if (config.knowledgeGraph && !config.llm) {
    config.logger?.warn('Knowledge graph bridge configured without an LLM. Triple extraction during ingestion will be skipped. Pass llm to typegraphConfig for full graph functionality.')
  }
}

// ── Sub-API Interfaces ──

export interface BucketsApi {
  create(input: CreateBucketInput, opts?: TelemetryOpts): Promise<Bucket>
  get(bucketId: string): Promise<Bucket | undefined>
  list(filter?: BucketListFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>>
  update(bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>, opts?: TelemetryOpts): Promise<Bucket>
  delete(bucketId: string, opts?: TelemetryOpts): Promise<void>
}

export interface DocumentsApi {
  get(id: string): Promise<typegraphDocument | null>
  list(filter?: DocumentFilter, pagination?: PaginationOpts): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>>
  update(id: string, input: Partial<Pick<typegraphDocument, 'title' | 'url' | 'visibility' | 'metadata'>>, opts?: TelemetryOpts): Promise<typegraphDocument>
  delete(filter: DocumentFilter, opts?: TelemetryOpts): Promise<number>
}

export interface JobsApi {
  get(id: string): Promise<Job | null>
  list(filter?: JobFilter): Promise<Job[]>
  /** Create or replace a job row (caller-provided id). Writers use this from background workers. */
  upsert(input: UpsertJobInput): Promise<Job>
  /** Apply a partial status/result/error/progress patch. */
  updateStatus(id: string, patch: JobStatusPatch): Promise<void>
  /** Atomically increment the `progress_processed` counter. */
  incrementProgress(id: string, processedDelta: number): Promise<void>
}

export interface GraphApi {
  upsertEntity(input: UpsertGraphEntityInput, opts?: TelemetryOpts): Promise<EntityDetail>
  upsertEntities(inputs: UpsertGraphEntityInput[], opts?: TelemetryOpts): Promise<EntityDetail[]>
  resolveEntity(ref: GraphEntityRef | string, identity?: typegraphIdentity, opts?: TelemetryOpts): Promise<EntityDetail | null>
  linkExternalIds(entityId: string, externalIds: ExternalId[], identity?: typegraphIdentity & TelemetryOpts): Promise<EntityDetail>
  upsertEdge(input: UpsertGraphEdgeInput, opts?: TelemetryOpts): Promise<EdgeResult>
  upsertEdges(inputs: UpsertGraphEdgeInput[], opts?: TelemetryOpts): Promise<EdgeResult[]>
  upsertFact(input: UpsertGraphFactInput, opts?: TelemetryOpts): Promise<FactResult>
  upsertFacts(inputs: UpsertGraphFactInput[], opts?: TelemetryOpts): Promise<FactResult[]>
  searchEntities(query: string, identity: typegraphIdentity, opts?: {
    limit?: number
    entityType?: string
    minConnections?: number
  } & TelemetryOpts): Promise<EntityResult[]>
  getEntity(id: string, opts?: typegraphIdentity): Promise<EntityDetail | null>
  getEdges(entityId: string, opts?: {
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  } & typegraphIdentity): Promise<EdgeResult[]>
  searchFacts(query: string, opts?: FactSearchOpts & TelemetryOpts): Promise<FactResult[]>
  explore(query: string, opts?: GraphExploreOpts): Promise<GraphExploreResult>
  getChunksForEntity(entityId: string, opts?: {
    bucketIds?: string[] | undefined
    limit?: number | undefined
  } & typegraphIdentity): Promise<ChunkResult[]>
  explainQuery(query: string, opts?: GraphExplainOpts & TelemetryOpts): Promise<GraphSearchTrace>
  backfill(identity: typegraphIdentity, opts?: GraphBackfillOpts & TelemetryOpts): Promise<GraphBackfillResult>
  getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult>
  stats(identity: typegraphIdentity, opts?: TelemetryOpts): Promise<GraphStats>
  getRelationTypes(identity: typegraphIdentity, opts?: TelemetryOpts): Promise<Array<{ relation: string; count: number }>>
  getEntityTypes(identity: typegraphIdentity, opts?: TelemetryOpts): Promise<Array<{ entityType: string; count: number }>>
}

/** The typegraph instance interface — all public methods. */
export interface typegraphInstance {
  /** One-off infrastructure provisioning. Creates all tables/extensions. Idempotent. */
  deploy(config: typegraphConfig): Promise<this>

  /** Lightweight runtime init. Registers jobs, loads state. No DDL. */
  initialize(config: typegraphConfig): Promise<this>

  /** Remove all typegraph infrastructure. Refuses if any table contains data. */
  undeploy(): Promise<UndeployResult>

  buckets: BucketsApi
  documents: DocumentsApi
  jobs: JobsApi

  /** Graph exploration API. Requires graph bridge. */
  graph: GraphApi

  getEmbeddingForBucket(bucketId: string): EmbeddingProvider
  getQueryEmbeddingForBucket(bucketId: string): EmbeddingProvider
  getDistinctEmbeddings(bucketIds?: string[]): Map<string, EmbeddingProvider>
  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]>

  /** Ingest documents. Target bucket set via opts.bucketId (defaults to default bucket). */
  ingest(docs: RawDocument[], opts?: IngestOptions): Promise<IndexResult>

  /** Ingest a document with pre-chunked content. Target bucket set via opts.bucketId. */
  ingestPreChunked(doc: RawDocument, chunks: Chunk[], opts?: IngestOptions): Promise<IndexResult>

  /** Search across buckets. Optionally build an LLM-ready context via opts.context. */
  query(text: string, opts?: QueryOpts): Promise<QueryResponse>

  // ── Memory operations (require graph bridge) ──

  /** Store a memory. LLM extracts triples → entity graph + memory record. */
  remember(content: string, opts: RememberOpts): Promise<MemoryRecord>
  /** Invalidate a memory and its associated graph edges. Identity must match the memory owner. */
  forget(id: string, opts: ForgetOpts): Promise<void>
  /** Apply a natural language correction. */
  correct(correction: string, opts: CorrectOpts): Promise<{ invalidated: number; created: number; summary: string }>
  /** Search memories by semantic similarity. When `opts.format` is set, returns a formatted string ready for an LLM prompt. */
  recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  recall(query: string, opts: RecallOpts): Promise<MemoryRecord[]>
  /** Check memory system health — returns stats about stored memories, entities, and edges. */
  healthCheck(opts?: HealthCheckOpts): Promise<MemoryHealthReport>
  /** Ingest a conversation turn with extraction. */
  addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts: AddConversationTurnOpts,
  ): Promise<ConversationTurnResult>

  // ── Policy operations (require policyStore) ──

  policies: {
    create(input: CreatePolicyInput, opts?: TelemetryOpts): Promise<Policy>
    get(id: string): Promise<Policy | null>
    list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]>
    update(id: string, input: UpdatePolicyInput, opts?: TelemetryOpts): Promise<Policy>
    delete(id: string, opts?: TelemetryOpts): Promise<void>
  }

  /**
   * Drain any buffered telemetry events to the event sink. Safe to call from
   * the end of a request handler or before a short-lived script exits to
   * avoid losing fire-and-forget events that are still in-buffer.
   */
  flush(): Promise<void>

  destroy(): Promise<void>
}

class TypegraphImpl implements typegraphInstance {
  private _buckets = new Map<string, Bucket>()
  private bucketEmbeddings = new Map<string, EmbeddingProvider>()
  private bucketQueryEmbeddings = new Map<string, EmbeddingProvider>()
  private embeddingRegistry = new Map<string, EmbeddingProvider>()
  private adapter!: VectorStoreAdapter
  private defaultEmbedding!: EmbeddingProvider
  private defaultQueryEmbedding?: EmbeddingProvider
  private config!: typegraphConfig
  private configured = false
  private initialized = false
  private bucketsLoaded = false
  private policyEngine?: PolicyEngine

  private get logger() { return this.config?.logger }

  private emitEvent(
    eventType: typegraphEventType,
    targetId?: string,
    payload: Record<string, unknown> = {},
    telemetry?: TelemetryOpts,
  ): void {
    if (!this.config?.eventSink) return
    this.config.eventSink.emit({
      id: crypto.randomUUID(),
      eventType,
      identity: { tenantId: this.config.tenantId },
      targetId,
      payload,
      traceId: telemetry?.traceId,
      spanId: telemetry?.spanId,
      timestamp: new Date(),
    })
  }

  // ── Buckets ──

  buckets: BucketsApi = {
    create: async (input: CreateBucketInput, opts?: TelemetryOpts): Promise<Bucket> => {
      this.assertConfigured()
      const embeddingModel = input.embeddingModel ?? embeddingModelKey(this.defaultEmbedding)
      const queryEmbeddingModel = input.queryEmbeddingModel ?? (this.defaultQueryEmbedding ? embeddingModelKey(this.defaultQueryEmbedding) : undefined)

      // Validate model keys exist in registry
      if (!this.embeddingRegistry.has(embeddingModel)) {
        throw new ConfigError(`Embedding model "${embeddingModel}" is not registered. Register it via embedding, queryEmbedding, or additionalEmbeddings in typegraphConfig.`)
      }
      if (queryEmbeddingModel && !this.embeddingRegistry.has(queryEmbeddingModel)) {
        throw new ConfigError(`Query embedding model "${queryEmbeddingModel}" is not registered. Register it via embedding, queryEmbedding, or additionalEmbeddings in typegraphConfig.`)
      }

      const bucket: Bucket = {
        id: generateId('bkt'),
        name: input.name,
        description: input.description,
        status: 'active',
        embeddingModel,
        queryEmbeddingModel,
        indexDefaults: input.indexDefaults,
        tenantId: input.tenantId ?? this.config.tenantId,
        groupId: input.groupId,
        userId: input.userId,
        agentId: input.agentId,
        conversationId: input.conversationId,
      }
      if (this.adapter.upsertBucket) {
        const persisted = await this.adapter.upsertBucket(bucket)
        this._buckets.set(persisted.id, persisted)
        this.resolveBucketEmbeddings(persisted)
        this.emitEvent('bucket.create', persisted.id, { name: persisted.name }, opts)
        return persisted
      }
      this._buckets.set(bucket.id, bucket)
      this.resolveBucketEmbeddings(bucket)
      this.emitEvent('bucket.create', bucket.id, { name: bucket.name }, opts)
      return bucket
    },

    get: async (bucketId: string): Promise<Bucket | undefined> => {
      if (this.adapter.getBucket) {
        const bucket = await this.adapter.getBucket(bucketId)
        if (bucket) {
          this._buckets.set(bucket.id, bucket)
          if (!this.bucketEmbeddings.has(bucket.id)) {
            this.resolveBucketEmbeddings(bucket)
          }
        }
        return bucket ?? undefined
      }
      return this._buckets.get(bucketId)
    },

    list: async (filter?: BucketListFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>> => {
      if (this.adapter.listBuckets) {
        const result = await this.adapter.listBuckets(filter, pagination)
        const buckets = Array.isArray(result) ? result : result.items
        for (const b of buckets) {
          this._buckets.set(b.id, b)
          if (!this.bucketEmbeddings.has(b.id)) {
            this.resolveBucketEmbeddings(b)
          }
        }
        return result
      }
      let all = [...this._buckets.values()]
      if (filter) {
        if (filter.tenantId) all = all.filter(s => s.tenantId === filter.tenantId)
        if (filter.groupId) all = all.filter(s => s.groupId === filter.groupId)
        if (filter.userId) all = all.filter(s => s.userId === filter.userId)
        if (filter.agentId) all = all.filter(s => s.agentId === filter.agentId)
        if (filter.conversationId) all = all.filter(s => s.conversationId === filter.conversationId)
      }
      if (pagination) {
        const limit = pagination.limit ?? 100
        const offset = pagination.offset ?? 0
        return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }
      }
      return all
    },

    update: async (bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>, opts?: TelemetryOpts): Promise<Bucket> => {
      const bucket = await this.buckets.get(bucketId)
      if (!bucket) throw new NotFoundError('Bucket', bucketId)
      if (input.name !== undefined) bucket.name = input.name
      if (input.description !== undefined) bucket.description = input.description
      if (input.status !== undefined) bucket.status = input.status
      if (input.indexDefaults !== undefined) bucket.indexDefaults = input.indexDefaults
      let result: Bucket
      if (this.adapter.upsertBucket) {
        result = await this.adapter.upsertBucket(bucket)
      } else {
        this._buckets.set(bucket.id, bucket)
        result = bucket
      }
      this.emitEvent('bucket.update', result.id, { name: result.name }, opts)
      return result
    },

    delete: async (bucketId: string, opts?: TelemetryOpts): Promise<void> => {
      if (bucketId === DEFAULT_BUCKET_ID) {
        throw new ConfigError('Cannot delete the default bucket.')
      }
      await this.enforcePolicy('bucket.delete', { tenantId: this.config.tenantId }, bucketId)
      if (this.adapter.deleteBucket) {
        await this.adapter.deleteBucket(bucketId)
      } else {
        this._buckets.delete(bucketId)
      }
      this.bucketEmbeddings.delete(bucketId)
      this.bucketQueryEmbeddings.delete(bucketId)
      this.emitEvent('bucket.delete', bucketId, {}, opts)
    },
  }

  // ── Documents ──

  documents: DocumentsApi = {
    get: async (id: string): Promise<typegraphDocument | null> => {
      this.assertConfigured()
      if (!this.adapter.getDocument) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      return this.adapter.getDocument(id)
    },

    list: async (filter?: DocumentFilter, pagination?: PaginationOpts): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>> => {
      this.assertConfigured()
      if (!this.adapter.listDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      return this.adapter.listDocuments(filter ?? {}, pagination)
    },

    update: async (id: string, input: Partial<Pick<typegraphDocument, 'title' | 'url' | 'visibility' | 'metadata'>>, opts?: TelemetryOpts): Promise<typegraphDocument> => {
      this.assertConfigured()
      if (!this.adapter.updateDocument) {
        throw new ConfigError('Adapter does not support document update operations.')
      }
      const updated = await this.adapter.updateDocument(id, input)
      this.emitEvent('document.update', id, { fields: Object.keys(input) }, opts)
      return updated
    },

    delete: async (filter: DocumentFilter, opts?: TelemetryOpts): Promise<number> => {
      this.assertConfigured()
      if (!this.adapter.deleteDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      await this.enforcePolicy('document.delete', { tenantId: filter.tenantId ?? this.config.tenantId })
      const count = await this.adapter.deleteDocuments(filter)
      if (count > 0) {
        this.emitEvent('document.delete', undefined, { count, filter }, opts)
      }
      return count
    },
  }

  // ── Jobs ──

  jobs: JobsApi = {
    get: async (id: string): Promise<Job | null> => {
      this.assertConfigured()
      if (!this.adapter.getJob) return null
      return this.adapter.getJob(id)
    },
    list: async (filter?: JobFilter): Promise<Job[]> => {
      this.assertConfigured()
      if (!this.adapter.listJobs) return []
      const res = await this.adapter.listJobs(filter ?? {})
      return Array.isArray(res) ? res : res.items
    },
    upsert: async (input: UpsertJobInput): Promise<Job> => {
      this.assertConfigured()
      if (!this.adapter.upsertJob) {
        throw new ConfigError('Adapter does not support job persistence.')
      }
      return this.adapter.upsertJob(input)
    },
    updateStatus: async (id: string, patch: JobStatusPatch): Promise<void> => {
      this.assertConfigured()
      if (!this.adapter.updateJobStatus) {
        throw new ConfigError('Adapter does not support job persistence.')
      }
      return this.adapter.updateJobStatus(id, patch)
    },
    incrementProgress: async (id: string, processedDelta: number): Promise<void> => {
      this.assertConfigured()
      if (!this.adapter.incrementJobProgress) {
        throw new ConfigError('Adapter does not support job persistence.')
      }
      return this.adapter.incrementJobProgress(id, processedDelta)
    },
  }

  // ── Graph Exploration ──

  graph: GraphApi = {
    upsertEntity: async (input: UpsertGraphEntityInput, opts?: TelemetryOpts): Promise<EntityDetail> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEntity) throw new ConfigError('Knowledge graph bridge does not support entity seeding.')
      const result = await kg.upsertEntity(input)
      this.emitEvent('graph.entity.upsert' as typegraphEventType, result.id, { name: result.name }, opts)
      return result
    },

    upsertEntities: async (inputs: UpsertGraphEntityInput[], opts?: TelemetryOpts): Promise<EntityDetail[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEntities) throw new ConfigError('Knowledge graph bridge does not support entity seeding.')
      const results = await kg.upsertEntities(inputs)
      this.emitEvent('graph.entity.upsert' as typegraphEventType, undefined, { count: results.length }, opts)
      return results
    },

    resolveEntity: async (
      ref: GraphEntityRef | string,
      identity?: typegraphIdentity,
      _opts?: TelemetryOpts,
    ): Promise<EntityDetail | null> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.resolveEntity) throw new ConfigError('Knowledge graph bridge does not support entity resolution.')
      return kg.resolveEntity(ref, identity)
    },

    linkExternalIds: async (
      entityId: string,
      externalIds: ExternalId[],
      identity?: typegraphIdentity & TelemetryOpts,
    ): Promise<EntityDetail> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.linkExternalIds) throw new ConfigError('Knowledge graph bridge does not support deterministic entity external IDs.')
      const result = await kg.linkExternalIds(entityId, externalIds, identity)
      this.emitEvent('graph.entity.external_ids.link' as typegraphEventType, entityId, { count: externalIds.length }, identity)
      return result
    },

    upsertEdge: async (input: UpsertGraphEdgeInput, opts?: TelemetryOpts): Promise<EdgeResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEdge) throw new ConfigError('Knowledge graph bridge does not support edge seeding.')
      const result = await kg.upsertEdge(input)
      this.emitEvent('graph.edge.upsert' as typegraphEventType, result.id, { relation: result.relation }, opts)
      return result
    },

    upsertEdges: async (inputs: UpsertGraphEdgeInput[], opts?: TelemetryOpts): Promise<EdgeResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEdges) throw new ConfigError('Knowledge graph bridge does not support edge seeding.')
      const results = await kg.upsertEdges(inputs)
      this.emitEvent('graph.edge.upsert' as typegraphEventType, undefined, { count: results.length }, opts)
      return results
    },

    upsertFact: async (input: UpsertGraphFactInput, opts?: TelemetryOpts): Promise<FactResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertFact) throw new ConfigError('Knowledge graph bridge does not support fact seeding.')
      const result = await kg.upsertFact(input)
      this.emitEvent('graph.fact.upsert' as typegraphEventType, result.id, { relation: result.relation }, opts)
      return result
    },

    upsertFacts: async (inputs: UpsertGraphFactInput[], opts?: TelemetryOpts): Promise<FactResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertFacts) throw new ConfigError('Knowledge graph bridge does not support fact seeding.')
      const results = await kg.upsertFacts(inputs)
      this.emitEvent('graph.fact.upsert' as typegraphEventType, undefined, { count: results.length }, opts)
      return results
    },

    searchEntities: async (query: string, identity: typegraphIdentity, opts?: {
      limit?: number
      entityType?: string
      minConnections?: number
    } & TelemetryOpts): Promise<EntityResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.searchEntities) throw new ConfigError('Knowledge graph bridge does not support entity search.')
      let results = await kg.searchEntities(query, identity, opts?.limit)
      if (opts?.entityType) {
        results = results.filter(r => r.entityType === opts.entityType)
      }
      if (opts?.minConnections !== undefined) {
        const minConnections = opts.minConnections
        results = results.filter(r => r.edgeCount >= minConnections)
      }
      return results
    },

    getEntity: async (id: string, opts?: typegraphIdentity): Promise<EntityDetail | null> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getEntity) throw new ConfigError('Knowledge graph bridge does not support entity lookup.')
      return kg.getEntity(id, opts)
    },

    getEdges: async (entityId: string, opts?: {
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & typegraphIdentity): Promise<EdgeResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getEdges) throw new ConfigError('Knowledge graph bridge does not support edge queries.')
      return kg.getEdges(entityId, opts)
    },

    searchFacts: async (query: string, opts?: FactSearchOpts & TelemetryOpts): Promise<FactResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.searchFacts) throw new ConfigError('Knowledge graph bridge does not support fact search.')
      return kg.searchFacts(query, opts)
    },

    explore: async (query: string, opts?: GraphExploreOpts): Promise<GraphExploreResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.explore) throw new ConfigError('Knowledge graph bridge does not support graph exploration.')
      return kg.explore(query, opts)
    },

    getChunksForEntity: async (entityId: string, opts?: {
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & typegraphIdentity): Promise<ChunkResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getChunksForEntity) throw new ConfigError('Knowledge graph bridge does not support chunk lookup.')
      return kg.getChunksForEntity(entityId, opts)
    },

    explainQuery: async (query: string, opts?: GraphExplainOpts & TelemetryOpts): Promise<GraphSearchTrace> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.explainQuery) throw new ConfigError('Knowledge graph bridge does not support graph query explanations.')
      return kg.explainQuery(query, opts)
    },

    backfill: async (identity: typegraphIdentity, opts?: GraphBackfillOpts & TelemetryOpts): Promise<GraphBackfillResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.backfill) throw new ConfigError('Knowledge graph bridge does not support graph backfill.')
      return kg.backfill(identity, opts)
    },

    getSubgraph: async (opts: SubgraphOpts): Promise<SubgraphResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getSubgraph) throw new ConfigError('Knowledge graph bridge does not support subgraph extraction.')
      return kg.getSubgraph(opts)
    },

    stats: async (identity: typegraphIdentity, _opts?: TelemetryOpts): Promise<GraphStats> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getGraphStats) throw new ConfigError('Knowledge graph bridge does not support stats.')
      return kg.getGraphStats(identity)
    },

    getRelationTypes: async (identity: typegraphIdentity, _opts?: TelemetryOpts): Promise<Array<{ relation: string; count: number }>> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getRelationTypes) throw new ConfigError('Knowledge graph bridge does not support relation type queries.')
      return kg.getRelationTypes(identity)
    },

    getEntityTypes: async (identity: typegraphIdentity, _opts?: TelemetryOpts): Promise<Array<{ entityType: string; count: number }>> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getEntityTypes) throw new ConfigError('Knowledge graph bridge does not support entity type queries.')
      return kg.getEntityTypes(identity)
    },
  }

  // ── Core Methods ──

  private applyConfig(config: typegraphConfig): void {
    this.config = config
    this.adapter = config.vectorStore!

    // Resolve default providers
    this.defaultEmbedding = resolveEmbeddingProvider(config.embedding!)
    if (config.queryEmbedding) {
      this.defaultQueryEmbedding = resolveEmbeddingProvider(config.queryEmbedding)
    }

    // Build embedding registry — keyed by dimension-aware key "{model}:{dimensions}"
    this.embeddingRegistry.clear()
    this.embeddingRegistry.set(embeddingModelKey(this.defaultEmbedding), this.defaultEmbedding)
    if (this.defaultQueryEmbedding) {
      const qKey = embeddingModelKey(this.defaultQueryEmbedding)
      if (!this.embeddingRegistry.has(qKey)) {
        this.embeddingRegistry.set(qKey, this.defaultQueryEmbedding)
      }
    }
    if (config.additionalEmbeddings) {
      for (const embConfig of config.additionalEmbeddings) {
        const provider = resolveEmbeddingProvider(embConfig)
        const key = embeddingModelKey(provider)
        if (this.embeddingRegistry.has(key)) {
          throw new ConfigError(`Duplicate embedding "${key}" in additionalEmbeddings. Each model+dimensions combination must be unique.`)
        }
        this.embeddingRegistry.set(key, provider)
      }
    }
  }

  /** Resolve a bucket's embedding + query embedding model strings to providers from the registry. */
  private resolveBucketEmbeddings(bucket: Bucket): void {
    // Resolve ingest embedding — bucket stores dimension-aware keys
    const ingestModel = bucket.embeddingModel ?? embeddingModelKey(this.defaultEmbedding)
    const ingestProvider = this.embeddingRegistry.get(ingestModel)
    if (!ingestProvider) {
      throw new ConfigError(
        `Bucket "${bucket.name}" uses embedding model "${ingestModel}" which was not provided in config. ` +
        `Register it via embedding, queryEmbedding, or additionalEmbeddings.`
      )
    }
    this.bucketEmbeddings.set(bucket.id, ingestProvider)

    // Resolve query embedding: explicit bucket override → default query embedding → ingest provider
    const queryModel = bucket.queryEmbeddingModel
    if (queryModel) {
      const queryProvider = this.embeddingRegistry.get(queryModel)
      if (!queryProvider) {
        throw new ConfigError(
          `Bucket "${bucket.name}" uses query embedding model "${queryModel}" which was not provided in config. ` +
          `Register it via embedding, queryEmbedding, or additionalEmbeddings.`
        )
      }
      this.bucketQueryEmbeddings.set(bucket.id, queryProvider)
    } else if (this.defaultQueryEmbedding) {
      this.bucketQueryEmbeddings.set(bucket.id, this.defaultQueryEmbedding)
    } else {
      this.bucketQueryEmbeddings.set(bucket.id, ingestProvider)
    }
  }

  /** Lazy-load buckets from DB on first use. No-op after first call. */
  private async ensureBucketsLoaded(): Promise<void> {
    if (this.bucketsLoaded) return
    if (this.adapter.listBuckets) {
      const result = await this.adapter.listBuckets()
      const allBuckets = Array.isArray(result) ? result : result.items
      for (const bucket of allBuckets) {
        this._buckets.set(bucket.id, bucket)
        this.resolveBucketEmbeddings(bucket)
      }
    }
    this.bucketsLoaded = true
  }

  async deploy(config: typegraphConfig): Promise<this> {
    validateConfig(config)
    this.applyConfig(config)
    await this.adapter.deploy()
    if (this.memoryBridge?.deploy) {
      await this.memoryBridge.deploy()
    }
    if (this.graphBridge?.deploy) {
      await this.graphBridge.deploy()
    }
    if (config.policyStore) {
      this.policyEngine = new PolicyEngine(config.policyStore, config.eventSink)
    }
    this.configured = true

    // Create the default protected bucket (idempotent via upsert)
    const defaultBucket: Bucket = {
      id: DEFAULT_BUCKET_ID,
      name: DEFAULT_BUCKET_NAME,
      description: DEFAULT_BUCKET_DESCRIPTION,
      status: 'active',
      embeddingModel: embeddingModelKey(this.defaultEmbedding),
      queryEmbeddingModel: this.defaultQueryEmbedding ? embeddingModelKey(this.defaultQueryEmbedding) : undefined,
      tenantId: config.tenantId,
    }
    if (this.adapter.upsertBucket) {
      const persisted = await this.adapter.upsertBucket(defaultBucket)
      this._buckets.set(persisted.id, persisted)
    } else {
      this._buckets.set(defaultBucket.id, defaultBucket)
    }
    this.resolveBucketEmbeddings(defaultBucket)
    this.bucketsLoaded = true

    return this
  }

  async initialize(config: typegraphConfig): Promise<this> {
    validateConfig(config)
    this.applyConfig(config)

    await this.adapter.connect()

    // Proactively ensure the default embedding model is registered.
    // Idempotent: Map.has() short-circuits, CREATE IF NOT EXISTS + ON CONFLICT DO NOTHING.
    // Heals missing registry rows that would otherwise cause "No table registered" on query.
    const defaultModelKey = embeddingModelKey(this.defaultEmbedding)
    await this.adapter.ensureModel(defaultModelKey, this.defaultEmbedding.dimensions)
    if (this.defaultQueryEmbedding) {
      const queryModelKey = embeddingModelKey(this.defaultQueryEmbedding)
      if (queryModelKey !== defaultModelKey) {
        await this.adapter.ensureModel(queryModelKey, this.defaultQueryEmbedding.dimensions)
      }
    }

    if (config.policyStore) {
      this.policyEngine = new PolicyEngine(config.policyStore, config.eventSink)
    }
    this.configured = true
    this.initialized = true
    this.logger?.info('typegraph initialized', { tenantId: config.tenantId })
    return this
  }

  async undeploy(): Promise<UndeployResult> {
    this.assertConfigured()
    if (!this.adapter.undeploy) {
      return { success: false, message: 'Adapter does not support undeploy().' }
    }
    const result = await this.adapter.undeploy()
    if (result.success) {
      this._buckets.clear()
      this.bucketEmbeddings.clear()
      this.bucketQueryEmbeddings.clear()
      this.bucketsLoaded = false
      this.configured = false
      this.initialized = false
    }
    return result
  }

  getEmbeddingForBucket(bucketId: string): EmbeddingProvider {
    const embedding = this.bucketEmbeddings.get(bucketId)
    if (!embedding) throw new NotFoundError('Bucket', bucketId)
    return embedding
  }

  getQueryEmbeddingForBucket(bucketId: string): EmbeddingProvider {
    return this.bucketQueryEmbeddings.get(bucketId) ?? this.getEmbeddingForBucket(bucketId)
  }

  private async resolveEmbeddingForBucket(bucketId: string): Promise<EmbeddingProvider> {
    await this.ensureBucketsLoaded()
    const cached = this.bucketEmbeddings.get(bucketId)
    if (cached) return cached
    const bucket = await this.buckets.get(bucketId)
    if (!bucket) throw new NotFoundError('Bucket', bucketId)
    return this.bucketEmbeddings.get(bucketId) ?? this.defaultEmbedding
  }

  /**
   * Resolve per-call IngestOptions against bucket defaults.
   *
   * - Bucket-mergeable fields inherit from `bucket.indexDefaults` when unset on the call.
   * - Runtime-only fields (identity, batch behavior, tracing) pass through untouched.
   * - `graphExtraction` resolves to: per-call → bucket default → false. If the resolved
   *   value is true but the instance lacks `llm` or `knowledgeGraph`, throws ConfigError.
   */
  private resolveIngestOptions(opts: IngestOptions, bucket: Bucket): IngestOptions {
    const defaults = bucket.indexDefaults
    const resolved: IngestOptions = defaults
      ? {
          ...opts,
          chunkSize: opts.chunkSize ?? defaults.chunkSize,
          chunkOverlap: opts.chunkOverlap ?? defaults.chunkOverlap,
          deduplicateBy: opts.deduplicateBy ?? defaults.deduplicateBy,
          visibility: opts.visibility ?? defaults.visibility,
          stripMarkdownForEmbedding: opts.stripMarkdownForEmbedding ?? defaults.stripMarkdownForEmbedding,
          preprocessForEmbedding: opts.preprocessForEmbedding ?? defaults.preprocessForEmbedding,
          propagateMetadata: opts.propagateMetadata ?? defaults.propagateMetadata,
          graphExtraction: opts.graphExtraction ?? defaults.graphExtraction ?? false,
        }
      : { ...opts, graphExtraction: opts.graphExtraction ?? false }

    if (resolved.graphExtraction && (!this.config.llm || !this.graphBridge)) {
      throw new ConfigError(
        'graphExtraction: true was requested (per-call or via bucket.indexDefaults) but this TypeGraph instance is not configured with both `llm` and `knowledgeGraph`. Configure both to enable triple extraction, or set graphExtraction: false.'
      )
    }
    return resolved
  }

  getDistinctEmbeddings(bucketIds?: string[]): Map<string, EmbeddingProvider> {
    const map = new Map<string, EmbeddingProvider>()
    const ids = bucketIds ?? [...this._buckets.keys()]
    for (const id of ids) {
      const emb = this.bucketEmbeddings.get(id)
      if (emb) map.set(embeddingModelKey(emb), emb)
    }
    return map
  }

  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    const ids = bucketIds ?? [...this._buckets.keys()]
    for (const id of ids) {
      const emb = this.bucketEmbeddings.get(id)
      if (!emb) continue
      const key = embeddingModelKey(emb)
      const group = groups.get(key) ?? []
      group.push(id)
      groups.set(key, group)
    }
    return groups
  }

  async ingest(docs: RawDocument[], opts: IngestOptions = {}): Promise<IndexResult> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const resolvedBucketId = opts.bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.buckets.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const resolvedOpts = this.resolveIngestOptions(opts, bucket)
    const chunkSize = resolvedOpts.chunkSize ?? 512
    const chunkOverlap = resolvedOpts.chunkOverlap ?? 64
    const normalizedDocs = docs.map(doc => normalizeRawDocument(doc))
    const items = await Promise.all(normalizedDocs.map(async doc => ({ doc, chunks: await defaultChunker(doc, { chunkSize, chunkOverlap }) })))
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)
    this.logger?.info('Ingesting documents', { bucketId: resolvedBucketId, count: docs.length })
    await this.config.hooks?.onIndexStart?.(resolvedBucketId, resolvedOpts)
    const result = await engine.ingestBatch(resolvedBucketId, items, resolvedOpts)
    result.status = 'complete'
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    this.logger?.info('Ingestion complete', {
      bucketId: resolvedBucketId,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      durationMs: result.durationMs,
    })
    return result
  }

  async ingestPreChunked(doc: RawDocument, chunks: Chunk[], opts: IngestOptions = {}): Promise<IndexResult> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const resolvedBucketId = opts.bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.buckets.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const resolvedOpts = this.resolveIngestOptions(opts, bucket)
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)

    await this.config.hooks?.onIndexStart?.(resolvedBucketId, resolvedOpts)
    const result = await engine.ingestWithChunks(resolvedBucketId, normalizeRawDocument(doc), chunks, resolvedOpts)
    result.status = 'complete'
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    return result
  }

  async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    await this.enforcePolicy('query', { tenantId: opts?.tenantId ?? this.config.tenantId })

    // Batched lazy-load: if the caller names buckets we haven't seen, fetch them in one round-trip.
    // Avoids per-id gets in the hot path without forcing eager load at init.
    if (opts?.buckets?.length && this.adapter.getBuckets) {
      const missing = opts.buckets.filter(id => !this._buckets.has(id))
      if (missing.length > 0) {
        const fetched = await this.adapter.getBuckets(missing)
        for (const b of fetched) {
          this._buckets.set(b.id, b)
          this.resolveBucketEmbeddings(b)
        }
      }
    }

    const planner = new QueryPlanner(
      this.adapter,
      [...this._buckets.keys()],
      this.bucketEmbeddings,
      this.bucketQueryEmbeddings,
      this.memoryBridge,
      this.graphBridge,
      this.config.eventSink,
      this.logger,
    )
    const response = await planner.execute(text, {
      ...opts,
      tenantId: opts?.tenantId ?? this.config.tenantId,
    })

    // Build LLM-ready context if requested.
    if (opts?.context) {
      const built = buildContext(response.results, opts.context, this.config.tokenizer)
      response.context = built.context
      response.contextStats = built.stats
    }

    await this.config.hooks?.onQueryResults?.(text, response.results)
    return response
  }

  // ── Memory operations ──

  private get memoryBridge(): MemoryBridge | undefined {
    return this.config.memory
  }

  private get graphBridge(): KnowledgeGraphBridge | undefined {
    return this.config.knowledgeGraph
  }

  private requireMemory(): MemoryBridge {
    const bridge = this.memoryBridge
    if (!bridge) {
      throw new ConfigError('Memory not configured. Pass a MemoryBridge via typegraphConfig.memory to enable memory operations.')
    }
    return bridge
  }

  private requireKnowledgeGraph(): KnowledgeGraphBridge {
    const bridge = this.graphBridge
    if (!bridge) {
      throw new ConfigError('Knowledge graph not configured. Pass a KnowledgeGraphBridge via typegraphConfig.knowledgeGraph to enable graph operations.')
    }
    return bridge
  }

  async remember(content: string, opts: RememberOpts): Promise<MemoryRecord> {
    await this.enforcePolicy('memory.write', opts)
    return this.requireMemory().remember(content, opts)
  }

  async forget(id: string, opts: ForgetOpts): Promise<void> {
    await this.enforcePolicy('memory.delete', opts, id)
    return this.requireMemory().forget(id, opts)
  }

  async correct(correction: string, opts: CorrectOpts): Promise<{ invalidated: number; created: number; summary: string }> {
    return this.requireMemory().correct(correction, opts)
  }

  async recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  async recall(query: string, opts: RecallOpts): Promise<MemoryRecord[]>
  async recall(query: string, opts: RecallOpts): Promise<MemoryRecord[] | string> {
    await this.enforcePolicy('memory.read', opts)
    if (opts.format) {
      return this.requireMemory().recall(query, opts as RecallOpts & { format: 'xml' | 'markdown' | 'plain' })
    }
    return this.requireMemory().recall(query, opts)
  }

  async healthCheck(opts?: HealthCheckOpts): Promise<MemoryHealthReport> {
    const mem = this.requireMemory()
    if (!mem.healthCheck) throw new ConfigError('healthCheck not supported by this memory bridge.')
    return mem.healthCheck(opts)
  }

  async addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts: AddConversationTurnOpts,
  ): Promise<ConversationTurnResult> {
    const result = await this.requireMemory().addConversationTurn(messages, opts)

    // The bridge returns the underlying ExtractionResult cast to ConversationTurnResult;
    // read the real shape here for hook dispatch (Fix 10).
    const internal = result as unknown as {
      episodic?: unknown[]
      facts?: unknown[]
      operations?: unknown[]
      _contradictions?: Array<{ existingId: string; newId: string; conflictType: string; reasoning: string }>
    }

    const hooks = this.config?.hooks
    if (hooks?.onMemoryExtracted) {
      try {
        await hooks.onMemoryExtracted({
          episodicCount: internal.episodic?.length ?? 0,
          factsExtracted: internal.facts?.length ?? 0,
          operationsCount: internal.operations?.length ?? 0,
        })
      } catch (err) {
        this.logger?.error?.('[typegraph] onMemoryExtracted hook failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (hooks?.onContradictionDetected && internal._contradictions && internal._contradictions.length > 0) {
      try {
        await hooks.onContradictionDetected(internal._contradictions)
      } catch (err) {
        this.logger?.error?.('[typegraph] onContradictionDetected hook failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    return result
  }

  // ── Policy operations ──

  private requirePolicyStore(): PolicyStoreAdapter {
    if (!this.config.policyStore) {
      throw new ConfigError('Policy store not configured. Pass a policyStore to typegraphConfig to enable policy operations.')
    }
    return this.config.policyStore
  }

  policies = {
    create: async (input: CreatePolicyInput, opts?: TelemetryOpts): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.createPolicy(input)
      this.emitEvent('policy.create', policy.id, { name: policy.name, policyType: policy.policyType }, opts)
      return policy
    },

    get: async (id: string): Promise<Policy | null> => {
      const store = this.requirePolicyStore()
      return store.getPolicy(id)
    },

    list: async (filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]> => {
      const store = this.requirePolicyStore()
      return store.listPolicies(filter)
    },

    update: async (id: string, input: UpdatePolicyInput, opts?: TelemetryOpts): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.updatePolicy(id, input)
      this.emitEvent('policy.update', policy.id, { name: policy.name }, opts)
      return policy
    },

    delete: async (id: string, opts?: TelemetryOpts): Promise<void> => {
      const store = this.requirePolicyStore()
      await store.deletePolicy(id)
      this.emitEvent('policy.delete', id, {}, opts)
    },
  }

  async flush(): Promise<void> {
    const sink = this.config?.eventSink
    if (sink?.flush) {
      await sink.flush()
    }
  }

  async destroy(): Promise<void> {
    const sink = this.config?.eventSink as
      | (typegraphEventSink & { destroy?: () => Promise<void> })
      | undefined
    if (sink?.destroy) {
      await sink.destroy()
    } else if (sink?.flush) {
      await sink.flush()
    }
    await this.adapter?.destroy?.()
  }

  private createIndexEngine(embedding: EmbeddingProvider): IndexEngine {
    const engine = new IndexEngine(this.adapter, embedding, this.config.eventSink, this.logger)
    const kg = this.graphBridge
    if (this.config.llm && kg) {
      const mainLlm = resolveLLMProvider(this.config.llm)
      const ext = this.config.extraction
      engine.tripleExtractor = new TripleExtractor({
        llm: ext?.entityLlm ? resolveLLMProvider(ext.entityLlm) : mainLlm,
        relationshipLlm: ext?.relationshipLlm ? resolveLLMProvider(ext.relationshipLlm) : undefined,
        graph: kg,
        twoPass: ext?.twoPass ?? true,
      })
    }
    return engine
  }

  private async enforcePolicy(action: PolicyAction, identity?: typegraphIdentity, targetId?: string): Promise<void> {
    if (!this.policyEngine) return
    await this.policyEngine.enforce({
      action,
      identity: identity ?? { tenantId: this.config.tenantId },
      targetId,
    })
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new NotInitializedError()
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.configured || !this.initialized) {
      throw new NotInitializedError()
    }
  }
}

/**
 * Runtime initialization. No DDL. Returns a ready-to-use instance.
 * - **Cloud mode**: pass `{ apiKey }` — everything runs server-side.
 * - **Self-hosted mode**: pass `{ vectorStore, embedding }`.
 */
export async function typegraphInit(config: typegraphConfig): Promise<typegraphInstance> {
  if (config.apiKey) {
    return createCloudInstance({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      tenantId: config.tenantId,
      timeout: config.timeout,
    })
  }

  const instance = new TypegraphImpl()
  return instance.initialize(config)
}

/** One-time infrastructure provisioning. Creates all tables/extensions. Idempotent.
 *  Returns an instance that is NOT initialized for runtime use. Call initialize() after. */
export async function typegraphDeploy(config: typegraphConfig): Promise<typegraphInstance> {
  return new TypegraphImpl().deploy(config)
}
