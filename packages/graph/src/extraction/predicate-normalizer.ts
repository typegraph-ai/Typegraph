import type { EmbeddingProvider } from '@d8um/core'

/**
 * Clusters semantically equivalent predicates into canonical forms.
 *
 * Without normalization, predicates like PLAYS_FOR, IS_A_PLAYER_FOR, PLAYED_FOR
 * are treated as distinct relation types, fragmenting graph traversal paths.
 * This normalizer merges them into a single canonical predicate using embedding similarity.
 */
export class PredicateNormalizer {
  private readonly embedding: EmbeddingProvider
  private readonly threshold: number
  private readonly canonicalPredicates = new Map<string, number[]>() // predicate → embedding

  constructor(embedding: EmbeddingProvider, threshold = 0.85) {
    this.embedding = embedding
    this.threshold = threshold
  }

  /**
   * Normalize a predicate to its canonical form.
   * If a similar canonical predicate exists (cosine similarity > threshold), use it.
   * Otherwise, register this predicate as a new canonical form.
   */
  async normalize(predicate: string): Promise<string> {
    // Exact match — skip embedding
    if (this.canonicalPredicates.has(predicate)) return predicate

    const predicateEmbedding = await this.embedding.embed(predicate.replace(/_/g, ' ').toLowerCase())

    let bestMatch: string | null = null
    let bestSimilarity = 0

    for (const [canonical, embedding] of this.canonicalPredicates) {
      const similarity = cosineSimilarity(predicateEmbedding, embedding)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestMatch = canonical
      }
    }

    if (bestMatch && bestSimilarity >= this.threshold) {
      return bestMatch
    }

    // Register as new canonical predicate
    this.canonicalPredicates.set(predicate, predicateEmbedding)
    return predicate
  }

  /** Number of canonical predicates registered. */
  get size(): number {
    return this.canonicalPredicates.size
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
