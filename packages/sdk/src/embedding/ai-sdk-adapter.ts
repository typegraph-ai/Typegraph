import { embed, embedMany } from 'ai'
import type { EmbeddingModelV3 } from '@ai-sdk/provider'
import type { Embedder } from './provider.js'

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
 *   providerOptions: { voyage: { outputDimension: 512, inputType: 'source' } },
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
 * Wraps an AI SDK embedding model into typegraph's Embedder interface.
 * Uses the AI SDK's `embed` and `embedMany` for automatic batching and retries.
 */
export function aiSdkEmbedder(config: AISDKEmbeddingInput): Embedder {
  const { model, dimensions, providerOptions } = config

  return {
    name: `${model.provider}/${model.modelId}`,
    dimensions,
    supportsAsymmetric: true,

    async embed(input): Promise<number[][]> {
      const texts = input.texts
      if (texts.length === 0) return []
      const providerOptionsWithInput = input.outputDimensions || input.inputType
        ? {
            ...(providerOptions ?? {}),
            typegraph: {
              ...(input.outputDimensions ? { outputDimensions: input.outputDimensions } : {}),
              ...(input.inputType ? { inputType: input.inputType } : {}),
            },
          }
        : providerOptions
      if (texts.length === 1) {
        const result = await embed({
          model,
          value: texts[0]!,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          ...(providerOptionsWithInput ? { providerOptions: providerOptionsWithInput as any } : {}),
        })
        return [result.embedding as number[]]
      }

      const result = await embedMany({
        model,
        values: texts,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        ...(providerOptionsWithInput ? { providerOptions: providerOptionsWithInput as any } : {}),
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
