// Main public API
export { d8um, d8umCreate, d8umDeploy, resolveEmbeddingProvider, resolveLLMProvider, DEFAULT_BUCKET_ID } from './d8um.js'
export type { d8umConfig, d8umInstance, BucketsApi, DocumentsApi, LLMInput } from './d8um.js'

// Types
export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Bucket,
  CreateBucketInput,
  BucketListFilter,
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
  QuerySignals,
  d8umQuery,
  d8umResult,
  RawScores,
  NormalizedScores,
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
  d8umHooks,
  LLMProvider,
  d8umIdentity,
  GraphBridge,
  ExtractionConfig,
  d8umEvent,
  d8umEventType,
  d8umEventSink,
  TokenUsage,
  PolicyType,
  PolicyAction,
  PolicyRule,
  Policy,
  CreatePolicyInput,
  UpdatePolicyInput,
  PolicyEvalContext,
  PolicyDecision,
  PolicyViolation,
  PolicyStoreAdapter,
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

// Governance
export { PolicyEngine, PolicyViolationError } from './governance/index.js'

// Index engine
export { IndexEngine, defaultChunker, sha256, stripMarkdown } from './index-engine/index.js'

// Query engine
export { assemble } from './query/index.js'
export { mergeAndRank, minMaxNormalize } from './query/index.js'
export { resolveSignals, signalLabel, computeCompositeScore, classifyQuery } from './query/index.js'
export { searchWithContext } from './query/index.js'
export type { NormalizedResult } from './query/index.js'
export type { ContextSearchOpts, ContextPassage, ContextSearchResponse } from './query/index.js'

// Utilities
export { generateId } from './utils/id.js'

// Cloud mode
export { createCloudInstance, HttpClient, d8umApiError } from './cloud/index.js'
export type { d8umCloudInstance, CloudConfig } from './cloud/index.js'
