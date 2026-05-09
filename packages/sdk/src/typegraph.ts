import type { VectorStoreAdapter, UndeployResult } from './types/adapter.js'
import type { Bucket, CreateBucketInput, BucketListFilter, BucketStorageFilter, EmbeddingConfig } from './types/bucket.js'
import type { QueryOpts, QueryResponse } from './types/query.js'
import type { IngestOptions, IndexResult } from './types/index-types.js'
import type { Embedder } from './embedding/provider.js'
import { embeddingModelKey } from './embedding/provider.js'
import type { DocumentInput, Chunk, typegraphDocument, DocumentFilter, DocumentStorageFilter } from './types/document.js'
import type { EventInput, EventFilter, EventStorageFilter, typegraphEventRecord } from './types/event.js'
import type { ThreadInput, ThreadFilter, ThreadStorageFilter, ThreadTurnInput, ThreadTurnResult as GraphThreadTurnResult, typegraphThread } from './types/thread.js'
import type { UpsertLinkInput } from './types/link.js'
import type { typegraphHooks } from './types/hooks.js'
import type { LLMProvider, LLMConfig } from './types/llm-provider.js'
import type {
  MemoryBridge, KnowledgeGraphBridge,
  EntityResult, EntityDetail, EdgeResult, FactResult, FactSearchOpts, GraphExploreOpts, GraphExploreResult, GraphBackfillOpts, GraphBackfillResult, GraphExplainOpts, GraphSearchOpts, GraphSearchTrace, ChunkResult,
  SubgraphOpts, SubgraphResult, GraphStats, GraphEntityRef, UpsertGraphEdgeInput, UpsertGraphEntityInput, UpsertGraphFactInput,
  MergeGraphEntitiesInput, MergeGraphEntitiesResult, DeleteGraphEntityOpts, DeleteGraphEntityResult,
  RememberOpts, ForgetOpts, CorrectOpts, AddThreadTurnOpts,
  RecallOpts, HealthCheckOpts,
} from './types/graph-bridge.js'
import type { ExtractionCoreferenceCache, Extractor, Reranker } from './types/extractor.js'
import type { AccessScope, TypeGraphOptions, TypeGraphWriteOptions, typegraphIdentity } from './types/identity.js'
import { identityAccessScope } from './types/identity.js'
import type { typegraphEventSink, typegraphEventType, TelemetryOpts } from './types/events.js'
import type { PolicyStoreAdapter, CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType, PolicyAction } from './types/policy.js'
import type { ThreadTurnResult, MemoryHealthReport } from './types/memory.js'
import type { ExternalId, MemoryRecord } from './memory/types/memory.js'
import type { typegraphLogger } from './types/logger.js'
import type { Job, JobFilter, UpsertJobInput, JobStatusPatch } from './types/job.js'
import type { PaginationOpts, PaginatedResult } from './types/pagination.js'
import type { OntologyConfig } from './types/ontology.js'
import { PolicyEngine, PolicyViolationError } from './governance/policy-engine.js'
import type { AISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { aiSdkEmbedder, isAISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { aiSdkLlmProvider, isAISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { IndexEngine } from './index-engine/engine.js'
import { DefaultGraphExtractor } from './index-engine/triple-extractor.js'
import { defaultChunker } from './index-engine/chunker.js'
import { QueryPlanner } from './query/planner.js'
import { buildPrompt } from './query/assemble.js'
import { createCloudInstance } from './cloud/cloud-instance.js'
import { createMemoryBridge } from './memory/memory-bridge.js'
import { createKnowledgeGraphBridge } from './graph/graph-bridge.js'
import { NotFoundError, NotInitializedError, ConfigError } from './types/errors.js'
import { generateId } from './utils/id.js'
import { assertHasMeaningfulFilter, assertNoLegacyPublicContextKeys, compactTypeGraphContext, contextAccess, contextTelemetry, contextToIdentity, hasMeaningfulFilter, optionalCompactObject } from './utils/input.js'

// ── Default Bucket ──

export const DEFAULT_BUCKET_ID = 'bkt_default'
export const DEFAULT_BUCKET_NAME = 'Default'
export const DEFAULT_BUCKET_DESCRIPTION = 'System default bucket. All ingested documents without an explicit bucket assignment are stored here. Cannot be deleted.'

// Fills in defaults for optional fields the engine relies on.
export function normalizeDocumentInput<TMeta extends Record<string, unknown>>(document: DocumentInput<TMeta>): DocumentInput<TMeta> {
  return {
    ...document,
    url: document.url ?? undefined,
    updatedAt: document.updatedAt ?? new Date(),
    metadata: document.metadata ?? ({} as TMeta),
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
  /** Default embedder for ingest and query. Required in self-hosted mode. */
  embedding?: EmbeddingConfig | undefined
  /** Optional separate default search embedding. Must embed into the same vector space as `embedding`.
   *  When set, all buckets use this for search unless overridden per-bucket. */
  searchEmbedding?: EmbeddingConfig | undefined
  /** Register additional embedders for per-bucket overrides.
   *  Each provider is keyed by its `.model` string. Buckets reference these by model name. */
  additionalEmbeddings?: EmbeddingConfig[] | undefined
  tenantId: string
  tokenizer?: ((text: string) => number) | undefined
  hooks?: typegraphHooks | undefined
  /** Optional LLM provider for triple extraction, query classification, and memory operations. */
  llm?: LLMConfig | undefined
  /** Optional custom extractor. When omitted, TypeGraph uses its internal default extractor. */
  extractor?: Extractor | undefined
  /** Optional short-lived cache for cross-source entity coreference context. */
  extractionCoreferenceCache?: ExtractionCoreferenceCache | undefined
  /** Optional reranker for search result post-processing. */
  reranker?: Reranker | undefined
  /** Config-driven ontology for deploy/init; cloud can cache this, self-hosted can pass it at process init. */
  ontology?: OntologyConfig | undefined
  /** Optional event sink for observability. Events are emitted fire-and-forget. */
  eventSink?: typegraphEventSink | undefined
  /** Optional policy store for governance. When provided, actions are checked against active policy. */
  policyStore?: PolicyStoreAdapter | undefined
  /** Optional logger for debugging. */
  logger?: typegraphLogger | undefined
}

function isEmbedder(value: EmbeddingConfig): value is Embedder {
  return 'embed' in value && 'dimensions' in value && 'name' in value
}

export function resolveEmbedder(config: EmbeddingConfig): Embedder {
  if (isEmbedder(config)) return config
  if (isAISDKEmbeddingInput(config)) return aiSdkEmbedder(config)

  throw new ConfigError('Invalid embedding configuration. Pass an Embedder ({ name, dimensions, embed }) or an AI SDK embedding model ({ model, dimensions }).')
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
  if (!config.tenantId?.trim()) {
    throw new ConfigError('tenantId is required. TypeGraph stores every record inside exactly one tenant boundary.')
  }
  if (config.apiKey && (config.vectorStore || config.embedding)) {
    throw new ConfigError('Both apiKey (cloud mode) and vectorStore/embedding (self-hosted mode) provided. Choose one.')
  }
  if (!config.apiKey) {
    if (!config.vectorStore) {
      throw new ConfigError('Self-hosted mode requires a vectorStore adapter. Pass vectorStore to typegraphConfig.')
    }
    if (!config.embedding) {
      throw new ConfigError('Self-hosted mode requires an embedder. Pass embedding to typegraphConfig.')
    }
  }
  if (config.ontology && !config.ontology.version?.trim()) {
    throw new ConfigError('ontology.version is required when ontology config is supplied.')
  }
}

// ── Sub-API Interfaces ──

export interface BucketsApi {
  create(input: CreateBucketInput, opts?: TypeGraphOptions | null): Promise<Bucket>
  get(bucketId: string, opts?: TypeGraphOptions | null): Promise<Bucket | undefined>
  list(filter?: BucketListFilter | null, opts?: TypeGraphOptions | null, pagination?: PaginationOpts | null): Promise<Bucket[] | PaginatedResult<Bucket>>
  update(bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>, opts?: TypeGraphOptions | null): Promise<Bucket>
  delete(bucketId: string, opts?: TypeGraphOptions | null): Promise<void>
}

export interface RequestOptions extends TypeGraphOptions {}

export type DocumentIngestOptions = Omit<IngestOptions, 'tenantId' | 'groupId' | 'userId' | 'agentId' | 'threadId' | 'accessScope' | 'traceId' | 'spanId' | 'bucketId' | 'graphExtraction'> & TypeGraphWriteOptions

export interface DocumentsApi {
  ingest(input: DocumentInput | DocumentInput[], opts: DocumentIngestOptions): Promise<IndexResult>
  ingestPreChunked(input: DocumentInput, chunks: Chunk[], opts: DocumentIngestOptions): Promise<IndexResult>
  get(id: string, opts?: TypeGraphOptions | null): Promise<typegraphDocument | null>
  list(filter?: DocumentFilter | null, opts?: TypeGraphOptions | null, pagination?: PaginationOpts | null): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>>
  update(id: string, input: Partial<Pick<typegraphDocument, 'name' | 'description' | 'url' | 'metadata'>>, opts?: TypeGraphOptions | null): Promise<typegraphDocument>
  delete(filter: DocumentFilter | null, opts?: TypeGraphOptions | null): Promise<number>
}

export interface EventBatchIngestResult {
  events: typegraphEventRecord[]
  documents?: IndexResult[] | undefined
  inserted: number
  updated: number
  failed: number
}

export interface EventIngestOptions extends TypeGraphWriteOptions {}

export interface EventsApi {
  ingest(input: EventInput | EventInput[], opts: EventIngestOptions): Promise<typegraphEventRecord | EventBatchIngestResult>
  get(id: string, opts?: TypeGraphOptions | null): Promise<typegraphEventRecord | null>
  list(filter?: EventFilter | null, opts?: TypeGraphOptions | null): Promise<typegraphEventRecord[]>
}

export interface ThreadsApi {
  upsert(input: ThreadInput, opts?: TypeGraphOptions | null): Promise<typegraphThread>
  get(id: string, opts?: TypeGraphOptions | null): Promise<typegraphThread | null>
  list(filter?: ThreadFilter | null, opts?: TypeGraphOptions | null): Promise<typegraphThread[]>
  addTurn(threadId: string, turn: ThreadTurnInput, opts?: (TypeGraphOptions & { graphExtraction?: boolean | undefined }) | null): Promise<GraphThreadTurnResult>
}

export interface JobsApi {
  get(id: string): Promise<Job | null>
  list(filter?: JobFilter | null): Promise<Job[]>
  /** Create or replace a job row (caller-provided id). Writers use this from background workers. */
  upsert(input: UpsertJobInput): Promise<Job>
  /** Apply a partial status/result/error/progress patch. */
  updateStatus(id: string, patch: JobStatusPatch): Promise<void>
  /** Atomically increment the `progress_processed` counter. */
  incrementProgress(id: string, processedDelta: number): Promise<void>
}

export interface GraphApi {
  upsertEntity(input: UpsertGraphEntityInput, opts?: TypeGraphOptions | null): Promise<EntityDetail>
  upsertEntities(inputs: UpsertGraphEntityInput[], opts?: TypeGraphOptions | null): Promise<EntityDetail[]>
  resolveEntity(ref: GraphEntityRef | string, opts?: TypeGraphOptions | null): Promise<EntityDetail | null>
  linkExternalIds(entityId: string, externalIds: ExternalId[], opts?: TypeGraphOptions | null): Promise<EntityDetail>
  mergeEntities(input: MergeGraphEntitiesInput, opts?: TypeGraphOptions | null): Promise<MergeGraphEntitiesResult>
  deleteEntity(entityId: string, opts?: (DeleteGraphEntityOpts & TypeGraphOptions) | null): Promise<DeleteGraphEntityResult>
  upsertEdge(input: UpsertGraphEdgeInput, opts?: TypeGraphOptions | null): Promise<EdgeResult>
  upsertEdges(inputs: UpsertGraphEdgeInput[], opts?: TypeGraphOptions | null): Promise<EdgeResult[]>
  upsertFact(input: UpsertGraphFactInput, opts?: TypeGraphOptions | null): Promise<FactResult>
  upsertFacts(inputs: UpsertGraphFactInput[], opts?: TypeGraphOptions | null): Promise<FactResult[]>
  searchEntities(query: string, opts?: ({
    limit?: number
    entityType?: string
    minConnections?: number
  } & TypeGraphOptions) | null): Promise<EntityResult[]>
  getEntity(id: string, opts?: TypeGraphOptions | null): Promise<EntityDetail | null>
  getEdges(entityId: string, opts?: ({
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  } & TypeGraphOptions) | null): Promise<EdgeResult[]>
  searchFacts(query: string, opts?: (FactSearchOpts & TypeGraphOptions) | null): Promise<FactResult[]>
  explore(query: string, opts?: (GraphExploreOpts & TypeGraphOptions) | null): Promise<GraphExploreResult>
  getChunksForEntity(entityId: string, opts?: ({
    bucketIds?: string[] | undefined
    limit?: number | undefined
  } & TypeGraphOptions) | null): Promise<ChunkResult[]>
  explainQuery(query: string, opts?: (GraphExplainOpts & TypeGraphOptions) | null): Promise<GraphSearchTrace>
  backfill(opts?: (GraphBackfillOpts & TypeGraphOptions) | null): Promise<GraphBackfillResult>
  getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult>
  stats(opts?: TypeGraphOptions | null): Promise<GraphStats>
  getRelationTypes(opts?: TypeGraphOptions | null): Promise<Array<{ relation: string; count: number }>>
  getEntityTypes(opts?: TypeGraphOptions | null): Promise<Array<{ entityType: string; count: number }>>
}

/** The typegraph instance interface — all public methods. */
export interface typegraphInstance {
  /** One-off infrastructure provisioning. Creates all tables/extensions. Idempotent. */
  deploy(config: typegraphConfig): Promise<this>

  /** Lightweight runtime init. Registers jobs, loads state. No DDL. */
  initialize(config: typegraphConfig): Promise<this>

  /** Remove all typegraph infrastructure. Refuses if any table contains data. */
  undeploy(): Promise<UndeployResult>

  bucket: BucketsApi
  document: DocumentsApi
  event: EventsApi
  thread: ThreadsApi
  job: JobsApi

  /** Graph exploration API. Requires graph bridge. */
  graph: GraphApi

  getEmbeddingForBucket(bucketId: string): Embedder
  getSearchEmbeddingForBucket(bucketId: string): Embedder
  getDistinctEmbeddings(bucketIds?: string[]): Map<string, Embedder>
  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]>

  /** Search across buckets. Optionally build an LLM-ready context via opts.context. */
  search(text: string, opts?: QueryOpts | null): Promise<QueryResponse>

  // ── Memory operations (require graph bridge) ──

  /** Store a memory. LLM extracts triples → entity graph + memory record. */
  remember(content: string, opts?: RememberOpts | null): Promise<MemoryRecord>
  /** Invalidate a memory and its associated graph edges. Identity must match the memory owner. */
  forget(id: string, opts?: ForgetOpts | null): Promise<void>
  /** Apply a natural language correction. */
  correct(correction: string, opts?: CorrectOpts | null): Promise<{ invalidated: number; created: number; summary: string }>
  /** Search memories by semantic similarity. When `opts.format` is set, returns a formatted string ready for an LLM prompt. */
  recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  /** Check memory system health — returns stats about stored memories, entities, and edges. */
  healthCheck(opts?: HealthCheckOpts | null): Promise<MemoryHealthReport>
  /** Ingest a conversation turn with extraction. */
  addThreadTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts?: AddThreadTurnOpts | null,
  ): Promise<ThreadTurnResult>

  // ── Policy operations (require policyStore) ──

  policy: {
    create(input: CreatePolicyInput, opts?: TelemetryOpts | null): Promise<Policy>
    get(id: string): Promise<Policy | null>
    list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean } | null): Promise<Policy[]>
    update(id: string, input: UpdatePolicyInput, opts?: TelemetryOpts | null): Promise<Policy>
    delete(id: string, opts?: TelemetryOpts | null): Promise<void>
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
  private bucketEmbeddings = new Map<string, Embedder>()
  private bucketSearchEmbeddings = new Map<string, Embedder>()
  private embeddingRegistry = new Map<string, Embedder>()
  private adapter!: VectorStoreAdapter
  private defaultEmbedding!: Embedder
  private defaultSearchEmbedding?: Embedder
  private memoryBridgeInstance: MemoryBridge | undefined
  private graphBridgeInstance: KnowledgeGraphBridge | undefined
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
    telemetry?: TelemetryOpts | null,
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

  bucket: BucketsApi = {
    create: async (input: CreateBucketInput, opts?: TypeGraphOptions | null): Promise<Bucket> => {
      this.assertConfigured()
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'bucket.create')
      const embeddingModel = input.embeddingModel ?? embeddingModelKey(this.defaultEmbedding)
      const searchEmbeddingModel = input.searchEmbeddingModel ?? (this.defaultSearchEmbedding ? embeddingModelKey(this.defaultSearchEmbedding) : undefined)

      // Validate model keys exist in registry
      if (!this.embeddingRegistry.has(embeddingModel)) {
        throw new ConfigError(`Embedding model "${embeddingModel}" is not registered. Register it via embedding, searchEmbedding, or additionalEmbeddings in typegraphConfig.`)
      }
      if (searchEmbeddingModel && !this.embeddingRegistry.has(searchEmbeddingModel)) {
        throw new ConfigError(`Search embedding model "${searchEmbeddingModel}" is not registered. Register it via embedding, searchEmbedding, or additionalEmbeddings in typegraphConfig.`)
      }

      const bucket: Bucket = {
        id: generateId('bkt'),
        name: input.name,
        description: input.description,
        status: 'active',
        embeddingModel,
        searchEmbeddingModel,
        indexDefaults: input.indexDefaults,
        tenantId: identity.tenantId,
        groupId: identity.groupId,
        userId: identity.userId,
        agentId: identity.agentId,
        threadId: identity.threadId,
        accessScope: access,
      }
      if (this.adapter.upsertBucket) {
        const persisted = await this.adapter.upsertBucket(bucket)
        this._buckets.set(persisted.id, persisted)
        this.resolveBucketEmbeddings(persisted)
        this.emitEvent('bucket.create', persisted.id, { name: persisted.name }, telemetry)
        return persisted
      }
      this._buckets.set(bucket.id, bucket)
      this.resolveBucketEmbeddings(bucket)
      this.emitEvent('bucket.create', bucket.id, { name: bucket.name }, telemetry)
      return bucket
    },

    get: async (bucketId: string, opts?: TypeGraphOptions | null): Promise<Bucket | undefined> => {
      const { identity } = this.resolvePublicOptions(opts, 'bucket.get')
      if (this.adapter.getBucket) {
        const bucket = await this.adapter.getBucket(bucketId)
        if (bucket && bucket.tenantId !== identity.tenantId) return undefined
        if (bucket && !this.canRead(bucket.accessScope, identity)) return undefined
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

    list: async (filter?: BucketListFilter | null, opts?: TypeGraphOptions | null, pagination?: PaginationOpts | null): Promise<Bucket[] | PaginatedResult<Bucket>> => {
      const { identity } = this.resolvePublicOptions(opts, 'bucket.list')
      const normalizedFilter = optionalCompactObject<BucketListFilter>(filter, 'bucket.list', 'filter') as BucketListFilter
      const normalizedPagination = pagination == null
        ? undefined
        : optionalCompactObject<PaginationOpts>(pagination, 'bucket.list', 'pagination') as PaginationOpts
      if (this.adapter.listBuckets) {
        const result = await this.adapter.listBuckets({ ...normalizedFilter, tenantId: identity.tenantId } as BucketStorageFilter, normalizedPagination)
        const buckets = Array.isArray(result) ? result : result.items
        const visibleBuckets = buckets.filter(bucket => this.canRead(bucket.accessScope, identity))
        for (const b of buckets) {
          this._buckets.set(b.id, b)
          if (!this.bucketEmbeddings.has(b.id)) {
            this.resolveBucketEmbeddings(b)
          }
        }
        return Array.isArray(result) ? visibleBuckets : { ...result, items: visibleBuckets }
      }
      let all = [...this._buckets.values()].filter(bucket => bucket.tenantId === identity.tenantId && this.canRead(bucket.accessScope, identity))
      if (hasMeaningfulFilter(normalizedFilter)) {
        if (normalizedFilter.name) all = all.filter(s => s.name === normalizedFilter.name)
      }
      if (normalizedPagination) {
        const limit = normalizedPagination.limit ?? 100
        const offset = normalizedPagination.offset ?? 0
        return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }
      }
      return all
    },

    update: async (bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>, opts?: TypeGraphOptions | null): Promise<Bucket> => {
      const { access, telemetry } = this.resolvePublicOptions(opts, 'bucket.update')
      const bucket = await this.bucket.get(bucketId, opts)
      if (!bucket) throw new NotFoundError('Bucket', bucketId)
      if (input.name !== undefined) bucket.name = input.name
      if (input.description !== undefined) bucket.description = input.description
      if (input.status !== undefined) bucket.status = input.status
      if (input.indexDefaults !== undefined) bucket.indexDefaults = input.indexDefaults
      if (access !== undefined) bucket.accessScope = access
      let result: Bucket
      if (this.adapter.upsertBucket) {
        result = await this.adapter.upsertBucket(bucket)
      } else {
        this._buckets.set(bucket.id, bucket)
        result = bucket
      }
      this.emitEvent('bucket.update', result.id, { name: result.name }, telemetry)
      return result
    },

    delete: async (bucketId: string, opts?: TypeGraphOptions | null): Promise<void> => {
      const { identity, telemetry } = this.resolvePublicOptions(opts, 'bucket.delete')
      if (bucketId === DEFAULT_BUCKET_ID) {
        throw new ConfigError('Cannot delete the default bucket.')
      }
      await this.enforcePolicy('bucket.delete', identity, bucketId)
      if (this.adapter.deleteBucket) {
        await this.adapter.deleteBucket(bucketId)
      } else {
        this._buckets.delete(bucketId)
      }
      this.bucketEmbeddings.delete(bucketId)
      this.bucketSearchEmbeddings.delete(bucketId)
      this.emitEvent('bucket.delete', bucketId, {}, telemetry)
    },
  }

  // ── Documents ──

  document: DocumentsApi = {
    ingest: async (input: DocumentInput | DocumentInput[], opts?: DocumentIngestOptions | null): Promise<IndexResult> => {
      return this.ingestDocuments(Array.isArray(input) ? input : [input], opts)
    },

    ingestPreChunked: async (input: DocumentInput, chunks: Chunk[], opts?: DocumentIngestOptions | null): Promise<IndexResult> => {
      return this.ingestDocumentChunks(input, chunks, opts)
    },

    get: async (id: string, opts?: TypeGraphOptions | null): Promise<typegraphDocument | null> => {
      this.assertConfigured()
      const { identity } = this.resolvePublicOptions(opts, 'document.get')
      if (!this.adapter.getDocument) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      const document = await this.adapter.getDocument(id)
      if (!document) return null
      if (document.tenantId !== identity.tenantId) return null
      return this.canRead(document.accessScope, identity) ? document : null
    },

    list: async (filter?: DocumentFilter | null, opts?: TypeGraphOptions | null, pagination?: PaginationOpts | null): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>> => {
      this.assertConfigured()
      const { identity, readAccess } = this.resolvePublicOptions(opts, 'document.list')
      if (!this.adapter.listDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      const normalizedFilter = optionalCompactObject<DocumentFilter>(filter, 'document.list', 'filter') as DocumentFilter
      const normalizedPagination = pagination == null
        ? undefined
        : optionalCompactObject<PaginationOpts>(pagination, 'document.list', 'pagination') as PaginationOpts
      return this.adapter.listDocuments({ ...normalizedFilter, tenantId: identity.tenantId, accessScope: readAccess } as DocumentStorageFilter, normalizedPagination)
    },

    update: async (id: string, input: Partial<Pick<typegraphDocument, 'name' | 'description' | 'url' | 'metadata'>>, opts?: TypeGraphOptions | null): Promise<typegraphDocument> => {
      this.assertConfigured()
      const { access, telemetry } = this.resolvePublicOptions(opts, 'document.update')
      if (!this.adapter.updateDocument) {
        throw new ConfigError('Adapter does not support document update operations.')
      }
      const updated = await this.adapter.updateDocument(id, access === undefined ? input : { ...input, accessScope: access })
      this.emitEvent('document.update', id, { fields: Object.keys(input) }, telemetry)
      return updated
    },

    delete: async (filter: DocumentFilter | null, opts?: TypeGraphOptions | null): Promise<number> => {
      this.assertConfigured()
      const { identity, readAccess, telemetry } = this.resolvePublicOptions(opts, 'document.delete')
      if (!this.adapter.deleteDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      const normalizedFilter = optionalCompactObject<DocumentFilter>(filter, 'document.delete', 'filter') as DocumentFilter
      assertHasMeaningfulFilter(normalizedFilter, 'document.delete')
      await this.enforcePolicy('document.delete', identity)
      const count = await this.adapter.deleteDocuments({ ...normalizedFilter, tenantId: identity.tenantId, accessScope: readAccess } as DocumentStorageFilter)
      if (count > 0) {
        this.emitEvent('document.delete', undefined, { count, filter: normalizedFilter }, telemetry)
      }
      return count
    },
  }

  event: EventsApi = {
    ingest: async (input: EventInput | EventInput[], opts: EventIngestOptions): Promise<typegraphEventRecord | EventBatchIngestResult> => {
      if (Array.isArray(input)) {
        const events: typegraphEventRecord[] = []
        const documents: IndexResult[] = []
        let failed = 0
        for (const eventInput of input) {
          try {
            const result = await this.ingestSingleEvent(eventInput, opts)
            events.push(result.event)
            documents.push(...result.documents)
          } catch {
            failed += 1
          }
        }
        return { events, documents: documents.length > 0 ? documents : undefined, inserted: events.length, updated: 0, failed }
      }
      const result = await this.ingestSingleEvent(input, opts)
      return result.event
    },

    get: async (id: string, opts?: TypeGraphOptions | null): Promise<typegraphEventRecord | null> => {
      this.assertConfigured()
      const { identity } = this.resolvePublicOptions(opts, 'event.get')
      if (!this.adapter.getEvent) throw new ConfigError('Adapter does not support event operations.')
      const event = await this.adapter.getEvent(identity.tenantId, id)
      return event && this.canRead(event.accessScope, identity) ? event : null
    },

    list: async (filter?: EventFilter | null, opts?: TypeGraphOptions | null): Promise<typegraphEventRecord[]> => {
      this.assertConfigured()
      const { identity, readAccess } = this.resolvePublicOptions(opts, 'event.list')
      if (!this.adapter.listEvents) throw new ConfigError('Adapter does not support event operations.')
      return this.adapter.listEvents({
        ...(optionalCompactObject<EventFilter>(filter, 'event.list', 'filter') as EventFilter),
        tenantId: identity.tenantId,
        accessScope: readAccess,
      } as EventStorageFilter)
    },
  }

  thread: ThreadsApi = {
    upsert: async (input: ThreadInput, opts?: RequestOptions | null): Promise<typegraphThread> => {
      this.assertConfigured()
      if (!this.adapter.upsertThread) throw new ConfigError('Adapter does not support thread operations.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'thread.upsert')
      const thread = await this.adapter.upsertThread({
        id: input.id ?? generateId('thr'),
        tenantId: identity.tenantId,
        groupId: identity.groupId,
        userId: identity.userId,
        agentId: identity.agentId,
        name: input.name,
        description: input.description,
        metadata: input.metadata ?? {},
        accessScope: access,
      })
      this.emitEvent('thread.upsert', thread.id, { name: thread.name }, telemetry)
      return thread
    },

    get: async (id: string, opts?: TypeGraphOptions | null): Promise<typegraphThread | null> => {
      this.assertConfigured()
      const { identity } = this.resolvePublicOptions(opts, 'thread.get')
      if (!this.adapter.getThread) throw new ConfigError('Adapter does not support thread operations.')
      const thread = await this.adapter.getThread(identity.tenantId, id)
      return thread && this.canRead(thread.accessScope, identity) ? thread : null
    },

    list: async (filter?: ThreadFilter | null, opts?: TypeGraphOptions | null): Promise<typegraphThread[]> => {
      this.assertConfigured()
      const { identity, readAccess } = this.resolvePublicOptions(opts, 'thread.list')
      if (!this.adapter.listThreads) throw new ConfigError('Adapter does not support thread operations.')
      return this.adapter.listThreads({
        ...(optionalCompactObject<ThreadFilter>(filter, 'thread.list', 'filter') as ThreadFilter),
        tenantId: identity.tenantId,
        accessScope: readAccess,
      } as ThreadStorageFilter)
    },

    addTurn: async (threadId: string, turn: ThreadTurnInput, opts?: (TypeGraphOptions & { graphExtraction?: boolean | undefined }) | null): Promise<GraphThreadTurnResult> => {
      const { identity } = this.resolvePublicOptions(opts, 'thread.addTurn')
      const existingThread = this.adapter.getThread
        ? await this.adapter.getThread(identity.tenantId, threadId)
        : null
      const thread = await this.thread.upsert({
        id: threadId,
        name: existingThread?.name ?? threadId,
        description: existingThread?.description,
        metadata: { ...(existingThread?.metadata ?? {}), threadId, ...(turn.metadata ?? {}) },
      }, opts)
      const event = await this.ingestSingleEvent({
        name: `${turn.role} turn`,
        occurredAt: turn.timestamp ?? new Date(),
        content: turn.content,
        metadata: { role: turn.role, ...(turn.metadata ?? {}) },
      }, { ...(opts ?? {}), context: { ...(opts?.context ?? {}), threadId } })
      if (this.adapter.upsertLink) {
        await this.adapter.upsertLink({
          tenantId: identity.tenantId,
          fromKind: 'thread',
          fromId: threadId,
          toKind: 'event',
          toId: event.event.id,
          relation: 'turn',
        })
      }
      return { thread, event: event.event }
    },
  }

  // ── Jobs ──

  job: JobsApi = {
    get: async (id: string): Promise<Job | null> => {
      this.assertConfigured()
      if (!this.adapter.getJob) return null
      return this.adapter.getJob(id)
    },
    list: async (filter?: JobFilter | null): Promise<Job[]> => {
      this.assertConfigured()
      if (!this.adapter.listJobs) return []
      const normalizedFilter = optionalCompactObject<JobFilter>(filter, 'job.list', 'filter') as JobFilter
      const res = await this.adapter.listJobs(normalizedFilter)
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
    upsertEntity: async (input: UpsertGraphEntityInput, opts?: TypeGraphOptions | null): Promise<EntityDetail> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEntity) throw new ConfigError('Knowledge graph bridge does not support entity seeding.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'graph.upsertEntity')
      const result = await kg.upsertEntity({ ...input, ...identity, accessScope: access } as UpsertGraphEntityInput)
      this.emitEvent('graph.entity.upsert' as typegraphEventType, result.id, { name: result.name }, telemetry)
      return result
    },

    upsertEntities: async (inputs: UpsertGraphEntityInput[], opts?: TypeGraphOptions | null): Promise<EntityDetail[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEntities) throw new ConfigError('Knowledge graph bridge does not support entity seeding.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'graph.upsertEntities')
      const results = await kg.upsertEntities(inputs.map(input => ({ ...input, ...identity, accessScope: access } as UpsertGraphEntityInput)))
      this.emitEvent('graph.entity.upsert' as typegraphEventType, undefined, { count: results.length }, telemetry)
      return results
    },

    resolveEntity: async (
      ref: GraphEntityRef | string,
      opts?: TypeGraphOptions | null,
    ): Promise<EntityDetail | null> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.resolveEntity) throw new ConfigError('Knowledge graph bridge does not support entity resolution.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.resolveEntity')
      return kg.resolveEntity(ref, identity)
    },

    linkExternalIds: async (
      entityId: string,
      externalIds: ExternalId[],
      opts?: TypeGraphOptions | null,
    ): Promise<EntityDetail> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.linkExternalIds) throw new ConfigError('Knowledge graph bridge does not support deterministic entity external IDs.')
      const { identity, telemetry } = this.resolvePublicOptions(opts, 'graph.linkExternalIds')
      const result = await kg.linkExternalIds(entityId, externalIds, identity)
      this.emitEvent('graph.entity.external_ids.link' as typegraphEventType, entityId, { count: externalIds.length }, telemetry)
      return result
    },

    mergeEntities: async (input: MergeGraphEntitiesInput, opts?: TypeGraphOptions | null): Promise<MergeGraphEntitiesResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.mergeEntities) throw new ConfigError('Knowledge graph bridge does not support entity merge operations.')
      const { telemetry } = this.resolvePublicOptions(opts, 'graph.mergeEntities')
      const result = await kg.mergeEntities(input)
      this.emitEvent('graph.entity.merge' as typegraphEventType, input.targetEntityId, {
        sourceEntityId: input.sourceEntityId,
        redirectedEdges: result.redirectedEdges,
        redirectedFacts: result.redirectedFacts,
      }, telemetry)
      return result
    },

    deleteEntity: async (entityId: string, opts?: (DeleteGraphEntityOpts & TypeGraphOptions) | null): Promise<DeleteGraphEntityResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.deleteEntity) throw new ConfigError('Knowledge graph bridge does not support entity delete operations.')
      const { telemetry } = this.resolvePublicOptions(opts, 'graph.deleteEntity')
      const normalizedOpts = optionalCompactObject<DeleteGraphEntityOpts>(opts, 'graph.deleteEntity') as DeleteGraphEntityOpts
      const result = await kg.deleteEntity(entityId, normalizedOpts)
      this.emitEvent('graph.entity.delete' as typegraphEventType, entityId, {
        mode: result.mode,
        deletedEdges: result.deletedEdges,
        deletedFacts: result.deletedFacts,
      }, telemetry)
      return result
    },

    upsertEdge: async (input: UpsertGraphEdgeInput, opts?: TypeGraphOptions | null): Promise<EdgeResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEdge) throw new ConfigError('Knowledge graph bridge does not support edge seeding.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'graph.upsertEdge')
      const result = await kg.upsertEdge({ ...input, ...identity, accessScope: access } as UpsertGraphEdgeInput)
      this.emitEvent('graph.edge.upsert' as typegraphEventType, result.id, { relation: result.relation }, telemetry)
      return result
    },

    upsertEdges: async (inputs: UpsertGraphEdgeInput[], opts?: TypeGraphOptions | null): Promise<EdgeResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertEdges) throw new ConfigError('Knowledge graph bridge does not support edge seeding.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'graph.upsertEdges')
      const results = await kg.upsertEdges(inputs.map(input => ({ ...input, ...identity, accessScope: access } as UpsertGraphEdgeInput)))
      this.emitEvent('graph.edge.upsert' as typegraphEventType, undefined, { count: results.length }, telemetry)
      return results
    },

    upsertFact: async (input: UpsertGraphFactInput, opts?: TypeGraphOptions | null): Promise<FactResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertFact) throw new ConfigError('Knowledge graph bridge does not support fact seeding.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'graph.upsertFact')
      const result = await kg.upsertFact({ ...input, ...identity, accessScope: access } as UpsertGraphFactInput)
      this.emitEvent('graph.fact.upsert' as typegraphEventType, result.id, { relation: result.relation }, telemetry)
      return result
    },

    upsertFacts: async (inputs: UpsertGraphFactInput[], opts?: TypeGraphOptions | null): Promise<FactResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.upsertFacts) throw new ConfigError('Knowledge graph bridge does not support fact seeding.')
      const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'graph.upsertFacts')
      const results = await kg.upsertFacts(inputs.map(input => ({ ...input, ...identity, accessScope: access } as UpsertGraphFactInput)))
      this.emitEvent('graph.fact.upsert' as typegraphEventType, undefined, { count: results.length }, telemetry)
      return results
    },

    searchEntities: async (query: string, opts?: ({
      limit?: number
      entityType?: string
      minConnections?: number
    } & TypeGraphOptions) | null): Promise<EntityResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.searchEntities) throw new ConfigError('Knowledge graph bridge does not support entity search.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.searchEntities')
      const normalizedOpts = optionalCompactObject<{
        limit?: number
        entityType?: string
        minConnections?: number
      } & TypeGraphOptions>(opts, 'graph.searchEntities') as {
        limit?: number
        entityType?: string
        minConnections?: number
      } & TypeGraphOptions
      let results = await kg.searchEntities(query, identity, normalizedOpts.limit)
      if (normalizedOpts.entityType) {
        results = results.filter(r => r.entityType === normalizedOpts.entityType)
      }
      if (normalizedOpts.minConnections !== undefined) {
        const minConnections = normalizedOpts.minConnections
        results = results.filter(r => r.edgeCount >= minConnections)
      }
      return results
    },

    getEntity: async (id: string, opts?: TypeGraphOptions | null): Promise<EntityDetail | null> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getEntity) throw new ConfigError('Knowledge graph bridge does not support entity lookup.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.getEntity')
      return kg.getEntity(id, identity)
    },

    getEdges: async (entityId: string, opts?: ({
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & TypeGraphOptions) | null): Promise<EdgeResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getEdges) throw new ConfigError('Knowledge graph bridge does not support edge queries.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.getEdges')
      const normalizedOpts = optionalCompactObject<{
        direction?: 'in' | 'out' | 'both'
        relation?: string
        limit?: number
      } & TypeGraphOptions>(opts, 'graph.getEdges') as {
        direction?: 'in' | 'out' | 'both'
        relation?: string
        limit?: number
      }
      return kg.getEdges(entityId, { ...normalizedOpts, ...identity })
    },

    searchFacts: async (query: string, opts?: (FactSearchOpts & TypeGraphOptions) | null): Promise<FactResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.searchFacts) throw new ConfigError('Knowledge graph bridge does not support fact search.')
      const { identity, telemetry } = this.resolvePublicOptions(opts, 'graph.searchFacts')
      const { context: _context, abortSignal: _abortSignal, ...normalizedOpts } = optionalCompactObject<FactSearchOpts & TypeGraphOptions>(
        opts,
        'graph.searchFacts',
      ) as FactSearchOpts & TypeGraphOptions
      return kg.searchFacts(query, { ...normalizedOpts, ...identity, ...telemetry })
    },

    explore: async (query: string, opts?: (GraphExploreOpts & TypeGraphOptions) | null): Promise<GraphExploreResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.explore) throw new ConfigError('Knowledge graph bridge does not support graph exploration.')
      const { identity } = this.resolvePublicOptions(opts as TypeGraphOptions | null | undefined, 'graph.explore')
      const { context: _context, abortSignal: _abortSignal, ...normalizedOpts } = optionalCompactObject<GraphExploreOpts & TypeGraphOptions>(
        opts,
        'graph.explore',
      ) as GraphExploreOpts & TypeGraphOptions
      return kg.explore(query, { ...normalizedOpts, ...identity } as GraphExploreOpts)
    },

    getChunksForEntity: async (entityId: string, opts?: ({
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & TypeGraphOptions) | null): Promise<ChunkResult[]> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getChunksForEntity) throw new ConfigError('Knowledge graph bridge does not support chunk lookup.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.getChunksForEntity')
      const normalizedOpts = optionalCompactObject<{
        bucketIds?: string[] | undefined
        limit?: number | undefined
      } & TypeGraphOptions>(opts, 'graph.getChunksForEntity') as {
        bucketIds?: string[] | undefined
        limit?: number | undefined
      }
      return kg.getChunksForEntity(entityId, { ...normalizedOpts, ...identity })
    },

    explainQuery: async (query: string, opts?: (GraphExplainOpts & TypeGraphOptions) | null): Promise<GraphSearchTrace> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.explainQuery) throw new ConfigError('Knowledge graph bridge does not support graph query explanations.')
      const { identity, telemetry } = this.resolvePublicOptions(opts, 'graph.explainQuery')
      const { context: _context, abortSignal: _abortSignal, ...normalizedOpts } = optionalCompactObject<GraphExplainOpts & TypeGraphOptions>(
        opts,
        'graph.explainQuery',
      ) as GraphExplainOpts & TypeGraphOptions
      return kg.explainQuery(query, { ...normalizedOpts, ...identity, ...telemetry })
    },

    backfill: async (opts?: (GraphBackfillOpts & TypeGraphOptions) | null): Promise<GraphBackfillResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.backfill) throw new ConfigError('Knowledge graph bridge does not support graph backfill.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.backfill')
      const { context: _context, abortSignal: _abortSignal, ...normalizedOpts } = optionalCompactObject<GraphBackfillOpts & TypeGraphOptions>(
        opts,
        'graph.backfill',
      ) as GraphBackfillOpts & TypeGraphOptions
      return kg.backfill(
        identity,
        normalizedOpts,
      )
    },

    getSubgraph: async (opts: SubgraphOpts): Promise<SubgraphResult> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getSubgraph) throw new ConfigError('Knowledge graph bridge does not support subgraph extraction.')
      return kg.getSubgraph(opts)
    },

    stats: async (opts?: TypeGraphOptions | null): Promise<GraphStats> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getGraphStats) throw new ConfigError('Knowledge graph bridge does not support stats.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.stats')
      return kg.getGraphStats(identity)
    },

    getRelationTypes: async (opts?: TypeGraphOptions | null): Promise<Array<{ relation: string; count: number }>> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getRelationTypes) throw new ConfigError('Knowledge graph bridge does not support relation type queries.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.getRelationTypes')
      return kg.getRelationTypes(identity)
    },

    getEntityTypes: async (opts?: TypeGraphOptions | null): Promise<Array<{ entityType: string; count: number }>> => {
      const kg = this.requireKnowledgeGraph()
      if (!kg.getEntityTypes) throw new ConfigError('Knowledge graph bridge does not support entity type queries.')
      const { identity } = this.resolvePublicOptions(opts, 'graph.getEntityTypes')
      return kg.getEntityTypes(identity)
    },
  }

  // ── Core Methods ──

  private resolvePublicOptions(opts: TypeGraphOptions | null | undefined, method: string): {
    identity: typegraphIdentity & { tenantId: string }
    readAccess: AccessScope
    access?: AccessScope | undefined
    telemetry: TelemetryOpts
  } {
    const optionBag = optionalCompactObject<TypeGraphOptions>(opts, method) as TypeGraphOptions
    assertNoLegacyPublicContextKeys(optionBag as object, method)
    const context = compactTypeGraphContext(optionBag.context, method)
    const identity = contextToIdentity(context, this.config.tenantId) as typegraphIdentity & { tenantId: string }
    const telemetry = contextTelemetry(context)
    return {
      identity,
      readAccess: identityAccessScope(identity),
      access: contextAccess(context),
      telemetry,
    }
  }

  private canRead(accessScope: AccessScope | null | undefined, identity: typegraphIdentity): boolean {
    const allowed = accessScope ?? []
    if (allowed.length === 0) return true
    const principals = new Set(identityAccessScope(identity).map(ref => `${ref.type}:${ref.id}`))
    return allowed.some(ref => principals.has(`${ref.type}:${ref.id}`))
  }

  private resolveDocumentIngestOptions(opts: DocumentIngestOptions | null | undefined, method: string): IngestOptions {
    const normalized = optionalCompactObject<DocumentIngestOptions>(opts, method) as DocumentIngestOptions
    const { identity, access, telemetry } = this.resolvePublicOptions(normalized, method)
    const { context: _context, abortSignal: _abortSignal, idempotencyKey: _idempotencyKey, ...ingestOpts } = normalized
    return {
      ...ingestOpts,
      tenantId: identity.tenantId,
      groupId: identity.groupId,
      userId: identity.userId,
      agentId: identity.agentId,
      threadId: identity.threadId,
      accessScope: access,
      traceId: telemetry.traceId,
      spanId: telemetry.spanId,
    }
  }

  private async ingestSingleEvent(input: EventInput, opts: EventIngestOptions): Promise<{ event: typegraphEventRecord; documents: IndexResult[] }> {
    this.assertConfigured()
    if (!this.adapter.upsertEvent) throw new ConfigError('Adapter does not support event operations.')
    const { identity, access, telemetry } = this.resolvePublicOptions(opts, 'event.ingest')
    const record = await this.adapter.upsertEvent({
      id: input.id ?? generateId('evt'),
      tenantId: identity.tenantId,
      groupId: identity.groupId,
      userId: identity.userId,
      agentId: identity.agentId,
      threadId: identity.threadId,
      name: input.name,
      description: input.description,
      occurredAt: input.occurredAt,
      participants: input.participants ?? [],
      content: input.content,
      metadata: input.metadata ?? {},
      accessScope: access,
    })

    const linkedDocuments: DocumentInput[] = input.documents?.map(document => ({
      ...document,
      id: document.id ?? generateId('doc'),
      metadata: {
        ...(document.metadata ?? {}),
        eventId: record.id,
      },
    })) ?? []
    if (opts.graphExtraction && input.content?.trim()) {
      linkedDocuments.push({
        id: `${record.id}:content`,
        name: `${input.name} content`,
        description: input.description,
        content: input.content,
        metadata: { eventId: record.id, eventContent: true },
      })
    }

    const documentResults: IndexResult[] = []
    if (linkedDocuments.length > 0) {
      const bucketId = opts.bucketId ?? DEFAULT_BUCKET_ID
      documentResults.push(await this.document.ingest(linkedDocuments, {
        ...(opts ?? {}),
        bucketId,
      }))
      if (this.adapter.upsertLink) {
        for (const document of linkedDocuments) {
          await this.adapter.upsertLink({
            tenantId: identity.tenantId,
            fromKind: 'event',
            fromId: record.id,
            toKind: 'document',
            toId: document.id!,
            relation: 'attached_document',
          })
        }
      }
    }

    if (this.adapter.upsertLink) {
      for (const participant of input.participants ?? []) {
        await this.adapter.upsertLink({
          tenantId: identity.tenantId,
          fromKind: 'event',
          fromId: record.id,
          toKind: 'entity',
          toId: `${participant.type}:${participant.id}`,
          relation: 'participant',
        })
      }
    }

    this.emitEvent('event.ingest', record.id, { name: record.name, participantCount: record.participants.length }, telemetry)
    return { event: record, documents: documentResults }
  }

  private applyConfig(config: typegraphConfig): void {
    this.config = config
    this.adapter = config.vectorStore!
    this.memoryBridgeInstance = undefined
    this.graphBridgeInstance = undefined

    // Resolve default providers
    this.defaultEmbedding = resolveEmbedder(config.embedding!)
    if (config.searchEmbedding) {
      this.defaultSearchEmbedding = resolveEmbedder(config.searchEmbedding)
    }

    // Build embedding registry — keyed by dimension-aware key "{model}:{dimensions}"
    this.embeddingRegistry.clear()
    this.embeddingRegistry.set(embeddingModelKey(this.defaultEmbedding), this.defaultEmbedding)
    if (this.defaultSearchEmbedding) {
      const qKey = embeddingModelKey(this.defaultSearchEmbedding)
      if (!this.embeddingRegistry.has(qKey)) {
        this.embeddingRegistry.set(qKey, this.defaultSearchEmbedding)
      }
    }
    if (config.additionalEmbeddings) {
      for (const embConfig of config.additionalEmbeddings) {
        const provider = resolveEmbedder(embConfig)
        const key = embeddingModelKey(provider)
        if (this.embeddingRegistry.has(key)) {
          throw new ConfigError(`Duplicate embedding "${key}" in additionalEmbeddings. Each model+dimensions combination must be unique.`)
        }
        this.embeddingRegistry.set(key, provider)
      }
    }

    if (config.llm && this.adapter.createMemoryStore) {
      const memoryStore = this.adapter.createMemoryStore({ embeddingDimensions: this.defaultEmbedding.dimensions })
      const graphConfig = {
        memoryStore,
        embedding: this.defaultEmbedding,
        scope: { tenantId: config.tenantId },
        explorationLlm: config.llm,
      }
      this.graphBridgeInstance = createKnowledgeGraphBridge(this.adapter.getTable
        ? { ...graphConfig, resolveChunksTable: this.adapter.getTable.bind(this.adapter) }
        : graphConfig)
      const memoryConfig = {
        memoryStore,
        embedding: this.defaultEmbedding,
        llm: config.llm,
        scope: { tenantId: config.tenantId },
      }
      this.memoryBridgeInstance = createMemoryBridge(config.eventSink
        ? { ...memoryConfig, eventSink: config.eventSink }
        : memoryConfig)
    }
  }

  /** Resolve a bucket's embedding + search embedding model strings to providers from the registry. */
  private resolveBucketEmbeddings(bucket: Bucket): void {
    // Resolve ingest embedding — bucket stores dimension-aware keys
    const ingestModel = bucket.embeddingModel ?? embeddingModelKey(this.defaultEmbedding)
    const ingestProvider = this.embeddingRegistry.get(ingestModel)
    if (!ingestProvider) {
      throw new ConfigError(
        `Bucket "${bucket.name}" uses embedding model "${ingestModel}" which was not provided in config. ` +
        `Register it via embedding, searchEmbedding, or additionalEmbeddings.`
      )
    }
    this.bucketEmbeddings.set(bucket.id, ingestProvider)

    // Resolve search embedding: explicit bucket override → default search embedding → ingest provider
    const queryModel = bucket.searchEmbeddingModel
    if (queryModel) {
      const queryProvider = this.embeddingRegistry.get(queryModel)
      if (!queryProvider) {
        throw new ConfigError(
          `Bucket "${bucket.name}" uses search embedding model "${queryModel}" which was not provided in config. ` +
          `Register it via embedding, searchEmbedding, or additionalEmbeddings.`
        )
      }
      this.bucketSearchEmbeddings.set(bucket.id, queryProvider)
    } else if (this.defaultSearchEmbedding) {
      this.bucketSearchEmbeddings.set(bucket.id, this.defaultSearchEmbedding)
    } else {
      this.bucketSearchEmbeddings.set(bucket.id, ingestProvider)
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
      searchEmbeddingModel: this.defaultSearchEmbedding ? embeddingModelKey(this.defaultSearchEmbedding) : undefined,
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
    if (this.defaultSearchEmbedding) {
      const queryModelKey = embeddingModelKey(this.defaultSearchEmbedding)
      if (queryModelKey !== defaultModelKey) {
        await this.adapter.ensureModel(queryModelKey, this.defaultSearchEmbedding.dimensions)
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
      this.bucketSearchEmbeddings.clear()
      this.bucketsLoaded = false
      this.configured = false
      this.initialized = false
    }
    return result
  }

  getEmbeddingForBucket(bucketId: string): Embedder {
    const embedding = this.bucketEmbeddings.get(bucketId)
    if (!embedding) throw new NotFoundError('Bucket', bucketId)
    return embedding
  }

  getSearchEmbeddingForBucket(bucketId: string): Embedder {
    return this.bucketSearchEmbeddings.get(bucketId) ?? this.getEmbeddingForBucket(bucketId)
  }

  private async resolveEmbeddingForBucket(bucketId: string): Promise<Embedder> {
    await this.ensureBucketsLoaded()
    const cached = this.bucketEmbeddings.get(bucketId)
    if (cached) return cached
    const bucket = await this.bucket.get(bucketId)
    if (!bucket) throw new NotFoundError('Bucket', bucketId)
    return this.bucketEmbeddings.get(bucketId) ?? this.defaultEmbedding
  }

  /**
   * Resolve per-call IngestOptions against bucket defaults.
   *
   * - Bucket-mergeable fields inherit from `bucket.indexDefaults` when unset on the call.
   * - Runtime-only fields (identity, batch behavior, tracing) pass through untouched.
   * - `graphExtraction` resolves to: per-call → bucket default → false. If the resolved
   *   value is true but the instance lacks an extractor/default LLM or knowledgeGraph, throws ConfigError.
   */
  private resolveIngestOptions(opts: IngestOptions, bucket: Bucket): IngestOptions {
    const defaults = bucket.indexDefaults
    const resolved: IngestOptions = defaults
      ? {
          ...opts,
          chunkSize: opts.chunkSize ?? defaults.chunkSize,
          chunkOverlap: opts.chunkOverlap ?? defaults.chunkOverlap,
          deduplicateBy: opts.deduplicateBy ?? defaults.deduplicateBy,
          stripMarkdownForEmbedding: opts.stripMarkdownForEmbedding ?? defaults.stripMarkdownForEmbedding,
          preprocessForEmbedding: opts.preprocessForEmbedding ?? defaults.preprocessForEmbedding,
          propagateMetadata: opts.propagateMetadata ?? defaults.propagateMetadata,
          graphExtraction: opts.graphExtraction ?? defaults.graphExtraction ?? false,
        }
      : { ...opts, graphExtraction: opts.graphExtraction ?? false }

    if (resolved.graphExtraction && ((!this.config.llm && !this.config.extractor) || !this.graphBridge)) {
      throw new ConfigError(
        'graphExtraction: true was requested (per-call or via bucket.indexDefaults) but this TypeGraph instance is not configured with `llm` or `extractor` and an adapter that can create the graph/memory store. Configure vectorStore + embedding + llm/extractor, or set graphExtraction: false.'
      )
    }
    return resolved
  }

  getDistinctEmbeddings(bucketIds?: string[]): Map<string, Embedder> {
    const map = new Map<string, Embedder>()
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

  private async ingestDocuments(documents: DocumentInput[], opts?: DocumentIngestOptions | null): Promise<IndexResult> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const normalizedOpts = this.resolveDocumentIngestOptions(opts, 'document.ingest')
    const resolvedBucketId = normalizedOpts.bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.bucket.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const resolvedOpts = this.resolveIngestOptions(normalizedOpts, bucket)
    const chunkSize = resolvedOpts.chunkSize ?? 512
    const chunkOverlap = resolvedOpts.chunkOverlap ?? 64
    const normalizedDocuments = documents.map(document => normalizeDocumentInput(document))
    const items = await Promise.all(normalizedDocuments.map(async document => ({ document, chunks: await defaultChunker(document, { chunkSize, chunkOverlap }) })))
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)
    this.logger?.info('Ingesting documents', { bucketId: resolvedBucketId, count: documents.length })
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

  private async ingestDocumentChunks(document: DocumentInput, chunks: Chunk[], opts?: DocumentIngestOptions | null): Promise<IndexResult> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const normalizedOpts = this.resolveDocumentIngestOptions(opts, 'document.ingestPreChunked')
    const resolvedBucketId = normalizedOpts.bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.bucket.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const resolvedOpts = this.resolveIngestOptions(normalizedOpts, bucket)
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)

    await this.config.hooks?.onIndexStart?.(resolvedBucketId, resolvedOpts)
    const result = await engine.ingestWithChunks(resolvedBucketId, normalizeDocumentInput(document), chunks, resolvedOpts)
    result.status = 'complete'
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    return result
  }

  async search(text: string, opts?: QueryOpts | null): Promise<QueryResponse> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const normalizedOpts = optionalCompactObject<QueryOpts>(opts, 'search') as QueryOpts
    const { identity } = this.resolvePublicOptions(normalizedOpts, 'search')
    await this.enforcePolicy('query', identity)

    if (normalizedOpts.buckets?.length) {
      const bucketIdsByName = new Map([...this._buckets.values()].map(bucket => [bucket.name, bucket.id]))
      normalizedOpts.buckets = normalizedOpts.buckets.map(identifier =>
        this._buckets.has(identifier) ? identifier : bucketIdsByName.get(identifier) ?? identifier
      )
    }

    // Batched lazy-load: if the caller names buckets we haven't seen, fetch them in one round-trip.
    // Avoids per-id gets in the hot path without forcing eager load at init.
    if (normalizedOpts.buckets?.length && this.adapter.getBuckets) {
      const missing = normalizedOpts.buckets.filter(id => !this._buckets.has(id))
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
      this.bucketSearchEmbeddings,
      this.memoryBridge,
      this.graphBridge,
      this.config.eventSink,
      this.logger,
      this.config.tenantId,
    )
    const response = await planner.execute(text, normalizedOpts)

    // Build LLM-ready prompt if requested.
    if (normalizedOpts.promptBuilder) {
      const built = buildPrompt(response.results, normalizedOpts.promptBuilder, this.config.tokenizer)
      response.prompt = built.prompt
      response.promptStats = built.stats
    }

    await this.config.hooks?.onQueryResults?.(text, response.results)
    return response
  }

  // ── Memory operations ──

  private get memoryBridge(): MemoryBridge | undefined {
    return this.memoryBridgeInstance
  }

  private get graphBridge(): KnowledgeGraphBridge | undefined {
    return this.graphBridgeInstance
  }

  private requireMemory(): MemoryBridge {
    const bridge = this.memoryBridge
    if (!bridge) {
      throw new ConfigError('Memory not configured. Pass vectorStore + embedding + llm using an adapter that supports memory stores.')
    }
    return bridge
  }

  private requireKnowledgeGraph(): KnowledgeGraphBridge {
    const bridge = this.graphBridge
    if (!bridge) {
      throw new ConfigError('Knowledge graph not configured. Pass vectorStore + embedding + llm using an adapter that supports graph storage.')
    }
    return bridge
  }

  async remember(content: string, opts?: RememberOpts | null): Promise<MemoryRecord> {
    const { identity } = this.resolvePublicOptions(opts, 'remember')
    await this.enforcePolicy('memory.write', identity)
    return this.requireMemory().remember(content, opts)
  }

  async forget(id: string, opts?: ForgetOpts | null): Promise<void> {
    const { identity } = this.resolvePublicOptions(opts, 'forget')
    await this.enforcePolicy('memory.delete', identity, id)
    return this.requireMemory().forget(id, opts)
  }

  async correct(correction: string, opts?: CorrectOpts | null): Promise<{ invalidated: number; created: number; summary: string }> {
    return this.requireMemory().correct(correction, opts)
  }

  async recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  async recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  async recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[] | string> {
    const { identity } = this.resolvePublicOptions(opts, 'recall')
    await this.enforcePolicy('memory.read', identity)
    if (opts?.format) {
      return this.requireMemory().recall(query, opts as RecallOpts & { format: 'xml' | 'markdown' | 'plain' })
    }
    return this.requireMemory().recall(query, opts)
  }

  async healthCheck(opts?: HealthCheckOpts | null): Promise<MemoryHealthReport> {
    const mem = this.requireMemory()
    if (!mem.healthCheck) throw new ConfigError('healthCheck not supported by this memory bridge.')
    return mem.healthCheck(opts)
  }

  async addThreadTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts?: AddThreadTurnOpts | null,
  ): Promise<ThreadTurnResult> {
    const { identity } = this.resolvePublicOptions(opts, 'addThreadTurn')
    await this.enforcePolicy('memory.write', identity)
    const result = await this.requireMemory().addThreadTurn(messages, opts)

    // The bridge returns the underlying ExtractionResult cast to ThreadTurnResult;
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

  policy = {
    create: async (input: CreatePolicyInput, opts?: TelemetryOpts | null): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.createPolicy(input)
      this.emitEvent('policy.create', policy.id, { name: policy.name, policyType: policy.policyType }, optionalCompactObject<TelemetryOpts>(opts, 'policy.create') as TelemetryOpts)
      return policy
    },

    get: async (id: string): Promise<Policy | null> => {
      const store = this.requirePolicyStore()
      return store.getPolicy(id)
    },

    list: async (filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean } | null): Promise<Policy[]> => {
      const store = this.requirePolicyStore()
      return store.listPolicies(optionalCompactObject<{ tenantId?: string; policyType?: PolicyType; enabled?: boolean }>(filter, 'policy.list', 'filter'))
    },

    update: async (id: string, input: UpdatePolicyInput, opts?: TelemetryOpts | null): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.updatePolicy(id, input)
      this.emitEvent('policy.update', policy.id, { name: policy.name }, optionalCompactObject<TelemetryOpts>(opts, 'policy.update') as TelemetryOpts)
      return policy
    },

    delete: async (id: string, opts?: TelemetryOpts | null): Promise<void> => {
      const store = this.requirePolicyStore()
      await store.deletePolicy(id)
      this.emitEvent('policy.delete', id, {}, optionalCompactObject<TelemetryOpts>(opts, 'policy.delete') as TelemetryOpts)
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

  private createIndexEngine(embedding: Embedder): IndexEngine {
    const kg = this.graphBridge
    const engine = new IndexEngine(
      this.adapter,
      embedding,
      this.config.eventSink,
      this.logger,
      kg,
      this.config.extractionCoreferenceCache,
    )
    if (this.config.extractor && kg) {
      engine.useExtractor(this.config.extractor)
    } else if (this.config.llm && kg) {
      const mainLlm = resolveLLMProvider(this.config.llm)
      engine.tripleExtractor = new DefaultGraphExtractor({
        llm: mainLlm,
        graph: kg,
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
