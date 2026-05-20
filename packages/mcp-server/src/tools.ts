import type { MemoryArtifactKind, TypeGraphContext, typegraphEventSink, typegraphInstance } from '@typegraph-ai/sdk'

// ── MCP Tool Definitions ──
// These define the tools that the MCP server exposes to AI agents.
// Each tool maps to the TypeGraph memory namespace.

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
      name: 'typegraph_memory_context',
      description: 'Return progressive agent memory context: memory_summary.md first, relevant MEMORY.md blocks, and optional structured recall.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Task or question to retrieve memory context for' },
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
          handbookLimit: { type: 'number', description: 'Max relevant MEMORY.md task groups. Default: 2' },
          includeStructuredRecall: { type: 'boolean', description: 'Also run structured memory recall' },
          types: { type: 'array', items: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] }, description: 'Structured recall memory types' },
          limit: { type: 'number', description: 'Structured recall limit' },
          format: { type: 'string', enum: ['xml', 'markdown', 'plain'], description: 'Structured recall output format' },
        },
        required: ['query'],
      },
    },
    {
      name: 'typegraph_memory_extract_thread',
      description: 'Extract reusable conversation memory from a stored thread into raw memory and rollout summary artifacts.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Thread identifier' },
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
          includeRoles: { type: 'array', items: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] }, description: 'Roles to include. Default excludes system' },
          maxTranscriptChars: { type: 'number', description: 'Maximum transcript characters sent to extraction' },
        },
        required: ['threadId'],
      },
    },
    {
      name: 'typegraph_memory_consolidate',
      description: 'Consolidate raw conversation memories into MEMORY.md, memory_summary.md, and phase_two_selection.json artifacts.',
      inputSchema: {
        type: 'object',
        properties: {
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
          maxRawMemories: { type: 'number', description: 'Maximum raw memory artifacts to consolidate' },
        },
      },
    },
    {
      name: 'typegraph_memory_artifact_get',
      description: 'Get a database-backed memory artifact by path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Artifact path such as memory_summary.md or MEMORY.md' },
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
        },
        required: ['path'],
      },
    },
    {
      name: 'typegraph_memory_artifact_list',
      description: 'List database-backed memory artifacts by layout, prefix, or kind.',
      inputSchema: {
        type: 'object',
        properties: {
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
          prefix: { type: 'string', description: 'Path prefix such as raw_memories or rollout_summaries' },
          kind: {
            oneOf: [
              { type: 'string', enum: ['summary', 'handbook', 'raw_memory', 'raw_memories', 'rollout_summary', 'phase_two_selection', 'skill', 'other'] },
              { type: 'array', items: { type: 'string', enum: ['summary', 'handbook', 'raw_memory', 'raw_memories', 'rollout_summary', 'phase_two_selection', 'skill', 'other'] } },
            ],
          },
        },
      },
    },
    {
      name: 'typegraph_memory_artifact_upsert',
      description: 'Create or replace a database-backed memory artifact.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['summary', 'handbook', 'raw_memory', 'raw_memories', 'rollout_summary', 'phase_two_selection', 'skill', 'other'] },
          content: { type: 'string' },
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'typegraph_memory_artifact_delete',
      description: 'Delete a database-backed memory artifact by path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          layoutId: { type: 'string', description: 'Memory artifact layout. Default: default' },
        },
        required: ['path'],
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
      name: 'typegraph_thread_add_turn',
      description: 'Add a turn to a TypeGraph thread. The turn is stored as a linked event.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Thread identifier' },
          role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
          content: { type: 'string' },
          url: { type: 'string', description: 'Canonical URL for the source turn or message' },
          timestamp: { type: 'string', description: 'Optional ISO timestamp' },
          metadata: { type: 'object', additionalProperties: true },
          graphExtraction: { type: 'boolean', description: 'Run configured graph extraction for this turn' },
        },
        required: ['threadId', 'role', 'content'],
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
 * Execute an MCP tool call against a TypeGraph instance.
 */
export interface MCPExecuteOptions {
  eventSink?: typegraphEventSink | undefined
  identity?: {
    tenantId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    threadId?: string | undefined
  } | undefined
  context?: TypeGraphContext | undefined
}

type MCPTypegraphTarget = Pick<
  typegraphInstance,
  'memory' | 'thread'
>

