import { generateText } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { typegraphMemoryTools, typegraphTools, type TypegraphToolName, type TypegraphToolsTarget } from '../provider.js'

const TOOL_NAMES: TypegraphToolName[] = [
  'typegraph_buckets_list',
  'typegraph_buckets_get',
  'typegraph_buckets_create',
  'typegraph_document_ingest',
  'typegraph_search',
  'typegraph_remember',
  'typegraph_correct',
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
    bucket: {
      create: vi.fn(async input => ({ id: 'bkt_1', status: 'active', ...input })),
      get: vi.fn(async id => ({ id, name: 'Docs', status: 'active', tenantId: 'tenant-1', userId: 'user-1' })),
      list: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    document: {
      ingest: vi.fn(async (_documents, opts) => ({
      bucketId: opts?.bucketId ?? 'bkt_default',
      mode: opts?.mode ?? 'upsert',
      total: 1,
      skipped: 0,
      updated: 0,
      inserted: 1,
      durationMs: 1,
      status: 'complete' as const,
    })),
      ingestPreChunked: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    search: vi.fn(async (text, opts) => ({
      results: { chunks: [], facts: [], entities: [] },
      buckets: {},
      query: {
        text,
        durationMs: 1,
        mergeStrategy: 'test',
      },
    })),
    memory: {
      remember: vi.fn(async (content, opts) => ({
        id: 'mem_1',
        category: opts?.category ?? 'semantic',
        status: 'active',
        content,
        importance: opts?.importance ?? 0.5,
        accessCount: 0,
        lastAccessedAt: new Date(),
        metadata: opts?.metadata ?? {},
        scope: { tenantId: 'tenant-1', userId: opts?.context?.userId },
        validAt: new Date(),
        createdAt: new Date(),
      })),
      correct: vi.fn(async () => ({ invalidated: 1, created: 1, summary: 'ok' })),
      recall: vi.fn(),
      forget: vi.fn(),
      healthCheck: vi.fn(),
    },
    job: {
      get: vi.fn(async id => ({
        id,
        status: 'complete',
        type: 'ingest',
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

  it('merges trusted context into scoped bucket, ingest, search, and memory calls', async () => {
    const target = createTarget()
    const tools = typegraphTools(target, {
      context: { userId: 'user-1', threadId: 'thread-1' },
    })

    await (tools.typegraph_buckets_list.execute as any)({ pagination: { limit: 10 } })
    expect(target.bucket.list).toHaveBeenCalledWith(
      {},
      { context: { userId: 'user-1', threadId: 'thread-1' } },
      { limit: 10 },
    )

    await (tools.typegraph_buckets_create.execute as any)({ name: 'Docs' })
    expect(target.bucket.create).toHaveBeenCalledWith(
      { name: 'Docs' },
      { context: { userId: 'user-1', threadId: 'thread-1' } },
    )

    await (tools.typegraph_document_ingest.execute as any)({
      document: {
        content: 'Hello',
        name: 'Greeting',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      options: { bucketId: 'bkt_1' },
    })
    expect(target.document.ingest).toHaveBeenCalledWith(
      [expect.objectContaining({
        name: 'Greeting',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })],
      {
        bucketId: 'bkt_1',
        context: { userId: 'user-1', threadId: 'thread-1' },
      },
    )

    await (tools.typegraph_search.execute as any)({
      text: 'find Alice',
      options: {
        resources: ['documents', 'facts'],
        weights: { semantic: 1, bm25: false },
        entityScope: {
          externalIds: [{ type: 'email', id: 'alice@example.com' }],
          mode: 'filter',
        },
        buckets: ['bkt_1'],
      },
    })
    expect(target.search).toHaveBeenCalledWith('find Alice', {
      resources: ['documents', 'facts'],
      weights: { semantic: 1, bm25: false },
      entityScope: {
        externalIds: [{ type: 'email', id: 'alice@example.com' }],
        mode: 'filter',
      },
      buckets: ['bkt_1'],
      context: { userId: 'user-1', threadId: 'thread-1' },
    })

    await (tools.typegraph_remember.execute as any)({
      content: 'Alice prefers vegetarian meals.',
      subject: { externalIds: [{ type: 'email', id: 'alice@example.com' }], name: 'Alice' },
    })
    expect(target.memory.remember).toHaveBeenCalledWith('Alice prefers vegetarian meals.', {
      subject: { externalIds: [{ type: 'email', id: 'alice@example.com' }], name: 'Alice' },
      context: { userId: 'user-1', threadId: 'thread-1' },
    })

    await (tools.typegraph_jobs_list.execute as any)({ filter: { status: 'complete' } })
    expect(target.job.list).toHaveBeenCalledWith({
      status: 'complete',
    })
  })

  it('rejects direct lookups outside the configured context', async () => {
    const target = createTarget()
    vi.mocked(target.job.get).mockResolvedValueOnce({
      id: 'job_1',
      status: 'complete',
      type: 'ingest',
      identity: { userId: 'other-user' },
      createdAt: new Date(),
    })

    const tools = typegraphTools(target, { context: { userId: 'user-1' } })

    await expect((tools.typegraph_jobs_get.execute as any)({ jobId: 'job_1' }))
      .rejects
      .toThrow('outside the configured TypeGraph context')
  })
})

describe('typegraphMemoryTools', () => {
  it('returns the scoped memory tool subset', () => {
    const target = createTarget()
    const tools = typegraphMemoryTools(target.memory, { context: { userId: 'user-1' } })

    expect(Object.keys(tools)).toEqual([
      'typegraph_remember',
      'typegraph_correct',
    ])
  })
})
