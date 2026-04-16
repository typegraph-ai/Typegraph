/**
 * Personalized PageRank implementation.
 * Pure function — takes an adjacency list and seed nodes, returns node scores.
 *
 * PPR spreads activation from seed nodes through the graph, biased toward
 * returning to the seeds. This enables associative, multi-hop retrieval:
 * nodes reachable via paths from query-relevant seeds get high scores
 * even if they share no direct similarity with the query.
 *
 * Formula: x' = (1-α)·A·x + α·E
 * where α is the restart probability and E is the seed vector.
 */

export interface PPRConfig {
  /** Probability of restarting the walk at a seed node. Default: 0.15 */
  dampingFactor?: number
  /** Maximum iterations before convergence. Default: 50 */
  maxIterations?: number
  /** Stop when L1 norm of score change < threshold. Default: 1e-6 */
  convergenceThreshold?: number
}

const DEFAULT_CONFIG: Required<PPRConfig> = {
  dampingFactor: 0.15,
  maxIterations: 50,
  convergenceThreshold: 1e-6,
}

/**
 * Run Personalized PageRank over a graph.
 *
 * @param adjacency - Map of nodeId → outgoing edges [{target, weight}]
 * @param seedNodes - Node IDs to bias the walk toward (query-relevant entities)
 * @param config - PPR parameters
 * @returns Map of nodeId → score (higher = more relevant)
 */
export function personalizedPageRank(
  adjacency: Map<string, Array<{ target: string; weight: number }>>,
  seedNodes: string[],
  config?: PPRConfig
): Map<string, number> {
  const { dampingFactor, maxIterations, convergenceThreshold } = { ...DEFAULT_CONFIG, ...config }

  // Collect all nodes
  const allNodes = new Set<string>()
  for (const [node, edges] of adjacency) {
    allNodes.add(node)
    for (const edge of edges) allNodes.add(edge.target)
  }
  const nodeList = [...allNodes]
  const n = nodeList.length
  if (n === 0) return new Map()

  const nodeIndex = new Map(nodeList.map((id, i) => [id, i]))

  // Build personalization vector (uniform over seed nodes)
  const personalization = new Float64Array(n)
  const validSeeds = seedNodes.filter(s => nodeIndex.has(s))
  if (validSeeds.length === 0) return new Map()
  const seedWeight = 1 / validSeeds.length
  for (const seed of validSeeds) {
    personalization[nodeIndex.get(seed)!] = seedWeight
  }

  // Build normalized adjacency (column-stochastic)
  // For each node, normalize outgoing edge weights to sum to 1
  const outWeights = new Map<string, Array<{ targetIdx: number; normalizedWeight: number }>>()
  for (const [node, edges] of adjacency) {
    const totalWeight = edges.reduce((sum, e) => sum + e.weight, 0)
    if (totalWeight > 0) {
      outWeights.set(node, edges
        .filter(e => nodeIndex.has(e.target))
        .map(e => ({
          targetIdx: nodeIndex.get(e.target)!,
          normalizedWeight: e.weight / totalWeight,
        }))
      )
    }
  }

  // Power iteration
  let scores = new Float64Array(n)
  // Initialize with personalization
  for (let i = 0; i < n; i++) scores[i] = personalization[i]!

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(n)

    // Transition: spread scores through edges
    for (const [node, targets] of outWeights) {
      const srcIdx = nodeIndex.get(node)!
      const srcScore = scores[srcIdx]!
      for (const { targetIdx, normalizedWeight } of targets) {
        next[targetIdx]! += (1 - dampingFactor) * srcScore * normalizedWeight
      }
    }

    // Restart: add personalization bias
    for (let i = 0; i < n; i++) {
      next[i]! += dampingFactor * personalization[i]!
    }

    // Check convergence (L1 norm of change)
    let diff = 0
    for (let i = 0; i < n; i++) {
      diff += Math.abs(next[i]! - scores[i]!)
    }

    scores = next

    if (diff < convergenceThreshold) break
  }

  // Return as Map, filtering out near-zero scores
  const result = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    if (scores[i]! > 1e-10) {
      result.set(nodeList[i]!, scores[i]!)
    }
  }

  return result
}
