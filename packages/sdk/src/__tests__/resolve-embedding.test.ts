import { describe, it, expect } from 'vitest'
import { resolveEmbedder } from '../typegraph.js'
import { createMockEmbedding, createMockAISDKModel } from './helpers/mock-embedding.js'

describe('resolveEmbedder', () => {
  it('returns Embedder directly if it matches interface', () => {
    const provider = createMockEmbedding({ model: 'direct-model' })
    const resolved = resolveEmbedder(provider)
    expect(resolved).toBe(provider)
    expect(resolved.name).toBe('direct-model')
  })

  it('wraps AI SDK model into Embedder', () => {
    const input = createMockAISDKModel({ provider: 'openai', modelId: 'v3-small', dimensions: 8 })
    const resolved = resolveEmbedder(input)
    expect(resolved.name).toBe('openai/v3-small')
    expect(resolved.dimensions).toBe(8)
    expect(typeof resolved.embed).toBe('function')
  })

  it('throws for invalid config', () => {
    expect(() =>
      resolveEmbedder({} as any)
    ).toThrow('Invalid embedding configuration')
  })
})
