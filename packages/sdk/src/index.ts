// Main public API
export { typegraphInit, typegraphDeploy, resolveEmbeddingProvider, resolveLLMProvider, DEFAULT_BUCKET_ID } from './typegraph.js'
export type { typegraphConfig, typegraphInstance, BucketsApi, DocumentsApi, JobsApi, GraphApi } from './typegraph.js'
/** @deprecated Use LLMConfig instead. */
export type { LLMInput } from './typegraph.js'

// Types
export type {
  RawDocument,
  ChunkOpts,
  Chunk,
  Bucket,
  CreateBucketInput,
  BucketListFilter,
  IndexDefaults,
  EmbeddingConfig,
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
  IngestOptions,
  IndexProgressEvent,
  IndexResult,
  ExtractionFailure,
  typegraphDocument,
  DocumentStatus,
  Visibility,
  DocumentFilter,
  UpsertDocumentInput,
  UpsertedDocumentRecord,
  typegraphHooks,
  LLMProvider,
  LLMGenerateOptions,
  LLMConfig,
  typegraphIdentity,
  MemoryBridge,
  MemorySubject,
  RememberOpts,
  ForgetOpts,
  CorrectOpts,
  RecallOpts,
  AddConversationTurnOpts,
  HealthCheckOpts,
  KnowledgeGraphBridge,
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
  ExtractionConfig,
  typegraphEvent,
  typegraphEventType,
  typegraphEventSink,
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
  ExternalId,
  ExternalIdIdentityType,
  ExternalIdEncoding,
  MemoryRecord,
  ChunkRef,
  ConversationTurnResult,
  MemoryHealthReport,
  typegraphLogger,
  PaginationOpts,
  PaginatedResult,
  Job,
  JobType,
  JobStatus,
  JobFilter,
  UpsertJobInput,
  JobStatusPatch,
} from './types/index.js'
/** @deprecated Use EmbeddingConfig instead. */
export type { EmbeddingInput } from './types/index.js'
export { IndexError } from './types/index.js'
export { TypegraphError, NotFoundError, NotInitializedError, ConfigError } from './types/index.js'

// Embedding
export type { EmbeddingProvider } from './embedding/index.js'
export { aiSdkEmbeddingProvider, isAISDKEmbeddingInput, embeddingModelKey, parseEmbeddingModelKey } from './embedding/index.js'
export type { AISDKEmbeddingInput } from './embedding/index.js'

// LLM
export { aiSdkLlmProvider, isAISDKLLMInput } from './llm/index.js'
export type { AISDKLLMInput } from './llm/index.js'

// Governance
export { PolicyEngine, PolicyViolationError } from './governance/index.js'

// Index engine
export {
  IndexEngine,
  defaultChunker,
  sha256,
  stripMarkdown,
  ENTITY_TYPES,
  DEFAULT_ENTITY_TYPE,
  VALID_ENTITY_TYPES,
  ENTITY_TYPES_LIST,
  ENTITY_TYPE_SPECS,
  PREDICATE_SPECS,
  ALL_PREDICATES,
  PREDICATE_BY_NAME,
  SYMMETRIC_PREDICATES,
  GENERIC_DISALLOWED_PREDICATES,
  ALIAS_RELATION_CUES,
  ALIAS_ASSIGNMENT_CUES,
  sanitizePredicate,
  isSymmetricPredicate,
  getPredicatesForPrompt,
  normalizePredicateWithDirection,
  validatePredicateTypes,
} from './index-engine/index.js'
export type {
  EntityType,
  EntityTypeSpec,
  PredicateAliasSpec,
  PredicateSpec,
  PredicateTemporalStatus,
  PredicateNormalization,
  PredicateTypeValidation,
} from './index-engine/index.js'

// Query engine
export { mergeAndRank, minMaxNormalize, calibrateSemantic, calibrateKeyword, normalizeGraphPPR } from './query/index.js'
export { resolveSignals, signalLabel, computeCompositeScore, classifyQuery, type QueryClassification, type QueryType } from './query/index.js'

// Utilities
export { generateId, chunkIdFor } from './utils/id.js'
export type { ChunkIdInput } from './utils/id.js'

// Cloud mode
export { createCloudInstance, HttpClient, TypegraphApiError } from './cloud/index.js'
export type { typegraphCloudInstance, CloudConfig } from './cloud/index.js'

// ── Memory ──
export type {
  MemoryCategory,
  MemoryStatus,
  TemporalRecord,
  EpisodicMemory,
  SemanticEntity,
  EntityMentionType,
  SemanticEntityMention,
  SemanticGraphNodeType,
  SemanticGraphEdge,
  SemanticEntityChunkEdge,
  SemanticChunkRecord,
  SemanticEdge,
  SemanticFactRecord,
  SemanticFact,
  ProceduralMemory,
  GraphBackfillPageOpts,
  ChunkBackfillRecord,
  ChunkMentionBackfillRow,
  MemoryFilter,
  MemorySearchOpts,
  MemoryStoreAdapter,
} from './memory/types/index.js'
export { buildScope, scopeKey, scopeMatches, scopeToFilter } from './memory/types/index.js'
export {
  isActiveAt,
  isActiveBetween,
  invalidateRecord,
  expireRecord,
  createTemporal,
  temporalOverlaps,
  transitionStatus,
} from './memory/temporal.js'
export { MemoryExtractor, EntityResolver, InvalidationEngine } from './memory/extraction/index.js'
export type {
  ConversationMessage,
  MemoryOperationType,
  MemoryOperation,
  CandidateFact,
  ExtractionResult,
  EntityResolverConfig,
  InvalidationConfig,
  Contradiction,
} from './memory/extraction/index.js'
export { PredicateNormalizer } from './memory/extraction/predicate-normalizer.js'
export { ConsolidationEngine } from './memory/consolidation/engine.js'
export type {
  ConsolidationConfig,
  ConsolidationStrategy,
  ConsolidationOpts,
  ConsolidationResult,
} from './memory/consolidation/engine.js'
export { decayScore, scoreMemories, findDecayedMemories, DEFAULT_DECAY_CONFIG } from './memory/consolidation/decay.js'
export type { DecayConfig } from './memory/consolidation/decay.js'
export { ForgettingEngine } from './memory/consolidation/forgetting.js'
export type { ForgettingPolicy, ForgettingResult } from './memory/consolidation/forgetting.js'
export { MemoryCorrector } from './memory/consolidation/correction.js'
export type { CorrectionResult } from './memory/consolidation/correction.js'
export { TypegraphMemory } from './memory/typegraph-memory.js'
export type { typegraphMemoryConfig } from './memory/typegraph-memory.js'
export { createMemoryBridge } from './memory/memory-bridge.js'
export type { CreateMemoryBridgeConfig } from './memory/memory-bridge.js'

// ── Knowledge Graph ──
export { EmbeddedGraph } from './graph/graph/embedded-graph.js'
export type { GraphNode, GraphPath, Subgraph } from './graph/graph/embedded-graph.js'
export { personalizedPageRank } from './graph/graph/ppr.js'
export type { PPRConfig } from './graph/graph/ppr.js'
export { EntityLinker } from './graph/graph/entity-linker.js'
export type { EntityLinkerConfig, EntityLinkResult } from './graph/graph/entity-linker.js'
export { createKnowledgeGraphBridge } from './graph/graph-bridge.js'
export type { CreateKnowledgeGraphBridgeConfig } from './graph/graph-bridge.js'
