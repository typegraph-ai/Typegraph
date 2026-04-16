import type { KnowledgeGraphBridge } from '../../types/graph-bridge.js'
import type { typegraphIdentity } from '../../types/identity.js'
import type { NormalizedResult } from '../merger.js'

export class GraphRunner {
  constructor(private graph: KnowledgeGraphBridge) {}

  /**
   * Graph-augmented retrieval via Personalized PageRank.
   *
   * 1. Find entities matching query terms via embedding similarity
   * 2. Load subgraph adjacency around those seed entities
   * 3. Run PPR to rank all reachable nodes by associative relevance
   * 4. Retrieve chunks linked to high-scoring entities
   * 5. Return as NormalizedResult[] for merging with other runners
   */
  async run(
    text: string,
    identity: typegraphIdentity,
    count: number
  ): Promise<NormalizedResult[]> {
    // Requires graph bridge methods for entity search and PPR
    if (!this.graph.searchEntities || !this.graph.getAdjacencyList || !this.graph.getChunksForEntities) {
      return []
    }

    // Step 1: Find seed entities matching the query (with similarity scores)
    const entities = await this.graph.searchEntities(text, identity, 10)
    if (entities.length === 0) return []

    const seedIds = entities.map(e => e.id)
    // Build seed weights from entity-query similarity for weighted PPR initialization
    const seedWeights = new Map(entities.map(e => [e.id, e.similarity ?? (1 / entities.length)]))

    // Step 2: Get adjacency list for PPR
    const adjacency = await this.graph.getAdjacencyList(seedIds)
    if (adjacency.size === 0) return []

    // Step 3: Run PPR with similarity-weighted seeds and higher damping
    const pprScores = runLightweightPPR(adjacency, seedIds, seedWeights)

    // Step 4: Get top entities by PPR score
    const rankedEntities = [...pprScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count * 2) // fetch more to account for dedup
      .map(([id]) => id)

    // Step 5: Get chunks associated with high-PPR entities, passing PPR scores for ranking
    const chunks = await this.graph.getChunksForEntities(rankedEntities, count, pprScores)

    // Store raw PPR scores — normalization happens at the planner level
    // via normalizePPR(rawScore, dampingFactor) for cross-query comparability
    return chunks.map((chunk, i) => ({
      content: chunk.content,
      bucketId: chunk.bucketId,
      documentId: chunk.documentId ?? `graph-${i}`,
      rawScores: { graph: chunk.score },
      normalizedScore: chunk.score,
      mode: 'graph' as const,
      metadata: chunk.metadata ?? {},
      chunk: chunk.chunkIndex !== undefined ? { index: chunk.chunkIndex, total: 1, isNeighbor: false } : undefined,
      tenantId: identity.tenantId,
    }))
  }
}

/**
 * Lightweight PPR implementation for the graph runner.
 * Avoids core depending on @typegraph/graph.
 */
function runLightweightPPR(
  adjacency: Map<string, Array<{ target: string; weight: number }>>,
  seedNodes: string[],
  seedWeights?: Map<string, number>,
  dampingFactor = 0.35,
  maxIterations = 50
): Map<string, number> {
  const allNodes = new Set<string>()
  for (const [node, edges] of adjacency) {
    allNodes.add(node)
    for (const edge of edges) allNodes.add(edge.target)
  }
  const nodeList = [...allNodes]
  const n = nodeList.length
  if (n === 0) return new Map()

  const idx = new Map(nodeList.map((id, i) => [id, i]))

  const p = new Float64Array(n)
  const validSeeds = seedNodes.filter(s => idx.has(s))
  if (validSeeds.length === 0) return new Map()
  // Weight seeds by entity-query similarity so more relevant entities
  // receive more initial PPR probability. Reduces hub drift.
  let totalWeight = 0
  for (const s of validSeeds) totalWeight += (seedWeights?.get(s) ?? 1)
  for (const s of validSeeds) p[idx.get(s)!] = (seedWeights?.get(s) ?? 1) / totalWeight

  let scores = Float64Array.from(p)

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(n)
    for (const [node, edges] of adjacency) {
      const si = idx.get(node)!
      const total = edges.reduce((s, e) => s + e.weight, 0)
      if (total <= 0) continue
      for (const e of edges) {
        const ti = idx.get(e.target)
        if (ti !== undefined) next[ti]! += (1 - dampingFactor) * scores[si]! * (e.weight / total)
      }
    }
    let diff = 0
    for (let i = 0; i < n; i++) {
      next[i]! += dampingFactor * p[i]!
      diff += Math.abs(next[i]! - scores[i]!)
    }
    scores = next
    if (diff < 1e-6) break
  }

  const result = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    if (scores[i]! > 1e-10) result.set(nodeList[i]!, scores[i]!)
  }
  return result
}
