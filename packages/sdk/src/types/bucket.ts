import type { SourceInput } from './connector.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { AISDKEmbeddingInput } from '../embedding/ai-sdk-adapter.js'

/**
 * A bucket is a named container for sources.
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
  /** Query embedding model for this bucket. Must embed into same vector space as embeddingModel. */
  queryEmbeddingModel?: string | undefined
  indexDefaults?: IndexDefaults | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
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
  deduplicateBy?: string[] | ((source: SourceInput) => string) | undefined
  visibility?: import('./source.js').Visibility | undefined
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
  name: string
  description?: string | undefined
  /** Embedding model for this bucket (ingest). Once set, cannot be changed. Defaults to the instance's default embedding. */
  embeddingModel?: string | undefined
  /** Query embedding model for this bucket. Must embed into same vector space as embeddingModel.
   *  Defaults to the instance's queryEmbedding, or the ingest embeddingModel if not set. */
  queryEmbeddingModel?: string | undefined
  indexDefaults?: IndexDefaults | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
}

export interface BucketListFilter {
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
}

/** @deprecated Use EmbeddingConfig instead. */
export type EmbeddingInput = EmbeddingConfig
export type EmbeddingConfig = EmbeddingProvider | AISDKEmbeddingInput
