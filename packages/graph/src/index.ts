import { registerJobType } from '@d8um/core'

// ── Types ──

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

// ── Working memory ──

export { WorkingMemory } from './working-memory.js'
export type { WorkingMemoryItem, WorkingMemoryConfig } from './working-memory.js'

// ── Extraction ──

export type { LLMProvider } from '@d8um/core'
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

// ── Graph ──

export { EmbeddedGraph } from './graph/embedded-graph.js'
export type { GraphNode, GraphPath, Subgraph } from './graph/embedded-graph.js'
export { personalizedPageRank } from './graph/ppr.js'
export type { PPRConfig } from './graph/ppr.js'
export { EntityLinker } from './graph/entity-linker.js'
export type { EntityLinkerConfig, EntityLinkResult } from './graph/entity-linker.js'

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

// ── Jobs ──

import { memoryConsolidationJob } from './jobs/consolidation-job.js'
import { memoryDecayJob } from './jobs/decay-job.js'
import { memoryCommunityDetectionJob } from './jobs/community-detection-job.js'
import { memoryCorrectionJob } from './jobs/correction-job.js'
import { memoryProceduralPromotionJob } from './jobs/procedural-promotion-job.js'
export { conversationIngestJob } from './jobs/conversation-ingest.js'
import { entityLinkingJob } from './jobs/entity-linking-job.js'
export { memoryConsolidationJob, memoryDecayJob, memoryCommunityDetectionJob, memoryCorrectionJob, memoryProceduralPromotionJob, entityLinkingJob }

export function registerConsolidationJobs(): void {
  registerJobType(memoryConsolidationJob)
  registerJobType(memoryDecayJob)
  registerJobType(memoryCommunityDetectionJob)
  registerJobType(memoryCorrectionJob)
  registerJobType(memoryProceduralPromotionJob)
}

// ── Adapters ──

export { PgMemoryStoreAdapter } from './adapters/pgvector.js'
export type { PgMemoryAdapterConfig } from './adapters/pgvector.js'

// ── Unified API ──

export { d8umMemory } from './d8um-memory.js'
export type { d8umMemoryConfig } from './d8um-memory.js'

// ── Graph Bridge ──

export { createGraphBridge } from './graph-bridge.js'
export type { CreateGraphBridgeConfig } from './graph-bridge.js'
