import type { D8umSource } from '../types/source.js'
import type { QueryOpts, QueryResponse } from '../types/query.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'

export class QueryPlanner {
  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider,
    private sources: Map<string, D8umSource>
  ) {}

  async execute(text: string, opts: QueryOpts = {}): Promise<QueryResponse> {
    // TODO: implement fan-out across indexed/live/cached runners
    // 1. Filter sources by opts.sources
    // 2. Group by mode
    // 3. Promise.allSettled with per-mode timeouts
    // 4. Merge results via ScoreMerger
    // 5. Build QueryResponse
    throw new Error('Not implemented')
  }
}
