import type { TypegraphMemory, typegraphEventSink } from '@typegraph-ai/sdk'

// ── MCP Tool Definitions ──
// These define the tools that the MCP server exposes to AI agents.
// Each tool maps to a TypegraphMemory method.

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export function getToolDefinitions(): MCPToolDefinition[] {
  return [
    {
      name: 'typegraph_remember',
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
      name: 'typegraph_recall',
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
      name: 'typegraph_recall_facts',
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
      name: 'typegraph_forget',
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
      name: 'typegraph_correct',
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
      name: 'typegraph_add_conversation',
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
          conversationId: { type: 'string', description: 'Optional session identifier' },
        },
        required: ['messages'],
      },
    },
    {
      name: 'typegraph_health_check',
      description: 'Check the health and statistics of the memory system. Returns precision, staleness, entity/edge counts.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ]
}

/**
 * Execute an MCP tool call against a TypegraphMemory instance.
 */
export async function executeTool(
  memory: TypegraphMemory,
  toolName: string,
  args: Record<string, unknown>,
  eventSink?: typegraphEventSink,
): Promise<unknown> {
  const identity = memory.identity

  if (eventSink && identity) {
    eventSink.emit({
      id: crypto.randomUUID(),
      eventType: 'tool.call',
      identity,
      payload: { toolName, args },
      timestamp: new Date(),
    })
  }

  const t0 = Date.now()

  try {
    let result: unknown
    switch (toolName) {
      case 'typegraph_remember':
        result = await memory.remember(
          args['content'] as string,
          (args['category'] as 'episodic' | 'semantic' | 'procedural') ?? 'semantic',
        )
        break

      case 'typegraph_recall':
        result = await memory.recall(args['query'] as string, {
          types: args['types'] as ('episodic' | 'semantic' | 'procedural')[] | undefined,
          limit: args['limit'] as number | undefined,
        })
        break

      case 'typegraph_recall_facts':
        result = await memory.recallFacts(
          args['query'] as string,
          (args['limit'] as number) ?? 10,
        )
        break

      case 'typegraph_forget':
        await memory.forget(args['id'] as string)
        result = { success: true }
        break

      case 'typegraph_correct':
        result = await memory.correct(args['correction'] as string)
        break

      case 'typegraph_add_conversation':
        result = await memory.addConversationTurn(
          args['messages'] as { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[],
          args['conversationId'] as string | undefined,
        )
        break

      case 'typegraph_health_check':
        result = await memory.healthCheck()
        break

      default:
        throw new Error(`Unknown tool: ${toolName}`)
    }

    if (eventSink && identity) {
      eventSink.emit({
        id: crypto.randomUUID(),
        eventType: 'tool.result',
        identity,
        payload: { toolName, success: true },
        durationMs: Date.now() - t0,
        timestamp: new Date(),
      })
    }

    return result
  } catch (err) {
    if (eventSink && identity) {
      eventSink.emit({
        id: crypto.randomUUID(),
        eventType: 'tool.result',
        identity,
        payload: { toolName, success: false, error: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - t0,
        timestamp: new Date(),
      })
    }
    throw err
  }
}
