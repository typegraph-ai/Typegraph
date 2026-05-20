import type { DocumentInput } from './document.js'
import type { GraphConfig } from './graph.js'
import type { Embedder } from '../embedding/provider.js'
import type { AISDKEmbeddingInput } from '../embedding/ai-sdk-adapter.js'

/**
 * A bucket is a named container for documents and events.
 * Buckets have no type - they are user-defined namespaces for organizing sources.
 * A bucket named "Marketing Content" could receive sources from a URL scrape,
 * a domain crawl, file uploads, and a Slack sync - all at the same time.
 *
 * Each bucket supports exactly one embedding model, set at creation time.
 */
export interface Bucket {
  id: string
  name: string
  description?: string | undefined
  status: 'active' | 'inactive'
  /** Embedding model for this bucket (ingest). Set at creation, immutable. */
  embeddingModel?: string | undefined
  /** Search embedding model for this bucket. Must embed into same vector space as embeddingModel. */
  searchEmbeddingModel?: string | undefined
  indexDefaults?: IndexDefaults | undefined
  tenantId: string
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  /** Write graph for documents/events/threads routed through this bucket. Defaults to "public". */
  graph?: string | undefined
  /** Bucket default for graph extraction. Can also be set under indexDefaults.graphExtraction. */
  graphExtraction?: boolean | undefined
}

/**
 * Bucket-level index defaults. These are applied to every ingest() call
 * targeting the bucket unless overridden per-call via IngestOptions.
 *
 * This is the bucket-mergeable slice of IngestOptions — fields that identify
 * the caller (tenantId, userId, etc.) or control batch behavior (dryRun,
 * concurrency, traceId) are runtime-only and never live here.
 */
export interface IndexDefaults {
  chunkSize?: number | undefined
  chunkOverlap?: number | undefined
  deduplicateBy?: string[] | ((document: DocumentInput) => string) | undefined
  stripMarkdownForEmbedding?: boolean | undefined
  preprocessForEmbedding?: ((content: string) => string) | undefined
  propagateMetadata?: string[] | undefined
  /**
   * Whether entity/relationship triples are extracted during ingestion for this bucket.
   * Requires the TypeGraph instance to be configured with both `llm` and `knowledgeGraph`.
   * Default: false. Can be overridden per-call via IngestOptions.graphExtraction.
   */
  graphExtraction?: boolean | undefined
}

export interface CreateBucketInput {
  id?: string | undefined
  name: string
  description?: string | undefined
  /** Embedding model for this bucket (ingest). Once set, cannot be changed. Defaults to the instance's default embedding. */
  embeddingModel?: string | undefined
  /** Search embedding model for this bucket. Must embed into same vector space as embeddingModel.
   *  Defaults to the instance's searchEmbedding, or the ingest embeddingModel if not set. */
  searchEmbeddingModel?: string | undefined
  /** Write graph for this bucket. Defaults to "public". */
  graph?: string | undefined
  /** Optional graph config to apply when creating/updating the bucket's write graph. */
  graphConfig?: GraphConfig | undefined
  /** Bucket default for graph extraction. Equivalent to indexDefaults.graphExtraction. */
  graphExtraction?: boolean | undefined
  indexDefaults?: IndexDefaults | undefined
}

export interface BucketListFilter {
  name?: string | undefined
}

export interface BucketStorageFilter extends BucketListFilter {
  tenantId?: string | undefined
  organizationId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphIds?: string[] | undefined
  status?: Bucket['status'] | Bucket['status'][] | undefined
}

export type EmbeddingConfig = Embedder | AISDKEmbeddingInput
