import { describe, expect, it, vi } from 'vitest'
import { typegraphMemoryMiddleware } from '../middleware.js'

function createTypegraphTarget() {
  return {
    memory: {
      recall: vi.fn(async () => '<memory />'),
      extractThread: vi.fn(async () => ({ conversationId: 'thread-1', layoutId: 'default', noOp: false, keywords: [], artifacts: {} })),
      consolidate: vi.fn(async () => ({ layoutId: 'default', selected: 1, artifacts: {} })),
    },
    thread: {
      addTurn: vi.fn(async () => ({ thread: { id: 'thread-1' }, event: { id: 'event-1' } })),
    },
  }
}

describe('typegraphMemoryMiddleware conversationMemory', () => {
  it('captures turns without extracting conversation artifacts by default', async () => {
    const target = createTypegraphTarget()
    const middleware = typegraphMemoryMiddleware(target as any, {
      context: { userId: 'user-1', threadId: 'thread-1' },
    })

    await middleware.afterResponse([{ role: 'assistant', content: 'done' }])

    expect(target.thread.addTurn).toHaveBeenCalledWith('thread-1', {
      role: 'assistant',
      content: 'done',
    }, {
      context: { userId: 'user-1', threadId: 'thread-1' },
      graphExtraction: undefined,
    })
    expect(target.memory.extractThread).not.toHaveBeenCalled()
    expect(target.memory.consolidate).not.toHaveBeenCalled()
  })

  it('extracts and consolidates only when conversationMemory opts in to that mode', async () => {
    const target = createTypegraphTarget()
    const middleware = typegraphMemoryMiddleware(target as any, {
      context: { userId: 'user-1', threadId: 'thread-1' },
      conversationMemory: {
        enabled: true,
        mode: 'extract_and_consolidate',
        layoutId: 'agent',
        includeRoles: ['user', 'assistant', 'tool'],
        maxTranscriptChars: 10_000,
        maxRawMemories: 25,
      },
    })

    await middleware.afterResponse([
      { role: 'user', content: 'please implement memory' },
      { role: 'assistant', content: 'implemented' },
    ])

    expect(target.memory.extractThread).toHaveBeenCalledWith('thread-1', {
      context: { userId: 'user-1', threadId: 'thread-1' },
      layoutId: 'agent',
      includeRoles: ['user', 'assistant', 'tool'],
      maxTranscriptChars: 10_000,
    })
    expect(target.memory.consolidate).toHaveBeenCalledWith({
      context: { userId: 'user-1', threadId: 'thread-1' },
      layoutId: 'agent',
      maxRawMemories: 25,
    })
  })
})
