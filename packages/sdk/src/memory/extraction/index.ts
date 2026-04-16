export type { LLMProvider } from './llm-provider.js'

export {
  MemoryExtractor,
} from './extractor.js'

export type {
  ConversationMessage,
  MemoryOperationType,
  MemoryOperation,
  CandidateFact,
  ExtractionResult,
  ExtractionConfig,
} from './extractor.js'

export { EntityResolver, hasConflictingDistinguishers, hasMatchingLastToken, hasSharedNameToken, isValidAlias } from './entity-resolver.js'
export type { EntityResolverConfig } from './entity-resolver.js'

export { InvalidationEngine } from './invalidation.js'
export type { InvalidationConfig, Contradiction } from './invalidation.js'

export {
  factExtractionPrompt,
  entityExtractionPrompt,
  contradictionCheckPrompt,
  conflictResolutionPrompt,
  proceduralExtractionPrompt,
} from './prompts.js'
