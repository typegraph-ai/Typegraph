import { embed, embedMany } from 'ai'
import type { EmbeddingModelV3 } from '@ai-sdk/provider'
import type { EmbeddingProvider } from './provider.js'

/**
 * Configuration for using an AI SDK embedding model with typegraph.
 *
 * @example
 * ```ts
 * import { gateway } from '@ai-sdk/gateway'
 *
 * const embedding: AISDKEmbeddingInput = {
 *   model: gateway.embeddingModel('openai/text-embedding-3-small'),
 *   dimensions: 1536,
 * }
 * ```
 *
 * @example Provider-specific options (e.g., Voyage input type):
 * ```ts
 * const embedding: AISDKEmbeddingInput = {
 *   model: gateway.embeddingModel('voyage/voyage-4-large'),
 *   dimensions: 512,
 *   providerOptions: { voyage: { outputDimension: 512, inputType: 'document' } },
 * }
 * ```
 */
export interface AISDKEmbeddingInput {
  model: EmbeddingModelV3
  dimensions: number
  /** Provider-specific options passed to every embed call (e.g., Voyage outputDimension/inputType). */
  providerOptions?: Record<string, Record<string, unknown>>
}

/**
 * Wraps an AI SDK embedding model into typegraph's EmbeddingProvider interface.
 * Uses the AI SDK's `embed` and `embedMany` for automatic batching and retries.
 */
export function aiSdkEmbeddingProvider(config: AISDKEmbeddingInput): EmbeddingProvider {
  const { model, dimensions, providerOptions } = config

  return {
    model: `${model.provider}/${model.modelId}`,
    dimensions,

    async embed(text: string): Promise<number[]> {
      const result = await embed({
        model,
        value: text,
        ...(providerOptions ? { providerOptions: providerOptions as any } : {}),
      })
      return result.embedding as number[]
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []

      const result = await embedMany({
        model,
        values: texts,
        ...(providerOptions ? { providerOptions: providerOptions as any } : {}),
      })
      return result.embeddings as number[][]
    },
  }
}

/**
 * Type guard: checks if a value is an AISDKEmbeddingInput
 * by looking for the `model.doEmbed` function signature.
 */
export function isAISDKEmbeddingInput(
  value: unknown
): value is AISDKEmbeddingInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v['dimensions'] !== 'number') return false
  const m = v['model']
  if (typeof m !== 'object' || m === null) return false
  return typeof (m as Record<string, unknown>)['doEmbed'] === 'function'
}
