import type { VectorStoreAdapter } from '../../types/adapter.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'
import type { D8umSource } from '../../types/source.js'
import type { NormalizedResult } from '../merger.js'

export class IndexedRunner {
  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider
  ) {}

  async run(text: string, sources: D8umSource[], topK: number, tenantId?: string): Promise<NormalizedResult[]> {
    // TODO: embed query text, search vector store, normalize scores
    throw new Error('Not implemented')
  }
}
