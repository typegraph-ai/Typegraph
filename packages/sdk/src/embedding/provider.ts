export interface EmbedInput {
  texts: string[]
  inputType?: 'document' | 'search' | undefined
  outputDimensions?: number | undefined
  abortSignal?: AbortSignal | undefined
}

export interface Embedder {
  name: string
  dimensions: number
  maxBatchSize?: number | undefined
  supportsAsymmetric?: boolean | undefined
  embed(input: EmbedInput): Promise<number[][]>
}

export async function embedText(embedder: Embedder, text: string, inputType: 'document' | 'search' = 'document'): Promise<number[]> {
  const result = await embedder.embed({ texts: [text], inputType })
  const embedding = Array.isArray(result[0]) ? result[0] : result as unknown as number[]
  return embedding ?? []
}

export async function embedTexts(embedder: Embedder, texts: string[], inputType: 'document' | 'search' = 'document'): Promise<number[][]> {
  return embedder.embed({ texts, inputType })
}

/**
 * Dimension-aware model key: "{model}:{dimensions}"
 * Same model at different dimensions gets distinct registry entries and table names.
 */
export function embeddingModelKey(provider: Embedder): string
export function embeddingModelKey(model: string, dimensions: number): string
export function embeddingModelKey(modelOrProvider: string | Embedder, dimensions?: number): string {
  if (typeof modelOrProvider === 'string') {
    return `${modelOrProvider}:${dimensions!}`
  }
  return `${modelOrProvider.name}:${modelOrProvider.dimensions}`
}

export function parseEmbeddingModelKey(key: string): { model: string; dimensions: number } {
  const idx = key.lastIndexOf(':')
  if (idx === -1) throw new Error(`Invalid embedding model key "${key}" — expected "model:dimensions"`)
  const model = key.slice(0, idx)
  const dimensions = parseInt(key.slice(idx + 1), 10)
  if (isNaN(dimensions)) throw new Error(`Invalid dimensions in embedding model key "${key}"`)
  return { model, dimensions }
}
