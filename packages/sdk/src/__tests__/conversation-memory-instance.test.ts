import { describe, expect, it, vi } from 'vitest'
import { typegraphInit } from '../typegraph.js'
import type { LLMProvider } from '../types/llm-provider.js'
import type { MemoryArtifact, MemoryRecord } from '../memory/types/memory.js'
import type { MemoryArtifactFilter, MemoryArtifactUpsertInput, MemoryStoreAdapter } from '../memory/types/adapter.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'

function artifactKey(artifact: Pick<MemoryArtifact, 'tenantId' | 'graphId' | 'layoutId' | 'path'>): string {
  return [artifact.tenantId, artifact.graphId, artifact.layoutId, artifact.path].join('|')
}

function createMemoryStore(): MemoryStoreAdapter {
  const artifacts = new Map<string, MemoryArtifact>()
  return {
    initialize: vi.fn(),
    upsert: vi.fn(async record => record),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn(async () => []),
    search: vi.fn(async () => [] as MemoryRecord[]),
    upsertArtifact: vi.fn(async (input: MemoryArtifactUpsertInput) => {
      const now = new Date('2026-05-20T00:00:00.000Z')
      const artifact: MemoryArtifact = {
        tenantId: input.identity.tenantId ?? 'public',
        graphId: input.identity.graphId ?? 'public',
        layoutId: input.layoutId,
        path: input.path,
        kind: input.kind,
        content: input.content,
        contentHash: input.contentHash,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      }
      artifacts.set(artifactKey(artifact), artifact)
      return artifact
    }),
    getArtifact: vi.fn(async (identity, layoutId, path) => {
      return artifacts.get([identity.tenantId ?? 'public', identity.graphId ?? 'public', layoutId, path].join('|')) ?? null
    }),
    listArtifacts: vi.fn(async (filter: MemoryArtifactFilter) => {
      const graphIds = filter.graphIds ?? filter.identity.graphIds ?? (filter.identity.graphId ? [filter.identity.graphId] : ['public'])
      const kinds = Array.isArray(filter.kind) ? filter.kind : filter.kind ? [filter.kind] : undefined
      return [...artifacts.values()].filter(artifact =>
        artifact.tenantId === (filter.identity.tenantId ?? 'public')
        && graphIds.includes(artifact.graphId)
        && (!filter.layoutId || artifact.layoutId === filter.layoutId)
        && (!filter.prefix || artifact.path.startsWith(filter.prefix))
        && (!filter.path || artifact.path === filter.path)
        && (!kinds || kinds.includes(artifact.kind))
      )
    }),
    deleteArtifact: vi.fn(async (identity, layoutId, path) => {
      artifacts.delete([identity.tenantId ?? 'public', identity.graphId ?? 'public', layoutId, path].join('|'))
    }),
  }
}

function createLLM(): LLMProvider {
  return {
    generateText: vi.fn(async () => 'ok'),
    generateJSON: vi.fn(async (prompt: string) => {
      if (prompt.includes('Filtered transcript JSONL')) {
        return {
          conversation_summary: 'Conversation established that TypeGraph needs database-backed memory artifacts.',
          conversation_slug: 'typegraph-memory-artifacts',
          raw_memory: [
            'description: TypeGraph memory artifacts',
            'task: Add conversation memory artifacts',
            'task_group: memory',
            'task_outcome: success',
            'keywords: typegraph, memory artifacts, context',
            '',
            'Reusable knowledge: use memory_summary.md before opening MEMORY.md details.',
          ].join('\n'),
          task_outcome: 'success',
          keywords: ['typegraph', 'memory artifacts', 'context'],
          references: ['thread-1'],
        }
      }
      return {
        memory: '# Task Group: TypeGraph memory artifacts\n\nscope: Use for TypeGraph memory artifact APIs and progressive context.\n\n## Reusable knowledge\n\n- Database artifacts are canonical.',
        memory_summary: '## User Profile\n\nTypeGraph user.\n\n## User preferences\n\n- Wants explicit APIs.\n\n## General Tips\n\n- Start with memory_summary.md.\n\n## What\'s in Memory\n\n- TypeGraph memory artifacts.',
      }
    }),
  }
}

describe('typegraph conversation memory integration', () => {
  it('captures thread turns, extracts, consolidates, and returns progressive context', async () => {
    const adapter = createMockAdapter()
    const memoryStore = createMemoryStore()
    Object.assign(adapter, { createMemoryStore: () => memoryStore })
    const instance = await typegraphInit({
      vectorStore: adapter,
      embedding: createMockEmbedding(),
      llm: createLLM(),
      tenantId: 'tenant-1',
    })
    const context = { userId: 'user-1' }

    await instance.thread.addTurn('thread-1', {
      role: 'user',
      content: 'Please add database-backed memory artifacts and a context API.',
    }, { context })
    await instance.thread.addTurn('thread-1', {
      role: 'assistant',
      content: 'Implemented extraction, consolidation, and progressive context.',
    }, { context })
    const extraction = await instance.memory.extractThread('thread-1', { context })
    const consolidation = await instance.memory.consolidate({ context })
    const memoryContext = await instance.memory.context('TypeGraph memory artifact context', { context })

    expect(extraction.noOp).toBe(false)
    expect(extraction.artifacts.rawMemory?.path).toBe('raw_memories/thread-1.md')
    expect(consolidation.artifacts.summary.path).toBe('memory_summary.md')
    expect(memoryContext.prompt).toContain('## Memory Summary')
    expect(memoryContext.handbook).toContain('TypeGraph memory artifacts')
  })
})
