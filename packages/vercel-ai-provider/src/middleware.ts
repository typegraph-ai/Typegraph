import type { TypegraphMemory } from '@typegraph-ai/sdk'

// ── Middleware ──
// Structural type matching Vercel AI SDK's middleware pattern.
// No imports from `ai` or `@ai-sdk/*`.

export interface MemoryMiddlewareOpts {
  /** Include semantic facts. Default: true */
  includeFacts?: boolean | undefined
  /** Include episodic memories. Default: false */
  includeEpisodes?: boolean | undefined
  /** Include procedural memories. Default: false */
  includeProcedures?: boolean | undefined
  /** Maximum number of memories to recall. Default: 10 */
  limit?: number | undefined
  /** Output format. Default: 'xml' */
  format?: 'xml' | 'markdown' | 'plain' | undefined
}

function typesFor(opts: MemoryMiddlewareOpts): ('semantic' | 'episodic' | 'procedural')[] {
  const types: ('semantic' | 'episodic' | 'procedural')[] = []
  if (opts.includeFacts !== false) types.push('semantic')
  if (opts.includeEpisodes) types.push('episodic')
  if (opts.includeProcedures) types.push('procedural')
  return types
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
  const types = typesFor(opts)
  const format = opts.format ?? 'xml'
  const limit = opts.limit ?? 10

  return {
    async enrichPrompt(prompt: string): Promise<string> {
      if (types.length === 0) return prompt
      const context = await memory.recall(prompt, { types, limit, format })
      if (!context) return prompt
      return `${context}\n\n${prompt}`
    },

    async enrichSystem(systemPrompt: string, userQuery: string): Promise<string> {
      if (types.length === 0) return systemPrompt
      const context = await memory.recall(userQuery, { types, limit, format })
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
