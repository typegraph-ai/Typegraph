import type { VectorStoreAdapter, UndeployResult } from './types/adapter.js'
import type { Bucket, CreateBucketInput, BucketListFilter, EmbeddingConfig, IndexConfig } from './types/bucket.js'
import type { QueryOpts, QueryResponse, typegraphResult } from './types/query.js'
import type { IndexOpts, IndexResult } from './types/index-types.js'
import type { EmbeddingProvider } from './embedding/provider.js'
import type { RawDocument, Chunk } from './types/connector.js'
import type { typegraphDocument, DocumentFilter, UpsertDocumentInput } from './types/typegraph-document.js'
import type { typegraphHooks } from './types/hooks.js'
import type { LLMProvider } from './types/llm-provider.js'
import type {
  GraphBridge, EntityResult, EntityDetail, EdgeResult,
  SubgraphOpts, SubgraphResult, GraphStats,
} from './types/graph-bridge.js'
import type { ExtractionConfig } from './types/extraction-config.js'
import type { typegraphIdentity } from './types/identity.js'
import type { typegraphEventSink, typegraphEventType } from './types/events.js'
import type { PolicyStoreAdapter, CreatePolicyInput, UpdatePolicyInput, Policy, PolicyType, PolicyAction } from './types/policy.js'
import type { MemoryRecord, ConversationTurnResult, MemoryHealthReport } from './types/memory.js'
import type { typegraphLogger } from './types/logger.js'
import type { Job, JobFilter } from './types/job.js'
import type { PaginationOpts, PaginatedResult } from './types/pagination.js'
import { PolicyEngine, PolicyViolationError } from './governance/policy-engine.js'
import type { AISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { aiSdkLlmProvider, isAISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { IndexEngine } from './index-engine/engine.js'
import { TripleExtractor } from './index-engine/triple-extractor.js'
import { NotFoundError, NotInitializedError, ConfigError } from './types/errors.js'
import { generateId } from './utils/id.js'

// ── Default Bucket ──

export const DEFAULT_BUCKET_ID = 'bkt_default'
export const DEFAULT_BUCKET_NAME = 'Default'
export const DEFAULT_BUCKET_DESCRIPTION = 'System default bucket. All ingested documents without an explicit bucket assignment are stored here. Cannot be deleted.'

/** Union type: pass a native LLMProvider or an AI SDK model wrapped as { model }. */
export type LLMConfig = LLMProvider | AISDKLLMInput
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
  /** Optional graph bridge for memory operations and neural query mode. */
  graph?: GraphBridge | undefined
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
  if (isAISDKLLMInput(config)) return aiSdkLlmProvider(config)

  throw new ConfigError('Invalid LLM configuration. Pass an LLMProvider ({ generateText, generateJSON }) or an AI SDK language model ({ model }).')
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
  if (config.graph && !config.llm) {
    config.logger?.warn('Graph bridge configured without an LLM. Triple extraction during ingestion will be skipped. Pass llm to typegraphConfig for full graph functionality.')
  }
}

// ── Sub-API Interfaces ──

export interface BucketsApi {
  create(input: CreateBucketInput): Promise<Bucket>
  get(bucketId: string): Promise<Bucket | undefined>
  list(filter?: BucketListFilter, pagination?: PaginationOpts): Promise<Bucket[] | PaginatedResult<Bucket>>
  update(bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>): Promise<Bucket>
  delete(bucketId: string): Promise<void>
}

export interface DocumentsApi {
  get(id: string): Promise<typegraphDocument | null>
  list(filter?: DocumentFilter, pagination?: PaginationOpts): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>>
  update(id: string, input: Partial<Pick<typegraphDocument, 'title' | 'url' | 'visibility' | 'documentType' | 'sourceType' | 'metadata'>>): Promise<typegraphDocument>
  delete(filter: DocumentFilter): Promise<number>
}

export interface JobsApi {
  get(id: string): Promise<Job | null>
  list(filter?: JobFilter): Promise<Job[]>
}

export interface GraphApi {
  searchEntities(query: string, identity: typegraphIdentity, opts?: {
    limit?: number
    entityType?: string
    minConnections?: number
  }): Promise<EntityResult[]>
  getEntity(id: string): Promise<EntityDetail | null>
  getEdges(entityId: string, opts?: {
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  }): Promise<EdgeResult[]>
  getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult>
  stats(identity: typegraphIdentity): Promise<GraphStats>
  getRelationTypes(identity: typegraphIdentity): Promise<Array<{ relation: string; count: number }>>
  getEntityTypes(identity: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>>
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
  ingest(docs: RawDocument[], indexConfig: IndexConfig, opts?: IndexOpts): Promise<IndexResult>

  /** Ingest a document with pre-chunked content. Target bucket set via opts.bucketId. */
  ingestPreChunked(doc: RawDocument, chunks: Chunk[], opts?: IndexOpts): Promise<IndexResult>

  /** Search across buckets. Optionally format results via opts.format. */
  query(text: string, opts?: QueryOpts): Promise<QueryResponse>

  // ── Memory operations (require graph bridge) ──

  /** Store a memory. LLM extracts triples → entity graph + memory record. */
  remember(content: string, identity: typegraphIdentity, category?: string, opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord>
  /** Invalidate a memory and its associated graph edges. Identity must match the memory owner. */
  forget(id: string, identity: typegraphIdentity): Promise<void>
  /** Apply a natural language correction. */
  correct(correction: string, identity: typegraphIdentity): Promise<{ invalidated: number; created: number; summary: string }>
  /** Search memories by semantic similarity. */
  recall(query: string, identity: typegraphIdentity, opts?: { limit?: number; types?: string[] }): Promise<MemoryRecord[]>
  /** Build a formatted memory context block for LLM system prompts. */
  buildMemoryContext(query: string, identity: typegraphIdentity, opts?: {
    includeWorking?: boolean
    includeFacts?: boolean
    includeEpisodes?: boolean
    includeProcedures?: boolean
    maxMemoryTokens?: number
    format?: 'xml' | 'markdown' | 'plain'
  }): Promise<string>
  /** Check memory system health — returns stats about stored memories, entities, and edges. */
  healthCheck(identity: typegraphIdentity): Promise<MemoryHealthReport>
  /** Ingest a conversation turn with extraction. */
  addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: typegraphIdentity,
    conversationId?: string,
  ): Promise<ConversationTurnResult>

  // ── Policy operations (require policyStore) ──

  policies: {
    create(input: CreatePolicyInput): Promise<Policy>
    get(id: string): Promise<Policy | null>
    list(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]>
    update(id: string, input: UpdatePolicyInput): Promise<Policy>
    delete(id: string): Promise<void>
  }

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

  private emitEvent(eventType: typegraphEventType, targetId?: string, payload: Record<string, unknown> = {}): void {
    if (!this.config?.eventSink) return
    this.config.eventSink.emit({
      id: crypto.randomUUID(),
      eventType,
      identity: { tenantId: this.config.tenantId },
      targetId,
      payload,
      timestamp: new Date(),
    })
  }

  // ── Buckets ──

  buckets: BucketsApi = {
    create: async (input: CreateBucketInput): Promise<Bucket> => {
      this.assertConfigured()
      const embeddingModel = input.embeddingModel ?? this.defaultEmbedding.model
      const queryEmbeddingModel = input.queryEmbeddingModel ?? this.defaultQueryEmbedding?.model

      // Validate model strings exist in registry
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
      }
      if (this.adapter.upsertBucket) {
        const persisted = await this.adapter.upsertBucket(bucket)
        this._buckets.set(persisted.id, persisted)
        this.resolveBucketEmbeddings(persisted)
        this.emitEvent('bucket.create', persisted.id, { name: persisted.name })
        return persisted
      }
      this._buckets.set(bucket.id, bucket)
      this.resolveBucketEmbeddings(bucket)
      this.emitEvent('bucket.create', bucket.id, { name: bucket.name })
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

    update: async (bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status' | 'indexDefaults'>>): Promise<Bucket> => {
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
      this.emitEvent('bucket.update', result.id, { name: result.name })
      return result
    },

    delete: async (bucketId: string): Promise<void> => {
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
      this.emitEvent('bucket.delete', bucketId)
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

    update: async (id: string, input: Partial<Pick<typegraphDocument, 'title' | 'url' | 'visibility' | 'documentType' | 'sourceType' | 'metadata'>>): Promise<typegraphDocument> => {
      this.assertConfigured()
      if (!this.adapter.updateDocument) {
        throw new ConfigError('Adapter does not support document update operations.')
      }
      const updated = await this.adapter.updateDocument(id, input)
      this.emitEvent('document.update', id, { fields: Object.keys(input) })
      return updated
    },

    delete: async (filter: DocumentFilter): Promise<number> => {
      this.assertConfigured()
      if (!this.adapter.deleteDocuments) {
        throw new ConfigError('Adapter does not support document operations.')
      }
      await this.enforcePolicy('document.delete', { tenantId: filter.tenantId ?? this.config.tenantId })
      const count = await this.adapter.deleteDocuments(filter)
      if (count > 0) {
        this.emitEvent('document.delete', undefined, { count, filter })
      }
      return count
    },
  }

  // ── Jobs ──

  jobs: JobsApi = {
    get: async (_id: string): Promise<Job | null> => {
      this.assertConfigured()
      // Jobs are primarily a cloud-mode feature. Self-hosted returns null.
      return null
    },
    list: async (_filter?: JobFilter): Promise<Job[]> => {
      this.assertConfigured()
      return []
    },
  }

  // ── Graph Exploration ──

  graph: GraphApi = {
    searchEntities: async (query: string, identity: typegraphIdentity, opts?: {
      limit?: number
      entityType?: string
      minConnections?: number
    }): Promise<EntityResult[]> => {
      const graph = this.requireGraph()
      if (!graph.searchEntities) throw new ConfigError('Graph bridge does not support entity search.')
      const results = await graph.searchEntities(query, identity, opts?.limit)
      // The bridge returns a simpler format; enrich it
      return results.map(r => ({
        ...r,
        aliases: [],
        edgeCount: 0,
        ...r,
      }))
    },

    getEntity: async (id: string): Promise<EntityDetail | null> => {
      const graph = this.requireGraph()
      if (!graph.getEntity) throw new ConfigError('Graph bridge does not support entity lookup.')
      return graph.getEntity(id)
    },

    getEdges: async (entityId: string, opts?: {
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    }): Promise<EdgeResult[]> => {
      const graph = this.requireGraph()
      if (!graph.getEdges) throw new ConfigError('Graph bridge does not support edge queries.')
      return graph.getEdges(entityId, opts)
    },

    getSubgraph: async (opts: SubgraphOpts): Promise<SubgraphResult> => {
      const graph = this.requireGraph()
      if (!graph.getSubgraph) throw new ConfigError('Graph bridge does not support subgraph extraction.')
      return graph.getSubgraph(opts)
    },

    stats: async (identity: typegraphIdentity): Promise<GraphStats> => {
      const graph = this.requireGraph()
      if (!graph.getGraphStats) throw new ConfigError('Graph bridge does not support stats.')
      return graph.getGraphStats(identity)
    },

    getRelationTypes: async (identity: typegraphIdentity): Promise<Array<{ relation: string; count: number }>> => {
      const graph = this.requireGraph()
      if (!graph.getRelationTypes) throw new ConfigError('Graph bridge does not support relation type queries.')
      return graph.getRelationTypes(identity)
    },

    getEntityTypes: async (identity: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>> => {
      const graph = this.requireGraph()
      if (!graph.getEntityTypes) throw new ConfigError('Graph bridge does not support entity type queries.')
      return graph.getEntityTypes(identity)
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

    // Build embedding registry — keyed by model string
    this.embeddingRegistry.clear()
    this.embeddingRegistry.set(this.defaultEmbedding.model, this.defaultEmbedding)
    if (this.defaultQueryEmbedding) {
      if (this.embeddingRegistry.has(this.defaultQueryEmbedding.model)) {
        // Same model string is fine (user might provide same model as both default + query)
      } else {
        this.embeddingRegistry.set(this.defaultQueryEmbedding.model, this.defaultQueryEmbedding)
      }
    }
    if (config.additionalEmbeddings) {
      for (const embConfig of config.additionalEmbeddings) {
        const provider = resolveEmbeddingProvider(embConfig)
        if (this.embeddingRegistry.has(provider.model)) {
          throw new ConfigError(`Duplicate embedding model "${provider.model}" in additionalEmbeddings. Each model string must be unique.`)
        }
        this.embeddingRegistry.set(provider.model, provider)
      }
    }
  }

  /** Resolve a bucket's embedding + query embedding model strings to providers from the registry. */
  private resolveBucketEmbeddings(bucket: Bucket): void {
    // Resolve ingest embedding
    const ingestModel = bucket.embeddingModel ?? this.defaultEmbedding.model
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
    if (config.graph?.deploy) {
      await config.graph.deploy()
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
      embeddingModel: this.defaultEmbedding.model,
      queryEmbeddingModel: this.defaultQueryEmbedding?.model,
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

    // Bucket loading and ensureModel deferred to first use via ensureBucketsLoaded()
    // for faster cold starts. ensureModel() also runs in IndexEngine before each ingest.

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

  /** Merge bucket-level index defaults into per-call IndexConfig. Per-call values win. */
  private mergeIndexConfig(config: IndexConfig, bucket: Bucket): IndexConfig {
    const defaults = bucket.indexDefaults
    if (!defaults) return config
    return {
      ...config,
      chunkSize: config.chunkSize ?? defaults.chunkSize ?? config.chunkSize,
      chunkOverlap: config.chunkOverlap ?? defaults.chunkOverlap ?? config.chunkOverlap,
      deduplicateBy: config.deduplicateBy ?? defaults.deduplicateBy,
      visibility: config.visibility ?? defaults.visibility,
      stripMarkdownForEmbedding: config.stripMarkdownForEmbedding ?? defaults.stripMarkdownForEmbedding,
      propagateMetadata: config.propagateMetadata ?? defaults.propagateMetadata,
    }
  }

  getDistinctEmbeddings(bucketIds?: string[]): Map<string, EmbeddingProvider> {
    const map = new Map<string, EmbeddingProvider>()
    const ids = bucketIds ?? [...this._buckets.keys()]
    for (const id of ids) {
      const emb = this.bucketEmbeddings.get(id)
      if (emb) map.set(emb.model, emb)
    }
    return map
  }

  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    const ids = bucketIds ?? [...this._buckets.keys()]
    for (const id of ids) {
      const emb = this.bucketEmbeddings.get(id)
      if (!emb) continue
      const group = groups.get(emb.model) ?? []
      group.push(id)
      groups.set(emb.model, group)
    }
    return groups
  }

  async ingest(docs: RawDocument[], indexConfig: IndexConfig, opts: IndexOpts = {}): Promise<IndexResult> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const resolvedBucketId = opts.bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.buckets.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const merged = this.mergeIndexConfig(indexConfig, bucket)
    const { defaultChunker: chunker } = await import('./index-engine/chunker.js')
    const items = docs.map(doc => ({ doc, chunks: chunker(doc, merged) }))
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)
    this.logger?.info('Ingesting documents', { bucketId: resolvedBucketId, count: docs.length })
    await this.config.hooks?.onIndexStart?.(resolvedBucketId, opts)
    const result = await engine.ingestBatch(resolvedBucketId, items, opts, merged)
    result.status = 'complete'
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    this.logger?.info('Ingestion complete', { bucketId: resolvedBucketId, inserted: result.inserted, skipped: result.skipped, durationMs: result.durationMs })
    return result
  }

  async ingestPreChunked(doc: RawDocument, chunks: Chunk[], opts: IndexOpts = {}): Promise<IndexResult> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    const resolvedBucketId = opts.bucketId || DEFAULT_BUCKET_ID
    await this.enforcePolicy('index', { tenantId: this.config.tenantId }, resolvedBucketId)
    const bucket = await this.buckets.get(resolvedBucketId)
    if (!bucket) throw new NotFoundError('Bucket', resolvedBucketId)
    const embedding = await this.resolveEmbeddingForBucket(resolvedBucketId)
    const engine = this.createIndexEngine(embedding)

    await this.config.hooks?.onIndexStart?.(resolvedBucketId, opts)
    const result = await engine.ingestWithChunks(resolvedBucketId, doc, chunks, opts)
    result.status = 'complete'
    await this.config.hooks?.onIndexComplete?.(resolvedBucketId, result)
    return result
  }

  async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
    await this.ensureInitialized()
    await this.ensureBucketsLoaded()
    await this.enforcePolicy('query', { tenantId: opts?.tenantId ?? this.config.tenantId })
    const { QueryPlanner } = await import('./query/planner.js')
    const planner = new QueryPlanner(
      this.adapter,
      [...this._buckets.keys()],
      this.bucketEmbeddings,
      this.bucketQueryEmbeddings,
      this.config.graph,
      this.config.eventSink,
      this.logger,
    )
    const response = await planner.execute(text, {
      ...opts,
      tenantId: opts?.tenantId ?? this.config.tenantId,
    })

    // Format results if requested
    if (opts?.format) {
      const { assemble } = await import('./query/assemble.js')
      const resultsToFormat = opts.maxTokens
        ? trimToTokenBudget(response.results, opts.maxTokens, this.config.tokenizer)
        : response.results
      response.context = typeof opts.format === 'function'
        ? opts.format(resultsToFormat)
        : assemble(resultsToFormat, { format: opts.format })
    }

    await this.config.hooks?.onQueryResults?.(text, response.results)
    return response
  }

  // ── Memory operations ──

  private requireGraph(): GraphBridge {
    if (!this.config.graph) {
      throw new ConfigError('Graph not configured. Pass a graph bridge to typegraphConfig to enable memory and graph operations.')
    }
    return this.config.graph
  }

  async remember(content: string, identity: typegraphIdentity, category?: string, opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
    await this.enforcePolicy('memory.write', identity)
    return this.requireGraph().remember(content, identity, category, opts)
  }

  async forget(id: string, identity: typegraphIdentity): Promise<void> {
    await this.enforcePolicy('memory.delete', identity, id)
    return this.requireGraph().forget(id, identity)
  }

  async correct(correction: string, identity: typegraphIdentity): Promise<{ invalidated: number; created: number; summary: string }> {
    return this.requireGraph().correct(correction, identity)
  }

  async recall(query: string, identity: typegraphIdentity, opts?: { limit?: number; types?: string[] }): Promise<MemoryRecord[]> {
    await this.enforcePolicy('memory.read', identity)
    return this.requireGraph().recall(query, identity, opts)
  }

  async buildMemoryContext(query: string, identity: typegraphIdentity, opts?: {
    includeWorking?: boolean
    includeFacts?: boolean
    includeEpisodes?: boolean
    includeProcedures?: boolean
    maxMemoryTokens?: number
    format?: 'xml' | 'markdown' | 'plain'
  }): Promise<string> {
    const graph = this.requireGraph()
    if (!graph.buildMemoryContext) throw new ConfigError('buildMemoryContext not supported by this graph bridge.')
    return graph.buildMemoryContext(query, identity, opts)
  }

  async healthCheck(identity: typegraphIdentity): Promise<MemoryHealthReport> {
    const graph = this.requireGraph()
    if (!graph.healthCheck) throw new ConfigError('healthCheck not supported by this graph bridge.')
    return graph.healthCheck(identity)
  }

  async addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: typegraphIdentity,
    conversationId?: string,
  ): Promise<ConversationTurnResult> {
    return this.requireGraph().addConversationTurn(messages, identity, conversationId)
  }

  // ── Policy operations ──

  private requirePolicyStore(): PolicyStoreAdapter {
    if (!this.config.policyStore) {
      throw new ConfigError('Policy store not configured. Pass a policyStore to typegraphConfig to enable policy operations.')
    }
    return this.config.policyStore
  }

  policies = {
    create: async (input: CreatePolicyInput): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.createPolicy(input)
      this.emitEvent('policy.create', policy.id, { name: policy.name, policyType: policy.policyType })
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

    update: async (id: string, input: UpdatePolicyInput): Promise<Policy> => {
      const store = this.requirePolicyStore()
      const policy = await store.updatePolicy(id, input)
      this.emitEvent('policy.update', policy.id, { name: policy.name })
      return policy
    },

    delete: async (id: string): Promise<void> => {
      const store = this.requirePolicyStore()
      await store.deletePolicy(id)
      this.emitEvent('policy.delete', id)
    },
  }

  async destroy(): Promise<void> {
    await this.adapter?.destroy?.()
  }

  private createIndexEngine(embedding: EmbeddingProvider): IndexEngine {
    const engine = new IndexEngine(this.adapter, embedding, this.config.eventSink)
    if (this.config.llm && this.config.graph) {
      const mainLlm = resolveLLMProvider(this.config.llm)
      const ext = this.config.extraction
      engine.tripleExtractor = new TripleExtractor({
        llm: ext?.entityLlm ?? mainLlm,
        relationshipLlm: ext?.relationshipLlm,
        graph: this.config.graph,
        twoPass: ext?.twoPass ?? false,
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

/** Trim results to fit within a token budget, keeping highest-scored results first. */
function trimToTokenBudget(
  results: typegraphResult[],
  maxTokens: number,
  tokenizer?: (text: string) => number
): typegraphResult[] {
  const countTokens = tokenizer ?? ((text: string) => Math.ceil(text.split(/\s+/).length * 1.3))
  const trimmed: typegraphResult[] = []
  let budget = maxTokens
  for (const r of results) {
    const tokens = countTokens(r.content)
    if (budget - tokens < 0 && trimmed.length > 0) break
    trimmed.push(r)
    budget -= tokens
  }
  return trimmed
}

/**
 * Runtime initialization. No DDL. Returns a ready-to-use instance.
 * - **Cloud mode**: pass `{ apiKey }` — everything runs server-side.
 * - **Self-hosted mode**: pass `{ vectorStore, embedding }`.
 */
export async function typegraphInit(config: typegraphConfig): Promise<typegraphInstance> {
  if (config.apiKey) {
    const { createCloudInstance } = await import('./cloud/cloud-instance.js')
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
