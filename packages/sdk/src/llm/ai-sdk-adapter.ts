import { generateText, Output } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { LLMProvider, LLMGenerateOptions } from '../types/llm-provider.js'

/**
 * Configuration for using an AI SDK language model with typegraph.
 *
 * @example
 * ```ts
 * import { gateway } from '@ai-sdk/gateway'
 *
 * const llm = aiSdkLlmProvider({
 *   model: gateway('openai/gpt-5.4-mini'),
 * })
 * ```
 *
 * @example Provider-specific options (gateway fallbacks, reasoning, thinking):
 * ```ts
 * const llm = aiSdkLlmProvider({
 *   model: gateway('openai/gpt-5.4-mini'),
 *   providerOptions: {
 *     gateway: { models: ['google/gemini-3-flash', 'openai/gpt-5.4-mini'] },
 *     openai:  { reasoningEffort: 'medium', reasoningSummary: 'concise' },
 *     google:  { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: false } },
 *     xai:     { reasoningEffort: 'low' },
 *   },
 * })
 * ```
 */
export interface AISDKLLMInput {
  model: LanguageModelV3
  /**
   * Provider-specific options applied to every generateText / generateJSON call.
   * Merged per-namespace with any options passed at call time (call-level wins).
   */
  providerOptions?: Record<string, Record<string, unknown>>
}

function mergeProviderOptions(
  defaults?: Record<string, Record<string, unknown>>,
  call?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> | undefined {
  if (!defaults && !call) return undefined
  const out: Record<string, Record<string, unknown>> = { ...(defaults ?? {}) }
  for (const [provider, opts] of Object.entries(call ?? {})) {
    out[provider] = { ...(out[provider] ?? {}), ...opts }
  }
  return out
}

/**
 * Wraps an AI SDK language model into typegraph's LLMProvider interface.
 * Uses the AI SDK's `generateText` and `Output` for structured output.
 */
export function aiSdkLlmProvider(config: AISDKLLMInput): LLMProvider {
  const { model, providerOptions: defaultProviderOptions } = config

  const provider: LLMProvider = {
    async generateText(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<string> {
      const merged = mergeProviderOptions(defaultProviderOptions, options?.providerOptions)
      const result = await generateText({
        model,
        prompt,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(merged ? { providerOptions: merged as any } : {}),
      })

      return result.text
    },

    async generateJSON<T = unknown>(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<T> {
      const merged = mergeProviderOptions(defaultProviderOptions, options?.providerOptions)
      const result = await generateText({
        model,
        output: options?.schema
          ? Output.object({ schema: options.schema as any })
          : Output.json(),
        prompt: prompt + '\n\nRespond with valid JSON only, no markdown fences.',
        ...(systemPrompt ? { system: systemPrompt } : {}),
        maxOutputTokens: options?.maxOutputTokens ?? 16384,
        ...(merged ? { providerOptions: merged as any } : {}),
      })

      return result.output as T
    },
  }

  return provider
}

/**
 * Type guard: checks if a value is an AISDKLLMInput
 * by looking for `model.doGenerate` function.
 */
export function isAISDKLLMInput(
  value: unknown
): value is AISDKLLMInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const m = v['model']
  if (typeof m !== 'object' || m === null) return false
  return typeof (m as Record<string, unknown>)['doGenerate'] === 'function'
}
