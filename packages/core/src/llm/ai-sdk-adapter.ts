import type { LLMProvider, LLMGenerateOptions } from '../types/llm-provider.js'

/**
 * Structural type matching the Vercel AI SDK's LanguageModelV3 interface.
 * No imports from `@ai-sdk/provider` needed - pure structural typing.
 * Any object matching this shape works (AI SDK models, custom implementations, test mocks).
 */
export interface AISDKLanguageModel {
  readonly provider: string
  readonly modelId: string
  doGenerate(options: {
    prompt: Array<
      | { role: 'system'; content: string }
      | { role: 'user'; content: Array<{ type: 'text'; text: string }> }
    >
    maxOutputTokens?: number
    temperature?: number
    providerOptions?: Record<string, Record<string, unknown>>
  }): PromiseLike<{
    content: Array<{ type: string; text?: string }>
    finishReason: string | { unified: string; raw?: string }
  }>
}

/**
 * Configuration for using an AI SDK language model with typegraph.
 *
 * @example
 * ```ts
 * import { gateway } from '@ai-sdk/gateway'
 *
 * const llm: AISDKLLMInput = {
 *   model: gateway('google/gemini-2.5-flash'),
 * }
 * ```
 */
export interface AISDKLLMInput {
  model: AISDKLanguageModel
}

/**
 * Wraps an AI SDK language model into typegraph's LLMProvider interface.
 * Calls `model.doGenerate()` directly - no dependency on the `ai` core package.
 */
export function aiSdkLlmProvider(config: AISDKLLMInput): LLMProvider {
  const { model } = config

  /** Internal helper — calls doGenerate and returns both text and normalized finishReason. */
  async function doGenerateRaw(
    prompt: string,
    systemPrompt?: string,
    options?: LLMGenerateOptions,
  ): Promise<{ text: string; finishReason: string }> {
    const messages: Array<
      | { role: 'system'; content: string }
      | { role: 'user'; content: Array<{ type: 'text'; text: string }> }
    > = []

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] })

    const result = await model.doGenerate({
      prompt: messages,
      ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options?.providerOptions ? { providerOptions: options.providerOptions } : {}),
    })

    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('')

    const finishReason = typeof result.finishReason === 'string'
      ? result.finishReason
      : result.finishReason?.unified ?? 'unknown'

    return { text, finishReason }
  }

  const provider: LLMProvider = {
    async generateText(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<string> {
      const { text } = await doGenerateRaw(prompt, systemPrompt, options)
      return text
    },

    async generateJSON<T = unknown>(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<T> {
      const jsonOptions: LLMGenerateOptions = {
        ...options,
        maxOutputTokens: options?.maxOutputTokens ?? 16384,
      }

      const { text, finishReason } = await doGenerateRaw(
        prompt + '\n\nRespond with valid JSON only, no markdown fences.',
        systemPrompt,
        jsonOptions,
      )

      if (finishReason === 'length') {
        throw new Error(
          'LLM output truncated (finishReason: length) — increase maxOutputTokens or reduce prompt size'
        )
      }

      // Strip markdown fences
      let cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
      // Strip control characters illegal in JSON (U+0000–U+001F except \t \n \r)
      cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

      return JSON.parse(cleaned) as T
    },
  }

  return provider
}

/**
 * Type guard: checks if a value is an AISDKLLMInput
 * by looking for the `model.doGenerate` function signature.
 */
export function isAISDKLLMInput(
  value: unknown
): value is AISDKLLMInput {
  if (typeof value !== 'object' || value === null) return false
  const m = (value as Record<string, unknown>)['model']
  if (typeof m !== 'object' || m === null) return false
  return typeof (m as Record<string, unknown>)['doGenerate'] === 'function'
}
