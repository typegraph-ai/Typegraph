import type { LLMProvider } from './llm-provider.js'

/**
 * Configuration for the triple extraction pipeline.
 * Controls whether extraction uses a single combined LLM call or two separate passes,
 * and allows per-pass model overrides.
 */
export interface ExtractionConfig {
  /**
   * Use two separate LLM calls (entities then relationships) instead of one combined call.
   * - `false` (default): Single call extracts both entities and relationships together.
   *   Better coherence, lower latency, works well with reasoning models.
   * - `true`: Pass 1 extracts entities, Pass 2 extracts relationships using the entity list.
   *   Allows different models per pass.
   */
  twoPass?: boolean | undefined

  /**
   * LLM for entity extraction (Pass 1 in two-pass mode) or the single combined call.
   * Falls back to the main `d8umConfig.llm` if not provided.
   */
  entityLlm?: LLMProvider | undefined

  /**
   * LLM for relationship extraction (Pass 2 in two-pass mode).
   * Only used when `twoPass: true`. Falls back to `entityLlm`, then `d8umConfig.llm`.
   */
  relationshipLlm?: LLMProvider | undefined
}
