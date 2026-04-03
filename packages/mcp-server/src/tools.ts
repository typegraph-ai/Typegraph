import type { d8umMemory } from '@d8um-ai/graph'

// ── MCP Tool Definitions ──
// These define the tools that the MCP server exposes to AI agents.
// Each tool maps to a d8umMemory method.

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export function getToolDefinitions(): MCPToolDefinition[] {
  return [
    {
      name: 'd8um_remember',
      description: 'Store a memory. Accepts text content and an optional category (episodic, semantic, procedural).',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content to store' },
          category: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], description: 'Memory category. Default: semantic' },
        },
        required: ['content'],
      },
    },
    {
      name: 'd8um_recall',
      description: 'Search memories by semantic similarity. Returns the most relevant memories.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          types: { type: 'array', items: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] }, description: 'Filter by memory types' },
          limit: { type: 'number', description: 'Max results. Default: 10' },
        },
        required: ['query'],
      },
    },
    {
      name: 'd8um_recall_facts',
      description: 'Search specifically for semantic facts (extracted knowledge).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results. Default: 10' },
        },
        required: ['query'],
      },
    },
    {
      name: 'd8um_forget',
      description: 'Invalidate a memory by ID. The memory is preserved but marked as invalid.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory ID to invalidate' },
        },
        required: ['id'],
      },
    },
    {
      name: 'd8um_correct',
      description: 'Apply a natural language correction to memories. Example: "Actually, John works at Acme, not Beta Inc"',
      inputSchema: {
        type: 'object',
        properties: {
          correction: { type: 'string', description: 'Natural language correction' },
        },
        required: ['correction'],
      },
    },
    {
      name: 'd8um_add_conversation',
      description: 'Ingest conversation messages into memory. Extracts episodic and semantic memories.',
      inputSchema: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
                content: { type: 'string' },
              },
              required: ['role', 'content'],
            },
            description: 'Conversation messages to ingest',
          },
          sessionId: { type: 'string', description: 'Optional session identifier' },
        },
        required: ['messages'],
      },
    },
  ]
}

/**
 * Execute an MCP tool call against a d8umMemory instance.
 */
export async function executeTool(
  memory: d8umMemory,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case 'd8um_remember':
      return memory.remember(
        args['content'] as string,
        (args['category'] as 'episodic' | 'semantic' | 'procedural') ?? 'semantic',
      )

    case 'd8um_recall':
      return memory.recall(args['query'] as string, {
        types: args['types'] as ('episodic' | 'semantic' | 'procedural')[] | undefined,
        limit: args['limit'] as number | undefined,
      })

    case 'd8um_recall_facts':
      return memory.recallFacts(
        args['query'] as string,
        (args['limit'] as number) ?? 10,
      )

    case 'd8um_forget':
      await memory.forget(args['id'] as string)
      return { success: true }

    case 'd8um_correct':
      return memory.correct(args['correction'] as string)

    case 'd8um_add_conversation':
      return memory.addConversationTurn(
        args['messages'] as { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[],
        args['sessionId'] as string | undefined,
      )

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}
