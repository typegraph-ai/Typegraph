/**
 * Structural type for an LLM provider.
 * No imports from `@ai-sdk/*` - pure structural typing.
 * Any object matching this shape works (AI SDK models, custom implementations, test mocks).
 *
 * The provider must support structured JSON output for memory extraction.
 */
export interface LLMGenerateOptions {
  /**
   * Provider-specific options passed through to the underlying model.
   * Example: `{ openai: { reasoningEffort: 'high' } }`
   */
  providerOptions?: Record<string, Record<string, unknown>>

  /**
   * Maximum number of output tokens the model may generate.
   * When omitted, the model's default applies. generateJSON sets 16384
   * as a default to prevent truncation of structured output.
   */
  maxOutputTokens?: number
}

export interface LLMProvider {
  /**
   * Generate text from a prompt. Returns the raw text response.
   */
  generateText(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<string>

  /**
   * Generate structured JSON output from a prompt.
   * The provider should parse and return the JSON object.
   */
  generateJSON<T = unknown>(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<T>
}
