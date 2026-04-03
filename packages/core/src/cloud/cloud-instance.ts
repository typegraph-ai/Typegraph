import type { d8umInstance, d8umConfig, BucketsApi, JobsApi, DocumentJobsApi } from '../d8um.js'
import type { Bucket, CreateBucketInput, IndexConfig } from '../types/bucket.js'
import type { Job, CreateJobInput, JobRunResult } from '../types/job.js'
import type { DocumentJobRelation, DocumentJobRelationType } from '../types/document-job-relation.js'
import type { QueryOpts, QueryResponse, d8umResult, AssembleOpts } from '../types/query.js'
import type { IndexOpts, IndexResult } from '../types/index-types.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { RawDocument, Chunk } from '../types/connector.js'
import type { d8umDocument, DocumentFilter } from '../types/d8um-document.js'
import type { d8umIdentity } from '../types/identity.js'
import type { ContextSearchOpts, ContextSearchResponse } from '../query/context-search.js'
import type { UndeployResult } from '../types/adapter.js'
import { assemble as assembleResults } from '../query/assemble.js'
import { HttpClient } from './http-client.js'
import type { CloudConfig } from './http-client.js'

/**
 * Extended d8um instance for cloud mode.
 * Includes document CRUD methods available via the hosted API.
 */
export interface d8umCloudInstance extends d8umInstance {
  listDocuments(filter?: DocumentFilter): Promise<d8umDocument[]>
  getDocument(documentId: string): Promise<d8umDocument>
  updateDocument(documentId: string, update: Partial<d8umDocument>): Promise<d8umDocument>
  deleteDocuments(filter: DocumentFilter): Promise<number>
}

/**
 * Create a d8um instance backed by the hosted cloud service.
 * Everything runs server-side — embedding, indexing, storage, memory.
 */
export function createCloudInstance(config: CloudConfig): d8umCloudInstance {
  const client = new HttpClient(config)
  const e = encodeURIComponent

  const buckets: BucketsApi = {
    async create(input: CreateBucketInput): Promise<Bucket> {
      return client.post<Bucket>('/v1/buckets', input)
    },
    async get(bucketId: string): Promise<Bucket | undefined> {
      return client.get<Bucket>(`/v1/buckets/${e(bucketId)}`)
    },
    async list(tenantId?: string): Promise<Bucket[]> {
      const params = tenantId ? `?tenantId=${e(tenantId)}` : ''
      return client.get<Bucket[]>(`/v1/buckets${params}`)
    },
    async update(bucketId: string, input): Promise<Bucket> {
      return client.patch<Bucket>(`/v1/buckets/${e(bucketId)}`, input)
    },
    async delete(bucketId: string): Promise<void> {
      await client.delete(`/v1/buckets/${e(bucketId)}`)
    },
  }

  const jobs: JobsApi = {
    async create(input: CreateJobInput): Promise<Job> {
      return client.post<Job>('/v1/jobs', input)
    },
    async get(jobId: string): Promise<Job | undefined> {
      return client.get<Job>(`/v1/jobs/${e(jobId)}`)
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
      return client.patch<Job>(`/v1/jobs/${e(jobId)}`, input)
    },
    async delete(jobId: string, opts?): Promise<void> {
      await client.delete(`/v1/jobs/${e(jobId)}`, opts)
    },
    async run(jobId: string): Promise<JobRunResult> {
      return client.post<JobRunResult>(`/v1/jobs/${e(jobId)}/run`)
    },
    async pause(jobId: string): Promise<void> {
      await client.post(`/v1/jobs/${e(jobId)}/pause`)
    },
    async resume(jobId: string): Promise<void> {
      await client.post(`/v1/jobs/${e(jobId)}/resume`)
    },
  }

  const documentJobs: DocumentJobsApi = {
    async getJobsForDocument(documentId: string): Promise<DocumentJobRelation[]> {
      return client.get<DocumentJobRelation[]>(`/v1/document-jobs?documentId=${e(documentId)}`)
    },
    async getDocumentsForJob(jobId: string): Promise<DocumentJobRelation[]> {
      return client.get<DocumentJobRelation[]>(`/v1/document-jobs?jobId=${e(jobId)}`)
    },
    async addRelation(documentId: string, jobId: string, relation: DocumentJobRelationType): Promise<void> {
      await client.post('/v1/document-jobs', { documentId, jobId, relation })
    },
  }

  const instance: d8umCloudInstance = {
    async deploy(_config: d8umConfig): Promise<d8umCloudInstance> {
      return instance
    },

    async initialize(_config: d8umConfig): Promise<d8umCloudInstance> {
      return instance
    },

    async undeploy(): Promise<UndeployResult> {
      return { success: false, message: 'undeploy() is not available in cloud mode — infrastructure is managed server-side.' }
    },

    buckets,
    jobs,
    documentJobs,

    getEmbeddingForBucket(_bucketId: string): EmbeddingProvider {
      throw new Error('getEmbeddingForBucket() is not available in cloud mode — embedding is managed server-side.')
    },

    getDistinctEmbeddings(): Map<string, EmbeddingProvider> {
      throw new Error('getDistinctEmbeddings() is not available in cloud mode — embedding is managed server-side.')
    },

    groupBucketsByModel(): Map<string, string[]> {
      throw new Error('groupBucketsByModel() is not available in cloud mode — embedding is managed server-side.')
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
      opts?: IndexOpts,
    ): Promise<IndexResult> {
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/ingest`, { docs, ...opts })
    },

    async ingestWithChunks(
      bucketId: string,
      doc: RawDocument,
      chunks: Chunk[],
      opts?: IndexOpts,
    ): Promise<IndexResult> {
      return client.post<IndexResult>(`/v1/buckets/${e(bucketId)}/ingest`, { doc, chunks, ...opts })
    },

    assemble(results: d8umResult[], opts?: AssembleOpts): string {
      return assembleResults(results, opts)
    },

    async remember(content: string, identity: d8umIdentity, category?: string): Promise<unknown> {
      return client.post('/v1/memory/remember', { content, identity, category })
    },

    async forget(id: string): Promise<void> {
      await client.post('/v1/memory/forget', { id })
    },

    async correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }> {
      return client.post('/v1/memory/correct', { correction, identity })
    },

    async addConversationTurn(
      messages: Array<{ role: string; content: string; timestamp?: Date }>,
      identity: d8umIdentity,
      sessionId?: string,
    ): Promise<unknown> {
      return client.post('/v1/memory/conversation', { messages, identity, sessionId })
    },

    async destroy(): Promise<void> {
      // No-op in cloud mode
    },

    // ── Document CRUD (cloud-only extensions) ──

    async listDocuments(filter?: DocumentFilter): Promise<d8umDocument[]> {
      return client.post<d8umDocument[]>('/v1/documents/list', filter)
    },

    async getDocument(documentId: string): Promise<d8umDocument> {
      return client.get<d8umDocument>(`/v1/documents/${e(documentId)}`)
    },

    async updateDocument(documentId: string, update: Partial<d8umDocument>): Promise<d8umDocument> {
      return client.patch<d8umDocument>(`/v1/documents/${e(documentId)}`, update)
    },

    async deleteDocuments(filter: DocumentFilter): Promise<number> {
      return client.delete<number>('/v1/documents', filter)
    },
  }

  return instance
}
