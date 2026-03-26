import { registerJobType } from '@d8um/core'
import { memoryConsolidationJob } from './jobs/consolidation-job.js'
import { memoryDecayJob } from './jobs/decay-job.js'
import { memoryCommunityDetectionJob } from './jobs/community-detection-job.js'
import { memoryCorrectionJob } from './jobs/correction-job.js'
import { memoryProceduralPromotionJob } from './jobs/procedural-promotion-job.js'

// Engine
export { ConsolidationEngine } from './engine.js'
export type {
  ConsolidationConfig,
  ConsolidationStrategy,
  ConsolidationOpts,
  ConsolidationResult,
} from './engine.js'

// Decay
export { decayScore, scoreMemories, findDecayedMemories, DEFAULT_DECAY_CONFIG } from './decay.js'
export type { DecayConfig } from './decay.js'

// Forgetting
export { ForgettingEngine } from './forgetting.js'
export type { ForgettingPolicy, ForgettingResult } from './forgetting.js'

// Correction
export { MemoryCorrector } from './correction.js'
export type { CorrectionResult } from './correction.js'

// Job definitions
export { memoryConsolidationJob, memoryDecayJob, memoryCommunityDetectionJob, memoryCorrectionJob, memoryProceduralPromotionJob }

/**
 * Convenience function to register all memory lifecycle job types at once.
 *
 * @example
 * ```ts
 * import { registerConsolidationJobs } from '@d8um/consolidation'
 * registerConsolidationJobs()  // registers all 5 memory job types
 * ```
 */
export function registerConsolidationJobs(): void {
  registerJobType(memoryConsolidationJob)
  registerJobType(memoryDecayJob)
  registerJobType(memoryCommunityDetectionJob)
  registerJobType(memoryCorrectionJob)
  registerJobType(memoryProceduralPromotionJob)
}
