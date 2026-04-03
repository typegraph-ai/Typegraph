// Main public API
export { d8um, d8umCreate, d8umDeploy, resolveEmbeddingProvider, resolveLLMProvider } from './d8um.js'
export type { d8umConfig, d8umInstance, BucketsApi, JobsApi, DocumentJobsApi, LLMInput } from './d8um.js'

// Types
export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Bucket,
  CreateBucketInput,
  IndexConfig,
  EmbeddingInput,
  EmbeddedChunk,
  ChunkFilter,
  ScoredChunk,
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
  UndeployResult,
  ScoredChunkWithDocument,
  QueryMode,
  d8umQuery,
  d8umResult,
  QueryOpts,
  QueryResponse,
  AssembleOpts,
  IndexOpts,
  IndexProgressEvent,
  IndexResult,
  d8umDocument,
  DocumentStatus,
  Visibility,
  DocumentFilter,
  UpsertDocumentInput,
  JobCategory,
  JobStatus,
  JobTypeDefinition,
  ConfigField,
  Job,
  CreateJobInput,
  JobRunContext,
  JobRunResult,
  JobRun,
  ResultField,
  ApiClient,
  ApiResponse,
  DocumentJobRelationType,
  DocumentJobRelation,
  DocumentJobRelationFilter,
  d8umHooks,
  LLMProvider,
  d8umIdentity,
  GraphBridge,
  ExtractionConfig,
} from './types/index.js'
export { IndexError } from './types/index.js'
export { D8umError, NotFoundError, NotInitializedError, ConfigError } from './types/index.js'

// Embedding
export type { EmbeddingProvider } from './embedding/index.js'
export { aiSdkEmbeddingProvider, isAISDKEmbeddingInput } from './embedding/index.js'
export type { AISDKEmbeddingModel, AISDKEmbeddingInput } from './embedding/index.js'

// LLM
export { aiSdkLlmProvider, isAISDKLLMInput } from './llm/index.js'
export type { AISDKLanguageModel, AISDKLLMInput } from './llm/index.js'

// Index engine
export { IndexEngine, defaultChunker, sha256, stripMarkdown } from './index-engine/index.js'

// Query engine
export { assemble } from './query/index.js'
export { mergeAndRank, minMaxNormalize } from './query/index.js'
export { searchWithContext } from './query/index.js'
export type { NormalizedResult } from './query/index.js'
export type { ContextSearchOpts, ContextPassage, ContextSearchResponse } from './query/index.js'

// Jobs
export {
  registerJobType,
  unregisterJobType,
  getJobType,
  listJobTypes,
  listJobTypesByCategory,
  builtInJobTypes,
} from './jobs/index.js'

// Built-in job implementations
export { urlScrapeJob, fetchPage, DEFAULT_STRIP_ELEMENTS, DEFAULT_STRIP_SELECTORS } from './jobs/index.js'
export type { UrlMeta } from './jobs/index.js'
export { domainCrawlJob, Crawler } from './jobs/index.js'
export type { CrawlerConfig } from './jobs/index.js'

// Cloud mode
export { createCloudInstance, HttpClient, d8umApiError } from './cloud/index.js'
export type { d8umCloudInstance, CloudConfig } from './cloud/index.js'
