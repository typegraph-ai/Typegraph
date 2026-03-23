import type { EmbeddingProvider } from './provider.js'

export interface OpenAIEmbeddingConfig {
  apiKey: string
  model?: string | undefined
  dimensions?: number | undefined
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dimensions: number
  readonly model: string

  constructor(private config: OpenAIEmbeddingConfig) {
    this.model = config.model ?? 'text-embedding-3-small'
    this.dimensions = config.dimensions ?? 1536
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text])
    return embedding!
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // TODO: implement OpenAI embeddings API call
    throw new Error('Not implemented')
  }
}
