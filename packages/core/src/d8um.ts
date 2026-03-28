import type { VectorStoreAdapter, UndeployResult } from './types/adapter.js'
import type { Bucket, CreateBucketInput, EmbeddingInput, IndexConfig } from './types/bucket.js'
import type {
  Job,
  CreateJobInput,
  JobRunContext,
  JobRunResult,
  JobRun,
  JobTypeDefinition,
  ApiClient,
} from './types/job.js'
import type {
  DocumentJobRelation,
  DocumentJobRelationType,
  DocumentJobRelationFilter,
} from './types/document-job-relation.js'
import type { QueryOpts, QueryResponse, d8umResult, AssembleOpts } from './types/query.js'
import type { IndexOpts, IndexResult } from './types/index-types.js'
import type { EmbeddingProvider } from './embedding/provider.js'
import type { RawDocument, Chunk, Connector } from './types/connector.js'
import type { d8umHooks } from './types/hooks.js'
import type { LLMProvider } from './types/llm-provider.js'
import type { GraphBridge } from './types/graph-bridge.js'
import type { d8umIdentity } from './types/identity.js'
import type { ContextSearchOpts, ContextSearchResponse } from './query/context-search.js'
import type { AISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/ai-sdk-adapter.js'
import { aiSdkLlmProvider, isAISDKLLMInput } from './llm/ai-sdk-adapter.js'
import { IndexEngine } from './index-engine/engine.js'
import { TripleExtractor } from './index-engine/triple-extractor.js'
import { searchWithContext as searchWithContextFn } from './query/context-search.js'
import { assemble as assembleResults } from './query/assemble.js'
import { getJobType, registerJobType } from './jobs/registry.js'
import { randomUUID } from 'crypto'

/** Union type: pass a native LLMProvider or an AI SDK model wrapped as { model }. */
export type LLMInput = LLMProvider | AISDKLLMInput

export interface d8umConfig {
  vectorStore: VectorStoreAdapter
  embedding: EmbeddingInput
  tenantId?: string | undefined
  tokenizer?: ((text: string) => number) | undefined
  hooks?: d8umHooks | undefined
  /** Integration definitions whose jobs[] will be auto-registered on initialize(). */
  integrations?: { jobs: JobTypeDefinition[] }[] | undefined
  /** Additional job type definitions to register on initialize(). */
  jobTypes?: JobTypeDefinition[] | undefined
  /** Optional LLM provider for triple extraction, query classification, and memory operations. */
  llm?: LLMInput | undefined
  /** Optional graph bridge for memory operations and neural query mode. */
  graph?: GraphBridge | undefined
}

function isEmbeddingProvider(
  value: EmbeddingInput
): value is EmbeddingProvider {
  return 'embed' in value && 'embedBatch' in value && 'dimensions' in value
}

export function resolveEmbeddingProvider(config: EmbeddingInput): EmbeddingProvider {
  if (isEmbeddingProvider(config)) return config
  if (isAISDKEmbeddingInput(config)) return aiSdkEmbeddingProvider(config)

  throw new Error('Invalid embedding configuration')
}

function isLLMProvider(value: LLMInput): value is LLMProvider {
  return 'generateText' in value && 'generateJSON' in value
}

export function resolveLLMProvider(config: LLMInput): LLMProvider {
  if (isLLMProvider(config)) return config
  if (isAISDKLLMInput(config)) return aiSdkLlmProvider(config)

  throw new Error('Invalid LLM configuration')
}

// ── Buckets Sub-API ──

export interface BucketsApi {
  create(input: CreateBucketInput): Promise<Bucket>
  get(bucketId: string): Promise<Bucket | undefined>
  list(tenantId?: string): Promise<Bucket[]>
  update(bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status'>>): Promise<Bucket>
  delete(bucketId: string): Promise<void>
}

// ── Jobs Sub-API ──

export interface JobsApi {
  create(input: CreateJobInput): Promise<Job>
  get(jobId: string): Promise<Job | undefined>
  list(filter?: { bucketId?: string; type?: string; tenantId?: string }): Promise<Job[]>
  update(jobId: string, input: Partial<Pick<Job, 'name' | 'description' | 'config' | 'schedule' | 'status'>>): Promise<Job>
  /** Delete a job. cascade=true deletes orphaned documents (those with no other job relations). */
  delete(jobId: string, opts?: { cascade?: boolean }): Promise<void>
  run(jobId: string): Promise<JobRunResult>
  pause(jobId: string): Promise<void>
  resume(jobId: string): Promise<void>
}

// ── Document-Job Relations Sub-API ──

export interface DocumentJobsApi {
  getJobsForDocument(documentId: string): Promise<DocumentJobRelation[]>
  getDocumentsForJob(jobId: string): Promise<DocumentJobRelation[]>
  addRelation(documentId: string, jobId: string, relation: DocumentJobRelationType): Promise<void>
}

/** The d8um instance interface — all public methods. */
export interface d8umInstance {
  /** One-off infrastructure provisioning. Creates all tables/extensions. Idempotent. */
  deploy(config: d8umConfig): Promise<this>

  /** Lightweight runtime init. Registers jobs, loads state. No DDL. */
  initialize(config: d8umConfig): Promise<this>

  /** Remove all d8um infrastructure. Refuses if any table contains data. */
  undeploy(): Promise<UndeployResult>

  buckets: BucketsApi
  jobs: JobsApi
  documentJobs: DocumentJobsApi

  getEmbeddingForBucket(bucketId: string): EmbeddingProvider
  getDistinctEmbeddings(bucketIds?: string[]): Map<string, EmbeddingProvider>
  groupBucketsByModel(bucketIds?: string[]): Map<string, string[]>

  /** Index documents from a connector into a bucket. */
  indexWithConnector(
    bucketId: string,
    connector: Connector,
    indexConfig: IndexConfig,
    opts?: IndexOpts,
  ): Promise<IndexResult>

  /** Ingest documents directly into a bucket. All chunks are embedded in a single batch call. */
  ingest(bucketId: string, docs: RawDocument[], indexConfig: IndexConfig, opts?: IndexOpts): Promise<IndexResult>

  /** Ingest a document with pre-chunked content. */
  ingestWithChunks(bucketId: string, doc: RawDocument, chunks: Chunk[], opts?: IndexOpts): Promise<IndexResult>

  /** Search across buckets. */
  query(text: string, opts?: QueryOpts): Promise<QueryResponse>
  searchWithContext(text: string, opts?: ContextSearchOpts): Promise<ContextSearchResponse>
  assemble(results: d8umResult[], opts?: AssembleOpts): string

  // ── Memory operations (require graph bridge) ──

  /** Store a memory. LLM extracts triples → entity graph + memory record. */
  remember(content: string, identity: d8umIdentity, category?: string): Promise<unknown>
  /** Invalidate a memory and its associated graph edges. */
  forget(id: string): Promise<void>
  /** Apply a natural language correction. */
  correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }>
  /** Ingest a conversation turn with extraction. */
  addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: d8umIdentity,
    sessionId?: string,
  ): Promise<unknown>

  destroy(): Promise<void>
}

