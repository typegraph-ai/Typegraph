import type { d8umInstance, d8umConfig, BucketsApi, JobsApi, DocumentJobsApi, UndeployResult } from '@d8um/core'
import type { Bucket, CreateBucketInput, IndexConfig } from '@d8um/core'
import type { Job, CreateJobInput, JobRunResult } from '@d8um/core'
import type { DocumentJobRelation, DocumentJobRelationType } from '@d8um/core'
import type { QueryOpts, QueryResponse, AssembleOpts, d8umResult } from '@d8um/core'
import type { IndexOpts, IndexResult } from '@d8um/core'
import type { EmbeddingProvider } from '@d8um/core'
import type { RawDocument, Chunk, Connector } from '@d8um/core'
import type { d8umDocument, DocumentFilter } from '@d8um/core'
import type { ContextSearchOpts, ContextSearchResponse } from '@d8um/core'
import { assemble as assembleResults } from '@d8um/core'
import type { HostedConfig } from './types.js'
import { HttpClient } from './http-client.js'

/**
 * Extended d8um instance for hosted mode.
 * Includes full CRUD for buckets, jobs, and documents.
 */
export interface d8umHostedInstance extends d8umInstance {
  // Document CRUD
  listDocuments(filter?: DocumentFilter): Promise<d8umDocument[]>
  getDocument(documentId: string): Promise<d8umDocument>
  updateDocument(documentId: string, update: Partial<d8umDocument>): Promise<d8umDocument>
  deleteDocuments(filter: DocumentFilter): Promise<number>
}

/**
 * Create a d8um instance backed by the hosted SaaS service.
 * Everything runs server-side - embedding, indexing, storage, connectors.
 * Just pass an API key.
 */
