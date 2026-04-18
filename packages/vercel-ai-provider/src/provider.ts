import type { TypegraphMemory } from '@typegraph-ai/sdk'

// ── Tool Definition ──
// Structural type matching Vercel AI SDK's tool definition pattern.
// No imports from `ai` or `@ai-sdk/*` - pure structural typing.

export interface ToolDefinition {
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Generate Vercel AI SDK-compatible tool definitions from a TypegraphMemory instance.
 *
 * Usage with Vercel AI SDK:
 * ```ts
 * import { generateText } from 'ai'
 * import { typegraphMemoryTools } from '@typegraph-ai/vercel-ai-provider'
 *
 * const tools = typegraphMemoryTools(memory)
 * const { text } = await generateText({
 *   model: openai('gpt-4o'),
 *   tools,
 *   prompt: 'What do you know about Alice?',
 * })
 * ```
 */
export function typegraphMemoryTools(memory: TypegraphMemory): Record<string, ToolDefinition> {
  return {
    remember: {
      description: 'Store a memory for future recall',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Memory content to store' },
          category: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
        },
        required: ['content'],
      },
      execute: async (args) => {
        return memory.remember(args['content'] as string, {
          category: (args['category'] as 'semantic' | 'episodic' | 'procedural' | undefined) ?? 'semantic',
        })
      },
    },

    recall: {
      description: 'Search memories by semantic similarity',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const results = await memory.recall(args['query'] as string, {
          limit: (args['limit'] as number) ?? 10,
        })
        return results.map(r => ({ content: r.content, category: r.category, importance: r.importance }))
      },
    },

    recallFacts: {
      description: 'Search for known facts',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const facts = await memory.recallFacts(args['query'] as string, (args['limit'] as number) ?? 10)
        return facts.map(f => ({ content: f.content, subject: f.subject, predicate: f.predicate, object: f.object }))
      },
    },

    correct: {
      description: 'Correct a memory using natural language',
      parameters: {
        type: 'object',
        properties: {
          correction: { type: 'string', description: 'Natural language correction' },
        },
        required: ['correction'],
      },
      execute: async (args) => {
        return memory.correct(args['correction'] as string)
      },
    },
  }
}