export async function executeTool(
  typegraph: MCPTypegraphTarget,
  toolName: string,
  args: Record<string, unknown>,
  opts: MCPExecuteOptions = {},
): Promise<unknown> {
  const { eventSink, identity, context } = opts
  const scoped = context ? { context } : undefined

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
        result = await typegraph.memory.remember(
          args['content'] as string,
          { ...scoped, category: (args['category'] as 'episodic' | 'semantic' | 'procedural') ?? 'semantic' },
        )
        break

      case 'typegraph_recall':
        result = await typegraph.memory.recall(args['query'] as string, {
          ...scoped,
          types: args['types'] as ('episodic' | 'semantic' | 'procedural')[] | undefined,
          limit: args['limit'] as number | undefined,
        })
        break

      case 'typegraph_recall_facts':
        result = await typegraph.memory.recall(args['query'] as string, {
          ...scoped,
          types: ['semantic'],
          limit: (args['limit'] as number) ?? 10,
        })
        break

      case 'typegraph_memory_context':
        result = await typegraph.memory.context(args['query'] as string, {
          ...scoped,
          layoutId: args['layoutId'] as string | undefined,
          handbookLimit: args['handbookLimit'] as number | undefined,
          includeStructuredRecall: args['includeStructuredRecall'] as boolean | undefined,
          types: args['types'] as ('episodic' | 'semantic' | 'procedural')[] | undefined,
          limit: args['limit'] as number | undefined,
          format: args['format'] as 'xml' | 'markdown' | 'plain' | undefined,
        })
        break

      case 'typegraph_memory_extract_thread':
        result = await typegraph.memory.extractThread(args['threadId'] as string, {
          ...scoped,
          layoutId: args['layoutId'] as string | undefined,
          includeRoles: args['includeRoles'] as Array<'user' | 'assistant' | 'tool' | 'system'> | undefined,
          maxTranscriptChars: args['maxTranscriptChars'] as number | undefined,
        })
        break

      case 'typegraph_memory_consolidate':
        result = await typegraph.memory.consolidate({
          ...scoped,
          layoutId: args['layoutId'] as string | undefined,
          maxRawMemories: args['maxRawMemories'] as number | undefined,
        })
        break

      case 'typegraph_memory_artifact_get':
        result = await typegraph.memory.artifacts.get(args['path'] as string, {
          ...scoped,
          layoutId: args['layoutId'] as string | undefined,
        })
        break

      case 'typegraph_memory_artifact_list':
        result = await typegraph.memory.artifacts.list({
          ...scoped,
          layoutId: args['layoutId'] as string | undefined,
          prefix: args['prefix'] as string | undefined,
          kind: args['kind'] as MemoryArtifactKind | MemoryArtifactKind[] | undefined,
        })
        break

      case 'typegraph_memory_artifact_upsert':
        result = await typegraph.memory.artifacts.upsert({
          path: args['path'] as string,
          content: args['content'] as string,
          ...(args['kind'] ? { kind: args['kind'] as MemoryArtifactKind } : {}),
          ...(args['layoutId'] ? { layoutId: args['layoutId'] as string } : {}),
          ...(args['metadata'] ? { metadata: args['metadata'] as Record<string, unknown> } : {}),
        }, scoped)
        break

      case 'typegraph_memory_artifact_delete':
        await typegraph.memory.artifacts.delete(args['path'] as string, {
          ...scoped,
          layoutId: args['layoutId'] as string | undefined,
        })
        result = { success: true }
        break

      case 'typegraph_forget':
        await typegraph.memory.forget(args['id'] as string, scoped)
        result = { success: true }
        break

      case 'typegraph_correct':
        result = await typegraph.memory.correct(args['correction'] as string, scoped)
        break

      case 'typegraph_thread_add_turn':
        result = await typegraph.thread.addTurn(
          args['threadId'] as string,
          {
            role: args['role'] as string,
            content: args['content'] as string,
            ...(args['url'] ? { url: args['url'] as string } : {}),
            ...(args['timestamp'] ? { timestamp: new Date(args['timestamp'] as string) } : {}),
            ...(args['metadata'] ? { metadata: args['metadata'] as Record<string, unknown> } : {}),
          },
          {
            ...scoped,
            ...(args['graphExtraction'] !== undefined ? { graphExtraction: Boolean(args['graphExtraction']) } : {}),
          },
        )
        break

      case 'typegraph_health_check':
        result = await typegraph.memory.healthCheck(scoped)
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
