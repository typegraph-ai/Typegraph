import type { LLMConfig } from './llm-provider.js'

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
   * Accepts a bare AI SDK model, { model } wrapper, or a resolved LLMProvider.
   * Falls back to the main `typegraphConfig.llm` if not provided.
   */
  entityLlm?: LLMConfig | undefined

  /**
   * LLM for relationship extraction (Pass 2 in two-pass mode).
   * Accepts a bare AI SDK model, { model } wrapper, or a resolved LLMProvider.
   * Only used when `twoPass: true`. Falls back to `entityLlm`, then `typegraphConfig.llm`.
   */
  relationshipLlm?: LLMConfig | undefined
}
