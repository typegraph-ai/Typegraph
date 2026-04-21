import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }))

vi.mock('ai', () => ({
  generateText: mockGenerateText,
  Output: {
    json: () => ({ type: 'json' }),
    object: (opts: { schema: unknown }) => ({ type: 'object', schema: opts.schema }),
  },
}))

import { aiSdkLlmProvider } from '../llm/ai-sdk-adapter.js'

const fakeModel = {
  specificationVersion: 'v3' as const,
  provider: 'mock',
  modelId: 'mock-1',
  doGenerate: async () => ({ text: '' }),
} as any

describe('aiSdkLlmProvider providerOptions', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockGenerateText.mockResolvedValue({ text: 'hi', output: { ok: true } })
  })

  it('forwards config-level providerOptions into generateText', async () => {
    const provider = aiSdkLlmProvider({
      model: fakeModel,
      providerOptions: { gateway: { models: ['a', 'b'] } },
    })
    await provider.generateText('hello')
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { gateway: { models: ['a', 'b'] } },
      }),
    )
  })

  it('merges call-level providerOptions on top of config-level', async () => {
    const provider = aiSdkLlmProvider({
      model: fakeModel,
      providerOptions: {
        gateway: { models: ['a', 'b'] },
        openai: { reasoningEffort: 'low' },
      },
    })
    await provider.generateText('hello', undefined, {
      providerOptions: { openai: { reasoningEffort: 'high' } },
    })
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          gateway: { models: ['a', 'b'] },
          openai: { reasoningEffort: 'high' },
        },
      }),
    )
  })

  it('omits providerOptions when neither config- nor call-level provided', async () => {
    const provider = aiSdkLlmProvider({ model: fakeModel })
    await provider.generateText('hello')
    const call = mockGenerateText.mock.calls[0][0]
    expect(call.providerOptions).toBeUndefined()
  })

  it('forwards providerOptions on generateJSON as well', async () => {
    const provider = aiSdkLlmProvider({
      model: fakeModel,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'medium' } } },
    })
    await provider.generateJSON('prompt')
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { google: { thinkingConfig: { thinkingLevel: 'medium' } } },
      }),
    )
  })

  it('preserves non-overlapping provider namespaces when merging', async () => {
    const provider = aiSdkLlmProvider({
      model: fakeModel,
      providerOptions: { gateway: { models: ['a'] } },
    })
    await provider.generateText('hello', undefined, {
      providerOptions: { xai: { reasoningEffort: 'low' } },
    })
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          gateway: { models: ['a'] },
          xai: { reasoningEffort: 'low' },
        },
      }),
    )
  })
})
