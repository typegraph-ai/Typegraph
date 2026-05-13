// Main public API
export { typegraphInit, typegraphDeploy, resolveEmbedder, resolveLLMProvider, DEFAULT_BUCKET_ID, DEFAULT_GRAPH_ID } from './typegraph.js'
export type { typegraphConfig, typegraphInstance, BucketsApi, DocumentsApi, EventsApi, ThreadsApi, JobsApi, GraphApi, RequestOptions, DocumentIngestOptions } from './typegraph.js'

// Types
export type {
  DocumentInput,
  typegraphDocument,
  DocumentStatus,
  DocumentFilter,
  DocumentStorageFilter,
  UpsertDocumentInput,
  UpsertedDocumentRecord,
  EventInput,
  EventFilter,
  EventStorageFilter,
  typegraphEventRecord,
  UpsertEventInput,
  ThreadInput,
  ThreadTurnInput,
  ThreadFilter,
  ThreadStorageFilter,
  typegraphThread,
  UpsertThreadInput,
  LinkKind,
  typegraphLink,
  UpsertLinkInput,
  OntologyConfig,
  OntologyProfile,
  OntologyEntityConfig,
  OntologyRelationConfig,
  OntologyVocabularyMatch,
  OntologyVocabularyRef,
  OntologyResolutionConfig,
  OntologyPromptConfig,
  CompiledOntology,
  Extractor,
  ExtractorCapabilities,
  ExtractionCoreferenceCache,
  ExtractionCoreferenceCacheKey,
  ExtractorContext,
  ExtractorInput,
  ExtractedEntity,
  ExtractedRelation,
  ExtractionResult,
  Reranker,
  RerankerOptions,
  ChunkOpts,
  Chunk,
  Bucket,
  CreateBucketInput,
  BucketListFilter,
  BucketStorageFilter,
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
  SearchOptions,
  SearchResource,
  SearchWeights,
  SearchFusion,
  SearchRerankOptions,
  SearchExplanation,
  OutputScores,
  QueryChunkResult,
  QueryResults,
  PromptFormat,
  PromptSection,
  PromptBuilderOptions,
  PromptStats,
  RawScores,
  NormalizedScores,
  QueryEntityScope,
  QueryResponse,
  IngestOptions,
  IndexProgressEvent,
  IndexResult,
  ExtractionFailure,
  typegraphHooks,
  LLMProvider,
  LLMGenerateOptions,
  LLMConfig,
  MemorySubject,
  RememberOpts,
  ForgetOpts,
  CorrectOpts,
  RecallOpts,
  HealthCheckOpts,
  GraphEntityRef,
  UpsertGraphEntityInput,
  UpsertGraphEdgeInput,
  UpsertGraphFactInput,
  MergeGraphEntitiesInput,
  MergeGraphEntitiesResult,
  DeleteGraphEntityOpts,
  DeleteGraphEntityResult,
  EntityScopeResolution,
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
  ExternalIdEncoding,
  MemoryRecord,
  ChunkRef,
  ThreadTurnResult,
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
export { IndexError } from './types/index.js'
export {
  TypegraphError,
  NotFoundError,
  NotInitializedError,
  ConfigError,
  GraphSelfEdgeError,
} from './types/index.js'
export type { GraphSelfEdgeErrorDetails } from './types/index.js'
export {
  TenantId,
  OrganizationId,
  GroupId,
  UserId,
  AgentId,
  ThreadId,
  EntityId,
  entityRef,
} from './types/identity.js'
export type {
  Brand,
  EntityRef,
  TypeGraphContext,
  TypeGraphOptions,
  TypeGraphWriteOptions,
} from './types/identity.js'
export {
  GraphId,
} from './types/graph.js'
export type {
  GraphAccessConfig,
  GraphAccessPrincipals,
  GraphConfig,
  TypeGraphGraphRecord,
} from './types/graph.js'

// Embedding
export type { Embedder, EmbedInput } from './embedding/index.js'
export { aiSdkEmbedder, isAISDKEmbeddingInput, embeddingModelKey, parseEmbeddingModelKey } from './embedding/index.js'
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
  DefaultGraphExtractor,
  TripleExtractor,
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
  ONTOLOGY_VOCABULARY_SOURCES,
  BUILT_IN_ENTITY_VOCABULARY,
  BUILT_IN_RELATION_VOCABULARY,
  sanitizePredicate,
  isSymmetricPredicate,
  getPredicatesForPrompt,
  effectiveEntityTypes,
  normalizePredicateWithDirection,
  normalizeTypeCandidates,
  typeAffinityGroup,
  typesShareAffinity,
  validatePredicateEffectiveTypes,
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
  TypeCandidate,
} from './index-engine/index.js'

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
// ── Knowledge Graph ──
