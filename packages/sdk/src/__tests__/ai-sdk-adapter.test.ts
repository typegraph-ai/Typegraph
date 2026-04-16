import { describe, it, expect, vi } from 'vitest'
import { isAISDKEmbeddingInput, aiSdkEmbeddingProvider } from '../embedding/ai-sdk-adapter.js'
import { createMockAISDKModel, createMockEmbedding } from './helpers/mock-embedding.js'

describe('isAISDKEmbeddingInput', () => {
  it('returns true for valid AI SDK input', () => {
    const input = createMockAISDKModel()
    expect(isAISDKEmbeddingInput(input)).toBe(true)
  })

  it('returns false for null', () => {
    expect(isAISDKEmbeddingInput(null)).toBe(false)
  })

  it('returns false for plain objects', () => {
    expect(isAISDKEmbeddingInput({ foo: 'bar' })).toBe(false)
  })

  it('returns false for objects without doEmbed', () => {
    expect(isAISDKEmbeddingInput({ model: { provider: 'x' }, dimensions: 4 })).toBe(false)
  })

  it('returns false for objects without dimensions', () => {
    expect(isAISDKEmbeddingInput({ model: { doEmbed: () => {} } })).toBe(false)
  })

  it('returns false for EmbeddingProvider objects', () => {
    const provider = createMockEmbedding()
    expect(isAISDKEmbeddingInput(provider)).toBe(false)
  })
})

describe('aiSdkEmbeddingProvider', () => {
  it('creates provider with correct model name', () => {
    const input = createMockAISDKModel({ provider: 'openai', modelId: 'text-embed-v3' })
    const provider = aiSdkEmbeddingProvider(input)
    expect(provider.model).toBe('openai/text-embed-v3')
  })

  it('embed() returns single vector', async () => {
    const input = createMockAISDKModel({ dimensions: 8 })
    const provider = aiSdkEmbeddingProvider(input)
    const result = await provider.embed('test')
    expect(result).toHaveLength(8)
    expect(result.every(v => typeof v === 'number')).toBe(true)
  })

  it('embedBatch() returns vectors for all texts', async () => {
    const input = createMockAISDKModel({ dimensions: 4 })
    const provider = aiSdkEmbeddingProvider(input)
    const result = await provider.embedBatch(['a', 'b', 'c'])
    expect(result).toHaveLength(3)
    for (const vec of result) {
      expect(vec).toHaveLength(4)
    }
  })

  it('embedBatch() returns empty array for empty input', async () => {
    const input = createMockAISDKModel()
    const provider = aiSdkEmbeddingProvider(input)
    const result = await provider.embedBatch([])
    expect(result).toEqual([])
  })

  it('respects maxEmbeddingsPerCall batching', async () => {
    const input = createMockAISDKModel({ maxEmbeddingsPerCall: 2, dimensions: 4 })
    const doEmbedSpy = vi.spyOn(input.model, 'doEmbed')
    const provider = aiSdkEmbeddingProvider(input)
    const result = await provider.embedBatch(['a', 'b', 'c', 'd', 'e'])
    expect(result).toHaveLength(5)
    // 5 texts with batch size 2 → ceil(5/2) = 3 calls
    expect(doEmbedSpy).toHaveBeenCalledTimes(3)
  })
})
