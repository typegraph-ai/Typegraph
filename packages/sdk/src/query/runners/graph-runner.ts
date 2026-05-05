import type { EntityResult, FactResult, GraphSearchTrace, KnowledgeGraphBridge } from '../../types/graph-bridge.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { QueryGraphOptions } from '../../types/query.js'
import type { RetrievalCandidate } from '../merger.js'

const FACT_FILTERED_NARROW_GRAPH_OPTIONS: Required<Pick<QueryGraphOptions,
  'factFilter' |
  'factCandidateLimit' |
  'factFilterInputLimit' |
  'factSeedLimit' |
  'chunkSeedLimit' |
  'maxExpansionEdgesPerEntity' |
  'factChainLimit' |
  'maxPprIterations' |
  'minPprScore'
>> = {
  factFilter: true,
  factCandidateLimit: 80,
  factFilterInputLimit: 12,
  factSeedLimit: 4,
  chunkSeedLimit: 80,
  maxExpansionEdgesPerEntity: 25,
  factChainLimit: 2,
  maxPprIterations: 40,
  minPprScore: 1e-8,
}

export function resolveGraphSearchOptions(options?: QueryGraphOptions): QueryGraphOptions {
  const { profile = 'fact-filtered-narrow', ...overrides } = options ?? {}
  const preset = profile === 'fact-filtered-narrow' ? FACT_FILTERED_NARROW_GRAPH_OPTIONS : {}
  return { ...preset, ...overrides }
}

export interface GraphRunResult {
  results: RetrievalCandidate[]
  facts: FactResult[]
  entities: EntityResult[]
  trace?: GraphSearchTrace | undefined
}

export class GraphRunner {
  constructor(private graph: KnowledgeGraphBridge) {}

  /**
   * Graph-augmented retrieval via Personalized PageRank.
   *
   * 1. Build fact, entity, and chunk seeds
   * 2. Traverse a heterogeneous entity<->chunk graph
   * 3. Read out ranked chunks directly
   * 4. Return chunk-backed results for merging with other runners
   */
  async run(
    text: string,
    identity: typegraphIdentity,
    count: number,
    bucketIds?: string[],
    options?: QueryGraphOptions,
  ): Promise<GraphRunResult> {
    if (!this.graph.searchGraphChunks) {
      throw new Error('Knowledge graph bridge must implement searchGraphChunks for graph queries.')
    }

    const graphResult = await this.graph.searchGraphChunks(text, identity, {
      ...resolveGraphSearchOptions(options),
      count,
      bucketIds,
    })
    return {
      facts: graphResult.facts,
      entities: graphResult.entities,
      trace: graphResult.trace,
      results: graphResult.results.map(result => ({
        content: result.content,
        bucketId: result.bucketId,
        documentId: result.documentId,
        rawScores: { graph: result.score },
        normalizedScore: result.score,
        mode: 'graph' as const,
        metadata: {
          ...(result.metadata ?? {}),
          chunkId: result.chunkId,
        },
        chunk: { index: result.chunkIndex, total: result.totalChunks ?? 1 },
        tenantId: result.tenantId ?? identity.tenantId,
        groupId: result.groupId,
        userId: result.userId,
        agentId: result.agentId,
        conversationId: result.conversationId,
      })),
    }
  }
}
