import type { TypeGraphContext, typegraphInstance } from '@typegraph-ai/sdk'

// ── Middleware ──
// Structural type matching Vercel AI SDK's middleware pattern.
// No imports from `ai` or `@ai-sdk/*`.

export interface MemoryMiddlewareOpts {
  /** Trusted request context merged into recall and turn capture calls. */
  context?: TypeGraphContext | undefined
  /** Run graph extraction when captured turns are stored. Default: false */
  graphExtraction?: boolean | undefined
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
  /** Opt-in conversation artifact extraction and consolidation after turns are captured. */
  conversationMemory?: {
    enabled?: boolean | undefined
    mode?: 'extract' | 'extract_and_consolidate' | undefined
    layoutId?: string | undefined
    includeRoles?: Array<'user' | 'assistant' | 'tool' | 'system'> | undefined
    maxTranscriptChars?: number | undefined
    maxRawMemories?: number | undefined
  } | undefined
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
export function typegraphMemoryMiddleware(typegraph: Pick<typegraphInstance, 'memory' | 'thread'>, opts: MemoryMiddlewareOpts = {}) {
  const types = typesFor(opts)
  const format = opts.format ?? 'xml'
  const limit = opts.limit ?? 10

  return {
    async enrichPrompt(prompt: string): Promise<string> {
      if (types.length === 0) return prompt
      const context = await typegraph.memory.recall(prompt, { context: opts.context, types, limit, format })
      if (!context) return prompt
      return `${context}\n\n${prompt}`
    },

    async enrichSystem(systemPrompt: string, userQuery: string): Promise<string> {
      if (types.length === 0) return systemPrompt
      const context = await typegraph.memory.recall(userQuery, { context: opts.context, types, limit, format })
      if (!context) return systemPrompt
      return `${systemPrompt}\n\n${context}`
    },

    /**
     * After a response, ingest the thread turn into memory.
     */
    async afterResponse(
      messages: { role: 'user' | 'assistant' | 'tool' | 'system'; content: string }[],
      threadId?: string,
    ): Promise<void> {
      const resolvedThreadId = threadId ?? opts.context?.threadId
      if (!resolvedThreadId) {
        throw new Error('typegraphMemoryMiddleware.afterResponse requires a threadId argument or opts.context.threadId.')
      }
      for (const message of messages) {
        await typegraph.thread.addTurn(String(resolvedThreadId), {
          role: message.role,
          content: message.content,
        }, {
          context: opts.context,
          graphExtraction: opts.graphExtraction,
        })
      }
      const conversationMemory = opts.conversationMemory
      if (conversationMemory?.enabled) {
        await typegraph.memory.extractThread(String(resolvedThreadId), {
          context: opts.context,
          layoutId: conversationMemory.layoutId,
          includeRoles: conversationMemory.includeRoles,
          maxTranscriptChars: conversationMemory.maxTranscriptChars,
        })
        if (conversationMemory.mode === 'extract_and_consolidate') {
          await typegraph.memory.consolidate({
            context: opts.context,
            layoutId: conversationMemory.layoutId,
            maxRawMemories: conversationMemory.maxRawMemories,
          })
        }
      }
    },
  }
}