class d8umImpl implements d8umInstance {
  private _buckets = new Map<string, Bucket>()
  private _jobs = new Map<string, Job>()
  private _documentJobRelations: DocumentJobRelation[] = []
  private bucketEmbeddings = new Map<string, EmbeddingProvider>()
  private adapter!: VectorStoreAdapter
  private defaultEmbedding!: EmbeddingProvider
  private config!: d8umConfig
  private configured = false
  private initialized = false

  // ── Buckets ──

  buckets: BucketsApi = {
    create: async (input: CreateBucketInput): Promise<Bucket> => {
      this.assertConfigured()
      const bucket: Bucket = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        status: 'active',
        tenantId: input.tenantId ?? this.config.tenantId,
      }
      if (this.adapter.upsertBucket) {
        const persisted = await this.adapter.upsertBucket(bucket)
        this._buckets.set(persisted.id, persisted)
        this.bucketEmbeddings.set(persisted.id, this.defaultEmbedding)
        return persisted
      }
      this._buckets.set(bucket.id, bucket)
      this.bucketEmbeddings.set(bucket.id, this.defaultEmbedding)
      return bucket
    },

    get: async (bucketId: string): Promise<Bucket | undefined> => {
      if (this.adapter.getBucket) {
        return (await this.adapter.getBucket(bucketId)) ?? undefined
      }
      return this._buckets.get(bucketId)
    },

