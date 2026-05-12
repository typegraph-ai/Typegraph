import { describe, it, expect, vi } from 'vitest'
import { isAISDKEmbeddingInput, aiSdkEmbedder } from '../embedding/ai-sdk-adapter.js'
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

  it('returns false for Embedder objects', () => {
    const provider = createMockEmbedding()
    expect(isAISDKEmbeddingInput(provider)).toBe(false)
  })
})

describe('aiSdkEmbedder', () => {
  it('creates provider with correct model name', () => {
    const input = createMockAISDKModel({ provider: 'openai', modelId: 'text-embed-v3' })
    const provider = aiSdkEmbedder(input)
    expect(provider.name).toBe('openai/text-embed-v3')
  })

  it('embed() returns single vector', async () => {
    const input = createMockAISDKModel({ dimensions: 8 })
    const provider = aiSdkEmbedder(input)
    const result = await provider.embed({ texts: ['test'] })
    expect(result[0]).toHaveLength(8)
    expect(result[0]?.every(v => typeof v === 'number')).toBe(true)
  })

  it('embed() returns vectors for all texts', async () => {
    const input = createMockAISDKModel({ dimensions: 4 })
    const provider = aiSdkEmbedder(input)
    const result = await provider.embed({ texts: ['a', 'b', 'c'] })
    expect(result).toHaveLength(3)
    for (const vec of result) {
      expect(vec).toHaveLength(4)
    }
  })

  it('embed() returns empty array for empty input', async () => {
    const input = createMockAISDKModel()
    const provider = aiSdkEmbedder(input)
    const result = await provider.embed({ texts: [] })
    expect(result).toEqual([])
  })

  it('respects maxEmbeddingsPerCall batching', async () => {
    const input = createMockAISDKModel({ maxEmbeddingsPerCall: 2, dimensions: 4 })
    const doEmbedSpy = vi.spyOn(input.model, 'doEmbed')
    const provider = aiSdkEmbedder(input)
    const result = await provider.embed({ texts: ['a', 'b', 'c', 'd', 'e'] })
    expect(result).toHaveLength(5)
    // 5 texts with batch size 2 → ceil(5/2) = 3 calls
    expect(doEmbedSpy).toHaveBeenCalledTimes(3)
  })

  it('maps TypeGraph search embeddings to Voyage query provider options', async () => {
    const input = {
      ...createMockAISDKModel({ provider: 'gateway', modelId: 'voyage/voyage-4-lite', dimensions: 4 }),
      providerOptions: { voyage: { outputDimension: 512, inputType: 'search' } },
    }
    const doEmbedSpy = vi.spyOn(input.model, 'doEmbed')
    const provider = aiSdkEmbedder(input)

    await provider.embed({ texts: ['search text'], inputType: 'search', outputDimensions: 256 })

    expect((doEmbedSpy.mock.calls[0]?.[0] as any).providerOptions).toEqual({
      voyage: { outputDimension: 256, inputType: 'query' },
    })
  })

  it('does not leak internal TypeGraph provider options to AI SDK providers', async () => {
    const input = {
      ...createMockAISDKModel({ provider: 'gateway', modelId: 'custom/custom-embed', dimensions: 4 }),
      providerOptions: { typegraph: { outputDimensions: 512, inputType: 'search' } },
    }
    const doEmbedSpy = vi.spyOn(input.model, 'doEmbed')
    const provider = aiSdkEmbedder(input as any)

    await provider.embed({ texts: ['search text'], inputType: 'search', outputDimensions: 256 })

    expect((doEmbedSpy.mock.calls[0]?.[0] as any).providerOptions).toBeUndefined()
  })
})
