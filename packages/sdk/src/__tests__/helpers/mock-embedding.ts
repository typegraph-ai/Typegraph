import type { EmbeddingProvider } from '../../embedding/provider.js'

function createHashToVector(dimensions: number) {
  return function hashToVector(text: string): number[] {
    const vec: number[] = []
    for (let i = 0; i < dimensions; i++) {
      let hash = 0
      for (let j = 0; j < text.length; j++) {
        hash = ((hash << 5) - hash + text.charCodeAt(j) + i * 31) | 0
      }
      vec.push((hash % 1000) / 1000)
    }
    return vec
  }
}

export function createMockEmbedding(opts?: {
  dimensions?: number
  model?: string
}): EmbeddingProvider {
  const dimensions = opts?.dimensions ?? 4
  const model = opts?.model ?? 'mock-embed-v1'
  const hashToVector = createHashToVector(dimensions)

  return {
    model,
    dimensions,
    async embed(text: string): Promise<number[]> {
      return hashToVector(text)
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(t => hashToVector(t))
    },
  }
}

export function createMockAISDKModel(opts?: {
  provider?: string
  modelId?: string
  dimensions?: number
  maxEmbeddingsPerCall?: number
}) {
  const provider = opts?.provider ?? 'mock-provider'
  const modelId = opts?.modelId ?? 'mock-model-v1'
  const dimensions = opts?.dimensions ?? 4
  const maxEmbeddingsPerCall = opts?.maxEmbeddingsPerCall
  const hashToVector = createHashToVector(dimensions)

  return {
    model: {
      specificationVersion: 'v3' as const,
      provider,
      modelId,
      maxEmbeddingsPerCall,
      supportsParallelCalls: false,
      async doEmbed(options: { values: string[] }): Promise<{ embeddings: number[][]; warnings: never[] }> {
        return { embeddings: options.values.map(v => hashToVector(v)), warnings: [] }
      },
    },
    dimensions,
  }
}