export function d8umHosted(config: HostedConfig): d8umHostedInstance {
  const client = new HttpClient(config)

  const buckets: BucketsApi = {
    async create(input: CreateBucketInput): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async get(bucketId: string): Promise<Bucket | undefined> {
      return client.get<Bucket>(`/v1/buckets/${encodeURIComponent(bucketId)}`)
    },
    async list(tenantId?: string): Promise<Bucket[]> {
      const params = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''
      return client.get<Bucket[]>(`/v1/buckets${params}`)
    },
    async update(bucketId: string, input): Promise<Bucket> {
      return client.patch<Bucket>(`/v1/buckets/${encodeURIComponent(bucketId)}`, input)
    },
    async delete(bucketId: string): Promise<void> {
      await client.delete(`/v1/buckets/${encodeURIComponent(bucketId)}`)
    },
  }

  const jobs: JobsApi = {
    async create(input: CreateJobInput): Promise<Job> {
      return client.post<Job>('/v1/jobs', input)
    },
    async get(jobId: string): Promise<Job | undefined> {
      return client.get<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`)
    },
    async list(filter?): Promise<Job[]> {
      const params = new URLSearchParams()
      if (filter?.bucketId) params.set('bucketId', filter.bucketId)
      if (filter?.type) params.set('type', filter.type)
      if (filter?.tenantId) params.set('tenantId', filter.tenantId)
      const qs = params.toString()
      return client.get<Job[]>(`/v1/jobs${qs ? `?${qs}` : ''}`)
    },
    async update(jobId: string, input): Promise<Job> {
      return client.patch<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`, input)
    },
    async delete(jobId: string, opts?): Promise<void> {
      await client.delete(`/v1/jobs/${encodeURIComponent(jobId)}`, opts)
    },
    async run(jobId: string): Promise<JobRunResult> {
      return client.post<JobRunResult>(`/v1/jobs/${encodeURIComponent(jobId)}/run`)
    },
    async pause(jobId: string): Promise<void> {
      await client.post(`/v1/jobs/${encodeURIComponent(jobId)}/pause`)
    },
    async resume(jobId: string): Promise<void> {
      await client.post(`/v1/jobs/${encodeURIComponent(jobId)}/resume`)
    },
  }

  const documentJobs: DocumentJobsApi = {
    async getJobsForDocument(documentId: string): Promise<DocumentJobRelation[]> {
      return client.get<DocumentJobRelation[]>(`/v1/document-jobs?documentId=${encodeURIComponent(documentId)}`)
    },
    async getDocumentsForJob(jobId: string): Promise<DocumentJobRelation[]> {
      return client.get<DocumentJobRelation[]>(`/v1/document-jobs?jobId=${encodeURIComponent(jobId)}`)
    },
    async addRelation(documentId: string, jobId: string, relation: DocumentJobRelationType): Promise<void> {
      await client.post('/v1/document-jobs', { documentId, jobId, relation })
    },
  }

  return {
    // --- d8umInstance methods ---

    async deploy(_config: d8umConfig): Promise<d8umHostedInstance> {
      // Infrastructure is managed server-side in hosted mode
      return this as d8umHostedInstance
    },

    async initialize(_config: d8umConfig): Promise<d8umHostedInstance> {
      return this as d8umHostedInstance
    },

    async undeploy(): Promise<UndeployResult> {
      return { success: false, message: 'undeploy() is not available in hosted mode — infrastructure is managed server-side.' }
    },

    buckets,
    jobs,
    documentJobs,

    getEmbeddingForBucket(_bucketId: string): EmbeddingProvider {
      throw new Error('getEmbeddingForBucket() is not available in hosted mode - embedding is managed server-side')
    },

    getDistinctEmbeddings(): Map<string, EmbeddingProvider> {
      throw new Error('getDistinctEmbeddings() is not available in hosted mode - embedding is managed server-side')
    },

    groupBucketsByModel(): Map<string, string[]> {
      throw new Error('groupBucketsByModel() is not available in hosted mode - embedding is managed server-side')
    },

    async indexWithConnector(
      bucketId: string,
      _connector: Connector,
      _indexConfig: IndexConfig,
      opts?: IndexOpts,
    ): Promise<IndexResult> {
      return client.post<IndexResult>(`/v1/buckets/${encodeURIComponent(bucketId)}/index`, opts)
    },

    async query(text: string, opts?: QueryOpts): Promise<QueryResponse> {
      return client.post<QueryResponse>('/v1/query', { text, ...opts })
    },

    async searchWithContext(text: string, opts?: ContextSearchOpts): Promise<ContextSearchResponse> {
      return client.post<ContextSearchResponse>('/v1/search-with-context', { text, ...opts })
    },

    async ingest(
      bucketId: string,
      docs: RawDocument[],
      _indexConfig: IndexConfig,
      opts?: IndexOpts
    ): Promise<IndexResult> {
      return client.post<IndexResult>(
        `/v1/buckets/${encodeURIComponent(bucketId)}/ingest`,
        { docs, ...opts }
      )
    },

    async ingestWithChunks(
      bucketId: string,
      doc: RawDocument,
      chunks: Chunk[],
      opts?: IndexOpts
    ): Promise<IndexResult> {
      return client.post<IndexResult>(
        `/v1/buckets/${encodeURIComponent(bucketId)}/ingest`,
        { doc, chunks, ...opts }
      )
    },

    assemble(results: d8umResult[], opts?: AssembleOpts): string {
      return assembleResults(results, opts)
    },

    async remember(content: string, identity: Record<string, unknown>, category?: string): Promise<unknown> {
      return client.post('/v1/memory/remember', { content, identity, category })
    },

    async forget(id: string): Promise<void> {
      await client.post('/v1/memory/forget', { id })
    },

    async correct(correction: string, identity: Record<string, unknown>): Promise<{ invalidated: number; created: number; summary: string }> {
      return client.post('/v1/memory/correct', { correction, identity })
    },

    async addConversationTurn(
      messages: Array<{ role: string; content: string; timestamp?: Date }>,
      identity: Record<string, unknown>,
      sessionId?: string,
    ): Promise<unknown> {
      return client.post('/v1/memory/conversation', { messages, identity, sessionId })
    },

    async destroy(): Promise<void> {
      // No-op in hosted mode
    },

    // --- Document CRUD ---

    async listDocuments(filter?: DocumentFilter): Promise<d8umDocument[]> {
      return client.post<d8umDocument[]>('/v1/documents/list', filter)
    },

    async getDocument(documentId: string): Promise<d8umDocument> {
      return client.get<d8umDocument>(`/v1/documents/${encodeURIComponent(documentId)}`)
    },

    async updateDocument(documentId: string, update: Partial<d8umDocument>): Promise<d8umDocument> {
      return client.patch<d8umDocument>(`/v1/documents/${encodeURIComponent(documentId)}`, update)
    },

    async deleteDocuments(filter: DocumentFilter): Promise<number> {
      return client.delete<number>('/v1/documents', filter)
    },
  }
}
