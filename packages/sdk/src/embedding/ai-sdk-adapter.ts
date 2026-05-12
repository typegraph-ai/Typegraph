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
      const providerOptionsWithInput = normalizeEmbeddingProviderOptions(model, providerOptions, input)
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

type ProviderOptions = Record<string, Record<string, unknown>>

function normalizeEmbeddingProviderOptions(
  model: EmbeddingModelV3,
  providerOptions: ProviderOptions | undefined,
  input: { inputType?: 'document' | 'search' | undefined; outputDimensions?: number | undefined },
): ProviderOptions | undefined {
  const normalized = cloneProviderOptions(providerOptions)

  // `typegraph` was never a real AI SDK provider namespace. Do not leak
  // TypeGraph's internal EmbedInput shape to providers or AI Gateway.
  delete normalized.typegraph

  const provider = embeddingProviderNamespace(model, normalized)
  if (provider === 'voyage') {
    const voyage = { ...(normalized.voyage ?? {}) }
    if (input.outputDimensions !== undefined) {
      voyage.outputDimension = input.outputDimensions
    }
    const inputType = normalizeVoyageInputType(input.inputType ?? stringValue(voyage.inputType))
    if (inputType) {
      voyage.inputType = inputType
    }
    normalized.voyage = voyage
  } else if (provider === 'openai') {
    const openai = { ...(normalized.openai ?? {}) }
    if (input.outputDimensions !== undefined) {
      openai.dimensions = input.outputDimensions
    }
    normalized.openai = openai
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function cloneProviderOptions(providerOptions: ProviderOptions | undefined): ProviderOptions {
  const cloned: ProviderOptions = {}
  for (const [provider, options] of Object.entries(providerOptions ?? {})) {
    cloned[provider] = { ...options }
  }
  return cloned
}

function embeddingProviderNamespace(
  model: EmbeddingModelV3,
  providerOptions: ProviderOptions,
): 'voyage' | 'openai' | undefined {
  const provider = model.provider.toLowerCase()
  const modelId = model.modelId.toLowerCase()
  if (
    providerOptions.voyage
    || provider === 'voyage'
    || modelId.startsWith('voyage/')
    || modelId.includes('voyage-')
  ) {
    return 'voyage'
  }
  if (
    providerOptions.openai
    || provider === 'openai'
    || modelId.startsWith('openai/')
    || modelId.includes('text-embedding')
  ) {
    return 'openai'
  }
  return undefined
}

function normalizeVoyageInputType(inputType: string | undefined): 'document' | 'query' | undefined {
  if (inputType === 'search' || inputType === 'query') return 'query'
  if (inputType === 'document') return 'document'
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
