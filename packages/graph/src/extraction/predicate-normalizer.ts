import type { EmbeddingProvider } from '@d8um/core'

/**
 * Synonym groups: first element is canonical form, rest map to it.
 * Tense variants are SEPARATE groups — they carry temporal meaning
 * (e.g. PLAYS_FOR = current, PLAYED_FOR = past).
 */
const SYNONYM_GROUPS: readonly string[][] = [
  // Present-tense employment
  ['WORKS_FOR', 'EMPLOYED_BY', 'EMPLOYED_AT', 'WORKS_AT'],
  // Past-tense employment
  ['WORKED_FOR', 'WORKED_AT', 'WAS_EMPLOYED_BY', 'WAS_EMPLOYED_AT'],
  // Membership
  ['MEMBER_OF', 'BELONGS_TO'],
  // Signing/contracting
  ['SIGNED_WITH', 'SIGNED_BY'],
  // Location
  ['LOCATED_IN', 'BASED_IN', 'HEADQUARTERED_IN', 'SITUATED_IN'],
  // Founding
  ['FOUNDED_BY', 'CO_FOUNDED_BY'],
  // Ownership
  ['OWNS', 'OWNER_OF'],
  ['OWNED_BY', 'ACQUIRED_BY'],
]

/**
 * Clusters semantically equivalent predicates into canonical forms.
 *
 * Without normalization, predicates like PLAYS_FOR, IS_A_PLAYER_FOR, PLAYED_FOR
 * are treated as distinct relation types, fragmenting graph traversal paths.
 *
 * Three-phase resolution:
 * 1. Static synonym table (O(1) lookup for known synonyms)
 * 2. Resolved cache (skips embedding for repeated surface forms)
 * 3. Embedding similarity with tense guard (prevents cross-tense merging)
 */
export class PredicateNormalizer {
  private readonly embedding: EmbeddingProvider
  private readonly threshold: number
  private readonly canonicalPredicates = new Map<string, number[]>() // predicate → embedding
  // Cache: normalized text → canonical predicate (skips embedding for repeated surface forms)
  private readonly resolvedCache = new Map<string, string>()
  // Static synonym lookup: EMPLOYED_BY → WORKS_FOR, etc.
  private readonly synonymMap = new Map<string, string>()

  constructor(embedding: EmbeddingProvider, threshold = 0.85, extraSynonyms?: readonly string[][]) {
    this.embedding = embedding
    this.threshold = threshold
    for (const group of [...SYNONYM_GROUPS, ...(extraSynonyms ?? [])]) {
      const canonical = group[0]!
      for (const synonym of group) {
        this.synonymMap.set(synonym, canonical)
      }
    }
  }

  /**
   * Normalize a predicate to its canonical form.
   *
   * Resolution order:
   * 1. Exact canonical match → return immediately
   * 2. Static synonym table → O(1) deterministic merge
   * 3. Resolved cache → skip embedding for repeated surface forms
   * 4. Embedding similarity (with tense guard) → merge novel predicates
   * 5. Register as new canonical form
   */
  async normalize(predicate: string): Promise<string> {
    // 1. Exact match — skip everything
    if (this.canonicalPredicates.has(predicate)) return predicate

    // 2. Static synonym lookup (O(1))
    const synonymCanonical = this.synonymMap.get(predicate)
    if (synonymCanonical) {
      this.resolvedCache.set(predicate.replace(/_/g, ' ').toLowerCase(), synonymCanonical)
      if (!this.canonicalPredicates.has(synonymCanonical)) {
        const embedding = await this.embedding.embed(synonymCanonical.replace(/_/g, ' ').toLowerCase())
        this.canonicalPredicates.set(synonymCanonical, embedding)
      }
      return synonymCanonical
    }

    // 3. Resolved cache (catches variants we've already mapped)
    const normalizedText = predicate.replace(/_/g, ' ').toLowerCase()
    const cached = this.resolvedCache.get(normalizedText)
    if (cached) return cached

    // 4. Embedding comparison with tense guard
    const predicateEmbedding = await this.embedding.embed(normalizedText)

    let bestMatch: string | null = null
    let bestSimilarity = 0

    for (const [canonical, embedding] of this.canonicalPredicates) {
      const similarity = cosineSimilarity(predicateEmbedding, embedding)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestMatch = canonical
      }
    }

    if (bestMatch && bestSimilarity >= this.threshold && !hasTenseMismatch(predicate, bestMatch)) {
      this.resolvedCache.set(normalizedText, bestMatch)
      return bestMatch
    }

    // 5. Register as new canonical predicate
    this.canonicalPredicates.set(predicate, predicateEmbedding)
    this.resolvedCache.set(normalizedText, predicate)
    return predicate
  }

  /** Number of canonical predicates registered. */
  get size(): number {
    return this.canonicalPredicates.size
  }
}

/**
 * Detects tense mismatch between two SCREAMING_SNAKE_CASE predicates.
 * Prevents embedding fallback from merging PLAYS_FOR with PLAYED_FOR.
 */
function hasTenseMismatch(a: string, b: string): boolean {
  const verbA = a.split('_')[0] ?? ''
  const verbB = b.split('_')[0] ?? ''
  const isPast = (v: string) => v.endsWith('ED')
  const isPresent = (v: string) => v.endsWith('S') || v.endsWith('ES')
  return (isPast(verbA) && isPresent(verbB)) || (isPast(verbB) && isPresent(verbA))
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
