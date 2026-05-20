import { describe, expect, it, vi } from 'vitest'
import type { Embedder } from '../../embedding/provider.js'
import type { LLMProvider } from '../../types/llm-provider.js'
import { MemoryService } from '../service.js'
import type { MemoryArtifact, MemoryRecord } from '../types/memory.js'
import type { MemoryArtifactFilter, MemoryArtifactUpsertInput, MemoryStoreAdapter } from '../types/adapter.js'

const identity = { tenantId: 'tenant-1', graphId: 'memory:user:user-1', userId: 'user-1' }

function mockEmbedding(): Embedder {
  return {
    name: 'mock',
    dimensions: 3,
    embed: vi.fn(async input => input.texts.map(() => [1, 0, 0])),
  }
}

function artifactKey(artifact: Pick<MemoryArtifact, 'tenantId' | 'graphId' | 'layoutId' | 'path'>): string {
  return [artifact.tenantId, artifact.graphId, artifact.layoutId, artifact.path].join('|')
}

function mockStore() {
  const artifacts = new Map<string, MemoryArtifact>()
  const store: MemoryStoreAdapter = {
    initialize: vi.fn(),
    upsert: vi.fn(async record => record),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn(async () => []),
    search: vi.fn(async () => []),
    upsertArtifact: vi.fn(async (input: MemoryArtifactUpsertInput) => {
      const now = new Date('2026-05-20T00:00:00.000Z')
      const tenantId = input.identity.tenantId ?? 'public'
      const graphId = input.identity.graphId ?? 'public'
      const existing = artifacts.get([tenantId, graphId, input.layoutId, input.path].join('|'))
      const artifact: MemoryArtifact = {
        tenantId,
        graphId,
        layoutId: input.layoutId,
        path: input.path,
        kind: input.kind,
        content: input.content,
        contentHash: input.contentHash,
        metadata: input.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      artifacts.set(artifactKey(artifact), artifact)
      return artifact
    }),
    getArtifact: vi.fn(async (scope, layoutId, path) => {
      return artifacts.get([scope.tenantId ?? 'public', scope.graphId ?? 'public', layoutId, path].join('|')) ?? null
    }),
    listArtifacts: vi.fn(async (filter: MemoryArtifactFilter) => {
      const graphIds = filter.graphIds ?? filter.identity.graphIds ?? (filter.identity.graphId ? [filter.identity.graphId] : ['public'])
      const kinds = Array.isArray(filter.kind) ? filter.kind : filter.kind ? [filter.kind] : undefined
      return [...artifacts.values()].filter(artifact =>
        artifact.tenantId === (filter.identity.tenantId ?? 'public')
        && graphIds.includes(artifact.graphId)
        && (!filter.layoutId || artifact.layoutId === filter.layoutId)
        && (!filter.path || artifact.path === filter.path)
        && (!filter.prefix || artifact.path.startsWith(filter.prefix))
        && (!kinds || kinds.includes(artifact.kind))
      )
    }),
    deleteArtifact: vi.fn(async (scope, layoutId, path) => {
      artifacts.delete([scope.tenantId ?? 'public', scope.graphId ?? 'public', layoutId, path].join('|'))
    }),
  }
  return { store, artifacts }
}

function mockLLM(outputs: unknown[]): LLMProvider {
  return {
    generateText: vi.fn(async () => 'ok'),
    generateJSON: vi.fn(async () => {
      const output = outputs.shift()
      if (output instanceof Error) throw output
      return output
    }),
  }
}

describe('conversation memory artifacts', () => {
  it('extracts a filtered, redacted thread into raw and rollout artifacts', async () => {
    const { store } = mockStore()
    const llm = mockLLM([{
      conversation_summary: 'User wants OpenAI-style memory artifacts for TypeGraph.',
      conversation_slug: 'typegraph-memory-redesign',
      raw_memory: [
        'description: TypeGraph conversation memory redesign',
        'task: Implement OpenAI-inspired memory artifacts',
        'task_group: memory',
        'task_outcome: success',
        'keywords: typegraph, memory_summary.md, MEMORY.md',
        '',
        'Reusable knowledge: store artifacts in the memory database.',
      ].join('\n'),
      task_outcome: 'success',
      keywords: ['typegraph', 'memory_summary.md', 'MEMORY.md'],
      references: ['event:user-1'],
    }])
    const runtime = new MemoryService({ memoryStore: store, embedding: mockEmbedding(), llm })

    const result = await runtime.extractConversation({
      identity,
      conversationId: 'thread-1',
      messages: [
        { role: 'system', content: 'Do not persist this system instruction.' },
        { role: 'user', content: 'Use api_key=sk-abcdefghijklmnopqrstuvwxyz123456 for the test.' },
        { role: 'assistant', content: 'We should store markdown-like artifacts in Postgres.' },
      ],
    })

    const prompt = vi.mocked(llm.generateJSON).mock.calls[0]?.[0] ?? ''
    expect(prompt).not.toContain('Do not persist this system instruction')
    expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(prompt).toContain('[REDACTED_SECRET]')
    expect(result.noOp).toBe(false)
    expect(result.artifacts.rawMemory?.path).toBe('raw_memories/thread-1.md')
    expect(result.artifacts.rolloutSummary?.path).toBe('rollout_summaries/thread-1_typegraph-memory-redesign.md')
    expect(result.artifacts.rawMemories?.path).toBe('raw_memories.md')
    expect(result.artifacts.rawMemory?.metadata).toMatchObject({
      conversationId: 'thread-1',
      taskOutcome: 'success',
      keywords: ['typegraph', 'memory_summary.md', 'MEMORY.md'],
    })
  })

  it('treats malformed or no-signal extraction output as no-op', async () => {
    const { store } = mockStore()
    const runtime = new MemoryService({
      memoryStore: store,
      embedding: mockEmbedding(),
      llm: mockLLM([new Error('bad json')]),
    })

    const result = await runtime.extractConversation({
      identity,
      conversationId: 'thread-empty',
      messages: [{ role: 'user', content: 'thanks' }],
    })

    expect(result).toMatchObject({ noOp: true, keywords: [], artifacts: {} })
    expect(store.upsertArtifact).not.toHaveBeenCalled()
  })

  it('consolidates raw memories into handbook, summary, selection, and optional skills', async () => {
    const { store } = mockStore()
    const llm = mockLLM([{
      memory: '# Task Group: Memory\n\nscope: TypeGraph memory redesign tasks.\n\n## Reusable knowledge\n\n- Keep artifacts database-backed.',
      memory_summary: '## User Profile\n\nTypeGraph maintainer.\n\n## User preferences\n\n- Wants explicit APIs.\n\n## General Tips\n\n- Start with summary.\n\n## What\'s in Memory\n\n- Memory redesign.',
      skills: [{ name: 'memory-artifacts', content: '# Memory Artifacts\n\nUse database-backed Markdown artifacts.' }],
    }])
    const runtime = new MemoryService({ memoryStore: store, embedding: mockEmbedding(), llm })
    await runtime.upsertArtifact({
      path: 'raw_memories/thread-1.md',
      kind: 'raw_memory',
      content: 'description: Memory redesign\nkeywords: typegraph, memory\n\nStore DB artifacts.',
      metadata: { conversationId: 'thread-1', rolloutSummaryFile: 'rollout_summaries/thread-1_memory.md' },
    }, { identity })

    const result = await runtime.consolidate({ identity })

    expect(result.selected).toBe(1)
    expect(result.artifacts.handbook.path).toBe('MEMORY.md')
    expect(result.artifacts.summary.path).toBe('memory_summary.md')
    expect(result.artifacts.phaseTwoSelection.path).toBe('phase_two_selection.json')
    expect(await runtime.getArtifact('skills/memory-artifacts/SKILL.md', { identity })).toMatchObject({
      kind: 'skill',
      content: expect.stringContaining('database-backed Markdown artifacts'),
    })
  })

  it('builds progressive context from summary, relevant handbook blocks, and optional structured recall', async () => {
    const { store } = mockStore()
    const memory: MemoryRecord = {
      id: 'mem-1',
      graphId: identity.graphId,
      category: 'semantic',
      status: 'active',
      content: 'Artifacts are canonical in the database.',
      importance: 0.7,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: {},
      scope: identity,
      validAt: new Date(),
      createdAt: new Date(),
    }
    vi.mocked(store.search).mockResolvedValue([memory])
    const runtime = new MemoryService({ memoryStore: store, embedding: mockEmbedding(), llm: mockLLM([]) })
    await runtime.upsertArtifact({
      path: 'memory_summary.md',
      content: '## What\'s in Memory\n\n- TypeGraph memory artifacts.',
    }, { identity })
    await runtime.upsertArtifact({
      path: 'MEMORY.md',
      content: [
        '# Task Group: Memory artifacts',
        '',
        'scope: Use for pgvector artifact storage and TypeGraph memory context.',
        '',
        '# Task Group: Billing',
        '',
        'scope: Unrelated billing work.',
        '',
      ].join('\n'),
    }, { identity })

    const result = await runtime.context('pgvector artifact context', {
      identity,
      includeStructuredRecall: true,
      handbookLimit: 1,
    })

    expect(result.prompt).toContain('## Memory Summary')
    expect(result.handbook).toContain('Memory artifacts')
    expect(result.handbook).not.toContain('Billing')
    expect(result.recall).toEqual([memory])
    expect(result.artifacts.map(artifact => artifact.path)).toEqual(['memory_summary.md', 'MEMORY.md'])
  })
})
