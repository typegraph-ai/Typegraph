export type {
  RawDocument,
  ChunkOpts,
  Chunk,
} from './connector.js'

export type {
  Bucket,
  CreateBucketInput,
  BucketListFilter,
  IndexDefaults,
  EmbeddingConfig,
  EmbeddingInput,
} from './bucket.js'

export type {
  EmbeddedChunk,
  ChunkFilter,
  ScoredChunk,
} from './document.js'

export type {
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
  UndeployResult,
  ScoredChunkWithDocument,
} from './adapter.js'

export type {
  QuerySignals,
  QueryChunkResult,
  QueryMemoryRecord,
  QueryMemoryResult,
  QueryResults,
  ContextFormat,
  ContextSection,
  QueryContextOptions,
  QueryContextStats,
  RawScores,
  NormalizedScores,
  QueryOpts,
  QueryResponse,
} from './query.js'

export type {
  IngestOptions,
  IndexProgressEvent,
  IndexResult,
  ExtractionFailure,
} from './index-types.js'

export { IndexError } from './index-types.js'

export type {
  typegraphDocument,
  DocumentStatus,
  Visibility,
  DocumentFilter,
  UpsertDocumentInput,
  UpsertedDocumentRecord,
} from './typegraph-document.js'

export type { typegraphHooks } from './hooks.js'

export type { LLMProvider, LLMGenerateOptions, LLMConfig } from './llm-provider.js'

export type { typegraphIdentity } from './identity.js'

export type {
  MemoryBridge,
  KnowledgeGraphBridge,
  GraphEntityRef,
  UpsertGraphEntityInput,
  UpsertGraphEdgeInput,
  UpsertGraphFactInput,
  EntityResult,
  EntityDetail,
  EdgeResult,
  FactResult,
  FactSearchOpts,
  FactRelevanceFilter,
  GraphExploreOptions,
  GraphExploreOpts,
  GraphExploreIntent,
  GraphExploreTrace,
  GraphExploreResult,
  GraphBackfillOpts,
  GraphBackfillResult,
  GraphExplainOpts,
  PassageResult,
  GraphIntentParserMode,
  GraphSearchProfile,
  GraphSearchOpts,
  GraphSearchTrace,
  GraphSearchResult,
  SubgraphOpts,
  SubgraphResult,
  GraphStats,
  RememberOpts,
  ForgetOpts,
  CorrectOpts,
  RecallOpts,
  AddConversationTurnOpts,
  HealthCheckOpts,
} from './graph-bridge.js'

export type { ExtractionConfig } from './extraction-config.js'

export type {
  typegraphEventType,
  typegraphEvent,
  TokenUsage,
  typegraphEventSink,
} from './events.js'

export { TypegraphError, NotFoundError, NotInitializedError, ConfigError } from './errors.js'

export type {
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
} from './policy.js'

export type {
  ConversationTurnResult,
  MemoryHealthReport,
} from './memory.js'
export type {
  ExternalId,
  ExternalIdIdentityType,
  ExternalIdEncoding,
  MemoryRecord,
} from '../memory/types/memory.js'

export type { typegraphLogger } from './logger.js'

export type {
  PaginationOpts,
  PaginatedResult,
} from './pagination.js'

export type {
  Job,
  JobType,
  JobStatus,
  JobFilter,
  UpsertJobInput,
  JobStatusPatch,
} from './job.js'