    list: async (tenantId?: string): Promise<Bucket[]> => {
      if (this.adapter.listBuckets) {
        return this.adapter.listBuckets(tenantId)
      }
      const all = [...this._buckets.values()]
      if (tenantId) return all.filter(s => s.tenantId === tenantId)
      return all
    },

    update: async (bucketId: string, input: Partial<Pick<Bucket, 'name' | 'description' | 'status'>>): Promise<Bucket> => {
      const bucket = await this.buckets.get(bucketId)
      if (!bucket) throw new Error(`Bucket "${bucketId}" not found`)
      if (input.name !== undefined) bucket.name = input.name
      if (input.description !== undefined) bucket.description = input.description
      if (input.status !== undefined) bucket.status = input.status
      if (this.adapter.upsertBucket) {
        return this.adapter.upsertBucket(bucket)
      }
      this._buckets.set(bucket.id, bucket)
      return bucket
    },

    delete: async (bucketId: string): Promise<void> => {
      // Delete bucket, cascade to jobs targeting it, and clean up relations
      const jobs = await this.jobs.list({ bucketId })
      for (const job of jobs) {
        await this.jobs.delete(job.id, { cascade: true })
      }
      if (this.adapter.deleteBucket) {
        await this.adapter.deleteBucket(bucketId)
      } else {
        this._buckets.delete(bucketId)
      }
      this.bucketEmbeddings.delete(bucketId)
    },
  }

  // ── Jobs ──

  jobs: JobsApi = {
    create: async (input: CreateJobInput): Promise<Job> => {
      this.assertConfigured()

      // Validate bucket exists if required
      const bucket = input.bucketId ? await this.buckets.get(input.bucketId) : undefined
      if (input.bucketId && !bucket) {
        throw new Error(`Bucket "${input.bucketId}" not found`)
      }

      // Validate job type exists and check bucket requirement
      const jobType = getJobType(input.type)
      if (jobType?.requiresBucket && !input.bucketId) {
        throw new Error(`Job type "${input.type}" requires a bucketId`)
      }

      const now = new Date()
      const job: Job = {
        id: randomUUID(),
        tenantId: input.tenantId ?? this.config.tenantId,
        bucketId: input.bucketId,
        type: input.type,
        name: input.name,
        description: input.description,
        config: input.config ?? {},
        schedule: input.schedule,
        status: input.schedule ? 'scheduled' : 'idle',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      }
      if (this.adapter.upsertJob) {
        return this.adapter.upsertJob(job)
      }
      this._jobs.set(job.id, job)
      return job
    },

    get: async (jobId: string): Promise<Job | undefined> => {
      if (this.adapter.getJob) {
        return (await this.adapter.getJob(jobId)) ?? undefined
      }
      return this._jobs.get(jobId)
    },

    list: async (filter?: { bucketId?: string; type?: string; tenantId?: string }): Promise<Job[]> => {
      if (this.adapter.listJobs) {
        return this.adapter.listJobs(filter)
      }
      let jobs = [...this._jobs.values()]
      if (filter?.bucketId) jobs = jobs.filter(j => j.bucketId === filter.bucketId)
      if (filter?.type) jobs = jobs.filter(j => j.type === filter.type)
      if (filter?.tenantId) jobs = jobs.filter(j => j.tenantId === filter.tenantId)
      return jobs
    },

    update: async (jobId: string, input: Partial<Pick<Job, 'name' | 'description' | 'config' | 'schedule' | 'status'>>): Promise<Job> => {
      const job = await this.jobs.get(jobId)
      if (!job) throw new Error(`Job "${jobId}" not found`)
      if (input.name !== undefined) job.name = input.name
      if (input.description !== undefined) job.description = input.description
      if (input.config !== undefined) job.config = input.config
      if (input.schedule !== undefined) job.schedule = input.schedule
      if (input.status !== undefined) job.status = input.status
      job.updatedAt = new Date()
      if (this.adapter.upsertJob) {
        return this.adapter.upsertJob(job)
      }
      this._jobs.set(job.id, job)
      return job
    },

    delete: async (jobId: string, opts?: { cascade?: boolean }): Promise<void> => {
      const job = await this.jobs.get(jobId)
      if (!job) return

      if (opts?.cascade) {
        if (this.adapter.getOrphanedDocumentIds) {
          const orphanedIds = await this.adapter.getOrphanedDocumentIds(jobId)
          if (orphanedIds.length > 0 && this.adapter.deleteDocuments) {
            await this.adapter.deleteDocuments({ documentIds: orphanedIds })
          }
        } else {
          // Fallback: in-memory cascade check
          const jobRelations = this._documentJobRelations.filter(r => r.jobId === jobId)
          const orphanedIds: string[] = []
          for (const rel of jobRelations) {
            const otherRelations = this._documentJobRelations.filter(
              r => r.documentId === rel.documentId && r.jobId !== jobId
            )
            if (otherRelations.length === 0) {
              orphanedIds.push(rel.documentId)
            }
          }
          if (orphanedIds.length > 0 && this.adapter.deleteDocuments) {
            await this.adapter.deleteDocuments({ documentIds: orphanedIds })
          }
        }
      }

      // Remove relations
      if (this.adapter.deleteDocumentJobRelations) {
        await this.adapter.deleteDocumentJobRelations({ jobId })
      } else {
        this._documentJobRelations = this._documentJobRelations.filter(r => r.jobId !== jobId)
      }

      if (this.adapter.deleteJob) {
        await this.adapter.deleteJob(jobId)
      } else {
        this._jobs.delete(jobId)
      }
    },

    run: async (jobId: string): Promise<JobRunResult> => {
      const job = await this.jobs.get(jobId)
      if (!job) throw new Error(`Job "${jobId}" not found`)

      const startMs = Date.now()
      job.status = 'running'
      job.updatedAt = new Date()
      if (this.adapter.upsertJob) await this.adapter.upsertJob(job)

      const jobType = getJobType(job.type)

      // Create a persistent job run record
      const jobRun: JobRun = {
        id: randomUUID(),
        jobId: job.id,
        bucketId: job.bucketId,
        status: 'running',
        documentsCreated: 0,
        documentsUpdated: 0,
        documentsDeleted: 0,
        startedAt: new Date(),
      }
      if (this.adapter.createJobRun) await this.adapter.createJobRun(jobRun)

      // Build context with emit callback for ingestion jobs
      let documentsEmitted = 0
      const ctx: JobRunContext = {
        job,
        lastRunAt: job.lastRunAt,
        metadata: job.config,
        emit: () => { documentsEmitted++ },
      }

      try {
        let result: JobRunResult

        if (jobType?.run) {
          result = await jobType.run(ctx)
        } else {
          result = {
            jobId: job.id,
            bucketId: job.bucketId,
            status: 'completed',
            summary: 'No run() defined for this job type',
            documentsCreated: 0,
            documentsUpdated: 0,
            documentsDeleted: 0,
            durationMs: Date.now() - startMs,
          }
        }

        if (result.status === 'failed') {
          throw new Error(result.error ?? result.summary ?? 'Job failed')
        }

        job.status = 'completed'
        job.lastRunAt = new Date()
        job.runCount++
        job.updatedAt = new Date()
        if (this.adapter.upsertJob) await this.adapter.upsertJob(job)

        const finalResult = { ...result, durationMs: Date.now() - startMs }

        // Persist completed run
        if (this.adapter.updateJobRun) {
          await this.adapter.updateJobRun(jobRun.id, {
            status: 'completed',
            summary: finalResult.summary,
            documentsCreated: finalResult.documentsCreated,
            documentsUpdated: finalResult.documentsUpdated,
            documentsDeleted: finalResult.documentsDeleted,
            metrics: finalResult.metrics,
            durationMs: finalResult.durationMs,
            completedAt: new Date(),
          })
        }

        return finalResult
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        job.status = 'failed'
        job.lastError = errorMsg
        job.updatedAt = new Date()
        if (this.adapter.upsertJob) await this.adapter.upsertJob(job)

        // Persist failed run
        if (this.adapter.updateJobRun) {
          await this.adapter.updateJobRun(jobRun.id, {
            status: 'failed',
            error: errorMsg,
            durationMs: Date.now() - startMs,
            completedAt: new Date(),
          })
        }

        return {
          jobId: job.id,
          bucketId: job.bucketId,
          status: 'failed',
          documentsCreated: 0,
          documentsUpdated: 0,
          documentsDeleted: 0,
          durationMs: Date.now() - startMs,
          error: errorMsg,
        }
      }
    },

    pause: async (jobId: string): Promise<void> => {
      const job = await this.jobs.get(jobId)
      if (!job) throw new Error(`Job "${jobId}" not found`)
      job.status = 'idle'
      job.nextRunAt = undefined
      job.updatedAt = new Date()
      if (this.adapter.upsertJob) await this.adapter.upsertJob(job)
      else this._jobs.set(job.id, job)
    },

    resume: async (jobId: string): Promise<void> => {
      const job = await this.jobs.get(jobId)
      if (!job) throw new Error(`Job "${jobId}" not found`)
      if (job.schedule) {
        job.status = 'scheduled'
      } else {
        job.status = 'idle'
      }
      job.updatedAt = new Date()
      if (this.adapter.upsertJob) await this.adapter.upsertJob(job)
      else this._jobs.set(job.id, job)
    },
  }

  // ── Document-Job Relations ──

  documentJobs: DocumentJobsApi = {
    getJobsForDocument: async (documentId: string): Promise<DocumentJobRelation[]> => {
      if (this.adapter.getDocumentJobRelations) {
        return this.adapter.getDocumentJobRelations({ documentId })
      }
      return this._documentJobRelations.filter(r => r.documentId === documentId)
    },

    getDocumentsForJob: async (jobId: string): Promise<DocumentJobRelation[]> => {
      if (this.adapter.getDocumentJobRelations) {
        return this.adapter.getDocumentJobRelations({ jobId })
      }
      return this._documentJobRelations.filter(r => r.jobId === jobId)
    },

    addRelation: async (documentId: string, jobId: string, relation: DocumentJobRelationType): Promise<void> => {
      const newRelation: DocumentJobRelation = { documentId, jobId, relation, timestamp: new Date() }
      if (this.adapter.upsertDocumentJobRelation) {
        await this.adapter.upsertDocumentJobRelation(newRelation)
        return
      }
      // Fallback: in-memory with dedup
      const exists = this._documentJobRelations.some(
        r => r.documentId === documentId && r.jobId === jobId && r.relation === relation
      )
      if (!exists) {
        this._documentJobRelations.push(newRelation)
      }
    },
  }

  // ── Core Methods ──

  private applyConfig(config: d8umConfig): void {
    this.config = config
    this.adapter = config.vectorStore
    this.defaultEmbedding = resolveEmbeddingProvider(config.embedding)

    // Register job types from integrations and config
    if (config.integrations) {
      for (const integration of config.integrations) {
        for (const job of integration.jobs) {
          registerJobType(job)
        }
      }
    }
    if (config.jobTypes) {
      for (const jobType of config.jobTypes) {
        registerJobType(jobType)
      }
    }
  }

  async deploy(config: d8umConfig): Promise<this> {
    this.applyConfig(config)
    await this.adapter.deploy()
    this.configured = true
    return this
  }

  async initialize(config: d8umConfig): Promise<this> {
    this.applyConfig(config)

    // Lightweight connect — load model registrations, no DDL
    await this.adapter.connect()

    // Hydrate in-memory state from persistent storage (for adapters that support it)
    if (this.adapter.listBuckets) {
      const allBuckets = await this.adapter.listBuckets()
      for (const s of allBuckets) {
        this._buckets.set(s.id, s)
        this.bucketEmbeddings.set(s.id, this.defaultEmbedding)
      }
    }
    if (this.adapter.listJobs) {
      const jobs = await this.adapter.listJobs()
      for (const j of jobs) {
        this._jobs.set(j.id, j)
      }

      // Warn about orphaned job types (persisted jobs whose types aren't registered)
      for (const job of jobs) {
        const jobType = getJobType(job.type)
        if (!jobType) {
          console.warn(
            `⚠️ Job "${job.name}" (id: ${job.id}) references unregistered type "${job.type}". ` +
            `Running this job will fail. Either add the integration that provides this type ` +
            `to your initialize() config, or delete the orphaned job.`
          )
        }
      }
    }
    if (this.adapter.getDocumentJobRelations) {
      this._documentJobRelations = await this.adapter.getDocumentJobRelations({})
    }

    this.configured = true
    this.initialized = true
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
      this._jobs.clear()
      this._documentJobRelations = []
      this.bucketEmbeddings.clear()
      this.configured = false
      this.initialized = false
    }
    return result
  }

  getEmbeddingForBucket(bucketId: string): EmbeddingProvider {
    const embedding = this.bucketEmbeddings.get(bucketId)
    if (!embedding) throw new Error(`Bucket "${bucketId}" not found`)
    return embedding
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

  async indexWithConnector(
    bucketId: string,
    connector: Connector,
    indexConfig: IndexConfig,
    opts?: IndexOpts,
  ): Promise<IndexResult> {
    await this.ensureInitialized()
    const bucket = await this.buckets.get(bucketId)
    if (!bucket) throw new Error(`Bucket "${bucketId}" not found`)

    const embedding = this.getEmbeddingForBucket(bucketId)
    const engine = this.createIndexEngine(embedding)

    await this.config.hooks?.onIndexStart?.(bucketId, opts ?? {})
    const result = await engine.indexWithConnector(bucketId, connector, indexConfig, opts)
    await this.config.hooks?.onIndexComplete?.(bucketId, result)
    return result
  }

  async ingest(
    bucketId: string,
    docs: RawDocument[],
    indexConfig: IndexConfig,
    opts?: IndexOpts
  ): Promise<IndexResult> {
    await this.ensureInitialized()
    const bucket = await this.buckets.get(bucketId)
    if (!bucket) throw new Error(`Bucket "${bucketId}" not found`)
    const { defaultChunker: chunker } = await import('./index-engine/chunker.js')
    const items = docs.map(doc => ({ doc, chunks: chunker(doc, indexConfig) }))
    const embedding = this.getEmbeddingForBucket(bucketId)
    const engine = this.createIndexEngine(embedding)
    await this.config.hooks?.onIndexStart?.(bucketId, opts ?? {})
    const result = await engine.ingestBatch(bucketId, items, opts, indexConfig)
    await this.config.hooks?.onIndexComplete?.(bucketId, result)
    return result
  }

  async ingestWithChunks(
    bucketId: string,
    doc: RawDocument,
    chunks: Chunk[],
    opts?: IndexOpts
  ): Promise<IndexResult> {
    await this.ensureInitialized()
    const bucket = await this.buckets.get(bucketId)
    if (!bucket) throw new Error(`Bucket "${bucketId}" not found`)
    const embedding = this.getEmbeddingForBucket(bucketId)
    const engine = this.createIndexEngine(embedding)

    await this.config.hooks?.onIndexStart?.(bucketId, opts ?? {})
    const result = await engine.ingestWithChunks(bucketId, doc, chunks, opts)
    await this.config.hooks?.onIndexComplete?.(bucketId, result)
    return result
  }

  async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
    await this.ensureInitialized()
    const { QueryPlanner } = await import('./query/planner.js')
    const planner = new QueryPlanner(
      this.adapter,
      [...this._buckets.keys()],
      this.bucketEmbeddings,
      this.config.graph,
    )
    const response = await planner.execute(text, {
      ...opts,
      tenantId: opts?.tenantId ?? this.config.tenantId,
    })
    await this.config.hooks?.onQueryResults?.(text, response.results)
    return response
  }

  async searchWithContext(text: string, opts: ContextSearchOpts = {}): Promise<ContextSearchResponse> {
    await this.ensureInitialized()
    const response = await searchWithContextFn(
      this.adapter,
      [...this._buckets.keys()],
      this.bucketEmbeddings,
      text,
      { ...opts, tenantId: opts.tenantId ?? this.config.tenantId }
    )
    await this.config.hooks?.onQueryResults?.(text, response.rawResults)
    return response
  }

  assemble(results: d8umResult[], opts?: AssembleOpts): string {
    return assembleResults(results, opts)
  }

  // ── Memory operations ──

  private requireGraph(): GraphBridge {
    if (!this.config.graph) {
      throw new Error('Graph not configured. Pass a graph bridge to d8umConfig to enable memory operations.')
    }
    return this.config.graph
  }

  async remember(content: string, identity: d8umIdentity, category?: string): Promise<unknown> {
    return this.requireGraph().remember(content, identity, category)
  }

  async forget(id: string): Promise<void> {
    return this.requireGraph().forget(id)
  }

  async correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }> {
    return this.requireGraph().correct(correction, identity)
  }

  async addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: d8umIdentity,
    sessionId?: string,
  ): Promise<unknown> {
    return this.requireGraph().addConversationTurn(messages, identity, sessionId)
  }

  async destroy(): Promise<void> {
    await this.adapter?.destroy?.()
  }

  private createIndexEngine(embedding: EmbeddingProvider): IndexEngine {
    const engine = new IndexEngine(this.adapter, embedding)
    if (this.config.llm && this.config.graph) {
      const llm = resolveLLMProvider(this.config.llm)
      engine.tripleExtractor = new TripleExtractor({ llm, graph: this.config.graph })
    }
    return engine
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('d8um not initialized. Call d8um.initialize({ vectorStore, embedding }) first.')
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.configured || !this.initialized) {
      throw new Error('d8um not initialized. Call await d8um.initialize({ vectorStore, embedding }) first.')
    }
  }
}

/** Deploy infrastructure then initialize a new d8um instance. Convenience for local/dev use. */
export async function d8umCreate(config: d8umConfig): Promise<d8umInstance> {
  const instance = new d8umImpl()
  await instance.deploy(config)
  return instance.initialize(config)
}

/** Deploy infrastructure only. Returns an instance that is NOT initialized for runtime use. */
export async function d8umDeploy(config: d8umConfig): Promise<d8umInstance> {
  return new d8umImpl().deploy(config)
}

/** Global singleton d8um instance. Call await d8um.deploy() then d8um.initialize() before use. */
export const d8um: d8umInstance = new d8umImpl()
