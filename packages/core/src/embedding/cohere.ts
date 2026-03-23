import type { EmbeddingProvider } from './provider.js'

export interface CohereEmbeddingConfig {
  apiKey: string
  model?: string | undefined
  dimensions?: number | undefined
}

export class CohereEmbedding implements EmbeddingProvider {
  readonly dimensions: number
  readonly model: string

  constructor(private config: CohereEmbeddingConfig) {
    this.model = config.model ?? 'embed-english-v3.0'
    this.dimensions = config.dimensions ?? 1024
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text])
    return embedding!
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // TODO: implement Cohere embeddings API call
    throw new Error('Not implemented')
  }
}
