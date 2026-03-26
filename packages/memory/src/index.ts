// Types
export type {
  MemoryCategory,
  MemoryStatus,
  TemporalRecord,
  MemoryRecord,
  EpisodicMemory,
  SemanticEntity,
  SemanticEdge,
  SemanticFact,
  ProceduralMemory,
  MemoryScope,
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

// Temporal utilities
export {
  isActiveAt,
  isActiveBetween,
  invalidateRecord,
  expireRecord,
  createTemporal,
  temporalOverlaps,
  transitionStatus,
} from './temporal.js'

// Working memory
export { WorkingMemory } from './working-memory.js'
export type { WorkingMemoryItem, WorkingMemoryConfig } from './working-memory.js'

// Extraction
export type { LLMProvider } from './extraction/index.js'
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

// Jobs
export { conversationIngestJob } from './jobs/conversation-ingest.js'

// Unified API
export { D8umMemory } from './d8um-memory.js'
export type { D8umMemoryConfig } from './d8um-memory.js'
