// ── Types ──

export type {
  MemoryCategory,
  MemoryStatus,
  TemporalRecord,
  ExternalId,
  ExternalIdEncoding,
  MemoryRecord,
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
  MemoryFilter,
  MemorySearchOpts,
  MemoryStoreAdapter,
} from './types/index.js'

export {
  buildScope,
  scopeKey,
  scopeMatches,
  scopeToFilter,
} from './types/index.js'

// ── Temporal utilities ──

export {
  isActiveAt,
  isActiveBetween,
  invalidateRecord,
  expireRecord,
  createTemporal,
  temporalOverlaps,
  transitionStatus,
} from './temporal.js'

// ── Events ──

export type { typegraphEvent, typegraphEventType, typegraphEventSink } from '../types/events.js'

// ── Extraction ──

export type { LLMProvider } from '../types/llm-provider.js'
export { MemoryExtractor } from './extraction/index.js'
export type {
  ConversationMessage,
  MemoryOperationType,
  MemoryOperation,
  CandidateFact,
  ExtractionResult,
  ExtractionConfig,
} from './extraction/index.js'
export { EntityResolver } from './extraction/index.js'
export type { EntityResolverConfig } from './extraction/index.js'
export { InvalidationEngine } from './extraction/index.js'
export type { InvalidationConfig, Contradiction } from './extraction/index.js'

// ── Predicate Normalizer ──

export { PredicateNormalizer } from './extraction/predicate-normalizer.js'

// ── Consolidation ──

export { ConsolidationEngine } from './consolidation/engine.js'
export type {
  ConsolidationConfig,
  ConsolidationStrategy,
  ConsolidationOpts,
  ConsolidationResult,
} from './consolidation/engine.js'

export { decayScore, scoreMemories, findDecayedMemories, DEFAULT_DECAY_CONFIG } from './consolidation/decay.js'
export type { DecayConfig } from './consolidation/decay.js'

export { ForgettingEngine } from './consolidation/forgetting.js'
export type { ForgettingPolicy, ForgettingResult } from './consolidation/forgetting.js'

export { MemoryCorrector } from './consolidation/correction.js'
export type { CorrectionResult } from './consolidation/correction.js'

// ── Unified API ──

export { TypegraphMemory } from './typegraph-memory.js'
export type { typegraphMemoryConfig, MemoryHealthReport } from './typegraph-memory.js'

// ── Memory Bridge ──

export { createMemoryBridge } from './memory-bridge.js'
export type { CreateMemoryBridgeConfig } from './memory-bridge.js'
