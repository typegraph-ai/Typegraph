import { generateText } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { typegraphMemoryTools, typegraphTools, type TypegraphToolName, type TypegraphToolsTarget } from '../provider.js'

const TOOL_NAMES: TypegraphToolName[] = [
  'typegraph_buckets_list',
  'typegraph_buckets_get',
  'typegraph_buckets_create',
  'typegraph_source_ingest',
  'typegraph_query',
  'typegraph_memory_remember',
  'typegraph_memory_correct',
  'typegraph_jobs_list',
  'typegraph_jobs_get',
]

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }
}

function createTarget(): TypegraphToolsTarget {
  return {
    buckets: {
      create: vi.fn(async input => ({ id: 'bkt_1', status: 'active', ...input })),
      get: vi.fn(async id => ({ id, name: 'Docs', status: 'active', tenantId: 'tenant-1', userId: 'user-1' })),
      list: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ingest: vi.fn(async (_sources, opts) => ({
      bucketId: opts?.bucketId ?? 'bkt_default',
      tenantId: opts?.tenantId,
      mode: opts?.mode ?? 'upsert',
      total: 1,
      skipped: 0,
      updated: 0,
      inserted: 1,
      durationMs: 1,
      status: 'complete' as const,
    })),
    query: vi.fn(async (text, opts) => ({
      results: { chunks: [], facts: [], entities: [], memories: [] },
      buckets: {},
      query: {
        text,
        tenantId: opts?.tenantId,
        durationMs: 1,
        mergeStrategy: 'test',
      },
    })),
    remember: vi.fn(async (content, opts) => ({
      id: 'mem_1',
      category: opts?.category ?? 'semantic',
      status: 'active',
      content,
      importance: opts?.importance ?? 0.5,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: opts?.metadata ?? {},
      scope: { tenantId: opts?.tenantId, userId: opts?.userId },
      validAt: new Date(),
      createdAt: new Date(),
    })),
    correct: vi.fn(async () => ({ invalidated: 1, created: 1, summary: 'ok' })),
    jobs: {
      get: vi.fn(async id => ({
        id,
        status: 'complete',
        type: 'ingest',
        identity: { tenantId: 'tenant-1', userId: 'user-1' },
        createdAt: new Date(),
      })),
      list: vi.fn(async () => []),
      upsert: vi.fn(),
      updateStatus: vi.fn(),
      incrementProgress: vi.fn(),
    },
  } as unknown as TypegraphToolsTarget
}

describe('typegraphTools', () => {
  it('returns the expected AI SDK v6 tool names and schemas', async () => {
    const target = createTarget()
    const tools = typegraphTools(target)

    expect(Object.keys(tools)).toEqual(TOOL_NAMES)
    for (const name of TOOL_NAMES) {
      expect(tools[name].inputSchema).toHaveProperty('jsonSchema')
      expect(tools[name].execute).toBeTypeOf('function')
    }

    let providerToolNames: string[] = []
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        providerToolNames = options.tools?.map(tool => tool.name) ?? []
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    await generateText({
      model,
      tools,
      prompt: 'hello',
    })

    expect(providerToolNames).toEqual(TOOL_NAMES)
  })

  it('merges trusted identity into scoped bucket, ingest, query, memory, and job calls', async () => {
    const target = createTarget()
    const tools = typegraphTools(target, {
      identity: { tenantId: 'tenant-1', userId: 'user-1', conversationId: 'conv-1' },
    })

    await (tools.typegraph_buckets_list.execute as any)({ pagination: { limit: 10 } })
    expect(target.buckets.list).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1', conversationId: 'conv-1' },
      { limit: 10 },
    )

    await (tools.typegraph_buckets_create.execute as any)({ name: 'Docs' })
    expect(target.buckets.create).toHaveBeenCalledWith({
      name: 'Docs',
      tenantId: 'tenant-1',
      userId: 'user-1',
      conversationId: 'conv-1',
    })

    await (tools.typegraph_source_ingest.execute as any)({
      source: {
        content: 'Hello',
        title: 'Greeting',
        updatedAt: '2026-01-01T00:00:00.000Z',
        subject: {
          externalIds: [{ type: 'document_id', id: 'doc-1' }],
          name: 'Greeting Doc',
        },
      },
      options: { bucketId: 'bkt_1', visibility: 'user' },
    })
    expect(target.ingest).toHaveBeenCalledWith(
      [expect.objectContaining({
        title: 'Greeting',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        subject: expect.objectContaining({
          externalIds: [{ type: 'document_id', id: 'doc-1' }],
        }),
      })],
      {
        bucketId: 'bkt_1',
        visibility: 'user',
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationId: 'conv-1',
      },
    )

    await (tools.typegraph_query.execute as any)({
      text: 'find Alice',
      options: {
        entityScope: {
          externalIds: [{ type: 'email', id: 'alice@example.com' }],
          mode: 'filter',
        },
        sourceFilter: { bucketId: 'bkt_1' },
      },
    })
    expect(target.query).toHaveBeenCalledWith('find Alice', {
      entityScope: {
        externalIds: [{ type: 'email', id: 'alice@example.com' }],
        mode: 'filter',
      },
      sourceFilter: {
        bucketId: 'bkt_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationId: 'conv-1',
      },
      tenantId: 'tenant-1',
      userId: 'user-1',
      conversationId: 'conv-1',
    })

    await (tools.typegraph_memory_remember.execute as any)({
      content: 'Alice prefers vegetarian meals.',
      subject: { externalIds: [{ type: 'email', id: 'alice@example.com' }], name: 'Alice' },
      visibility: 'user',
    })
    expect(target.remember).toHaveBeenCalledWith('Alice prefers vegetarian meals.', {
      subject: { externalIds: [{ type: 'email', id: 'alice@example.com' }], name: 'Alice' },
      visibility: 'user',
      tenantId: 'tenant-1',
      userId: 'user-1',
      conversationId: 'conv-1',
    })

    await (tools.typegraph_jobs_list.execute as any)({ filter: { status: 'complete' } })
    expect(target.jobs.list).toHaveBeenCalledWith({
      status: 'complete',
      identity: { tenantId: 'tenant-1', userId: 'user-1', conversationId: 'conv-1' },
    })
  })

  it('rejects direct lookups outside the configured identity scope', async () => {
    const target = createTarget()
    vi.mocked(target.jobs.get).mockResolvedValueOnce({
      id: 'job_1',
      status: 'complete',
      type: 'ingest',
      identity: { tenantId: 'other-tenant' },
      createdAt: new Date(),
    })

    const tools = typegraphTools(target, { identity: { tenantId: 'tenant-1' } })

    await expect((tools.typegraph_jobs_get.execute as any)({ jobId: 'job_1' }))
      .rejects
      .toThrow('outside the configured TypeGraph identity scope')
  })
})

describe('typegraphMemoryTools', () => {
  it('returns the scoped memory tool subset', () => {
    const target = createTarget()
    const tools = typegraphMemoryTools(target, { identity: { tenantId: 'tenant-1' } })

    expect(Object.keys(tools)).toEqual([
      'typegraph_memory_remember',
      'typegraph_memory_correct',
    ])
  })
})
