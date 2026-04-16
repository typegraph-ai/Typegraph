import { describe, it, expect } from 'vitest'
import { resolveEmbeddingProvider } from '../typegraph.js'
import { createMockEmbedding, createMockAISDKModel } from './helpers/mock-embedding.js'

describe('resolveEmbeddingProvider', () => {
  it('returns EmbeddingProvider directly if it matches interface', () => {
    const provider = createMockEmbedding({ model: 'direct-model' })
    const resolved = resolveEmbeddingProvider(provider)
    expect(resolved).toBe(provider)
    expect(resolved.model).toBe('direct-model')
  })

  it('wraps AI SDK model into EmbeddingProvider', () => {
    const input = createMockAISDKModel({ provider: 'openai', modelId: 'v3-small', dimensions: 8 })
    const resolved = resolveEmbeddingProvider(input)
    expect(resolved.model).toBe('openai/v3-small')
    expect(resolved.dimensions).toBe(8)
    expect(typeof resolved.embed).toBe('function')
    expect(typeof resolved.embedBatch).toBe('function')
  })

  it('throws for invalid config', () => {
    expect(() =>
      resolveEmbeddingProvider({} as any)
    ).toThrow('Invalid embedding configuration')
  })
})
