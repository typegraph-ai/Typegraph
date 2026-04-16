export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  dimensions: number
  model: string
}

/**
 * Dimension-aware model key: "{model}:{dimensions}"
 * Same model at different dimensions gets distinct registry entries and table names.
 */
export function embeddingModelKey(provider: EmbeddingProvider): string
export function embeddingModelKey(model: string, dimensions: number): string
export function embeddingModelKey(modelOrProvider: string | EmbeddingProvider, dimensions?: number): string {
  if (typeof modelOrProvider === 'string') {
    return `${modelOrProvider}:${dimensions!}`
  }
  return `${modelOrProvider.model}:${modelOrProvider.dimensions}`
}

export function parseEmbeddingModelKey(key: string): { model: string; dimensions: number } {
  const idx = key.lastIndexOf(':')
  if (idx === -1) throw new Error(`Invalid embedding model key "${key}" — expected "model:dimensions"`)
  const model = key.slice(0, idx)
  const dimensions = parseInt(key.slice(idx + 1), 10)
  if (isNaN(dimensions)) throw new Error(`Invalid dimensions in embedding model key "${key}"`)
  return { model, dimensions }
}
