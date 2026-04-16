import type { TypegraphMemory } from '@typegraph-ai/sdk'

// ── Middleware ──
// Structural type matching Vercel AI SDK's middleware pattern.
// No imports from `ai` or `@ai-sdk/*`.

export interface MemoryMiddlewareOpts {
  /** Include working memory in context. Default: true */
  includeWorking?: boolean | undefined
  /** Include semantic facts. Default: true */
  includeFacts?: boolean | undefined
  /** Include episodic memories. Default: false */
  includeEpisodes?: boolean | undefined
  /** Include procedural memories. Default: false */
  includeProcedures?: boolean | undefined
  /** Maximum tokens for memory context. Default: 2000 */
  maxMemoryTokens?: number | undefined
  /** Output format. Default: 'xml' */
  format?: 'xml' | 'markdown' | 'plain' | undefined
}

/**
 * Create middleware that auto-injects memory context into LLM prompts.
 *
 * Returns a function that takes a prompt string and prepends memory context.
 * Compatible with Vercel AI SDK's middleware pattern.
 *
 * @example
 * ```ts
 * const middleware = typegraphMemoryMiddleware(memory)
 * const enrichedPrompt = await middleware.enrichPrompt('What should Alice have for dinner?')
 * ```
 */
export function typegraphMemoryMiddleware(memory: TypegraphMemory, opts: MemoryMiddlewareOpts = {}) {
  return {
    /**
     * Enrich a prompt with memory context.
     */
    async enrichPrompt(prompt: string): Promise<string> {
      const context = await memory.assembleContext(prompt, {
        includeWorking: opts.includeWorking,
        includeFacts: opts.includeFacts,
        includeEpisodes: opts.includeEpisodes,
        includeProcedures: opts.includeProcedures,
        maxMemoryTokens: opts.maxMemoryTokens,
        format: opts.format,
      })

      if (!context) return prompt
      return `${context}\n\n${prompt}`
    },

    /**
     * Enrich a system prompt with memory context.
     */
    async enrichSystem(systemPrompt: string, userQuery: string): Promise<string> {
      const context = await memory.assembleContext(userQuery, {
        includeWorking: opts.includeWorking,
        includeFacts: opts.includeFacts,
        includeEpisodes: opts.includeEpisodes,
        includeProcedures: opts.includeProcedures,
        maxMemoryTokens: opts.maxMemoryTokens,
        format: opts.format,
      })

      if (!context) return systemPrompt
      return `${systemPrompt}\n\n${context}`
    },

    /**
     * After a response, ingest the conversation turn into memory.
     */
    async afterResponse(
      messages: { role: 'user' | 'assistant'; content: string }[],
      conversationId?: string,
    ): Promise<void> {
      await memory.addConversationTurn(messages, conversationId)
    },
  }
}
