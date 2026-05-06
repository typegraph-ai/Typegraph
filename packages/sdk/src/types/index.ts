export type {
  SourceInput,
  SourceSubject,
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
  ChunkRef,
  ChunkFilter,
  ScoredChunk,
} from './chunk.js'

export type {
  SearchOpts,
  HashRecord,
  HashStoreAdapter,
  VectorStoreAdapter,
  UndeployResult,
  ScoredChunkWithSource,
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
  QueryEntityScope,
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
  typegraphSource,
  SourceStatus,
  Visibility,
  SourceFilter,
  UpsertSourceInput,
  UpsertedSourceRecord,
} from './source.js'

export type { typegraphHooks } from './hooks.js'

export type { LLMProvider, LLMGenerateOptions, LLMConfig } from './llm-provider.js'

export type { typegraphIdentity } from './identity.js'

export type {
  MemoryBridge,
  KnowledgeGraphBridge,
  MemorySubject,
  GraphEntityRef,
  UpsertGraphEntityInput,
  UpsertGraphEdgeInput,
  UpsertGraphFactInput,
  MergeGraphEntitiesInput,
  MergeGraphEntitiesResult,
  DeleteGraphEntityOpts,
  DeleteGraphEntityResult,
  EntityScopeResolution,
  KnowledgeSearchOpts,
  KnowledgeSearchResult,
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
  ChunkResult,
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
