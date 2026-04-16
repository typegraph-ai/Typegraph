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
 */
export interface AISDKLLMInput {
  model: LanguageModelV3
}

/**
 * Wraps an AI SDK language model into typegraph's LLMProvider interface.
 * Uses the AI SDK's `generateText` and `Output` for structured output.
 */
export function aiSdkLlmProvider(config: AISDKLLMInput): LLMProvider {
  const { model } = config

  const provider: LLMProvider = {
    async generateText(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<string> {
      const result = await generateText({
        model,
        prompt,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options?.providerOptions ? { providerOptions: options.providerOptions as any } : {}),
      })

      return result.text
    },

    async generateJSON<T = unknown>(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<T> {
      const result = await generateText({
        model,
        output: options?.schema
          ? Output.object({ schema: options.schema as any })
          : Output.json(),
        prompt: prompt + '\n\nRespond with valid JSON only, no markdown fences.',
        ...(systemPrompt ? { system: systemPrompt } : {}),
        maxOutputTokens: options?.maxOutputTokens ?? 16384,
        ...(options?.providerOptions ? { providerOptions: options.providerOptions as any } : {}),
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
