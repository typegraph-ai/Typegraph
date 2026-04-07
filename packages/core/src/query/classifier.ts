import type { QuerySignals } from '../types/query.js'

/** All signals active — used for complex/multi-hop queries that benefit from graph+memory. */
const FULL_SIGNALS: QuerySignals = { vector: true, keyword: true, graph: true, memory: true }

/** Vector-only — used for simple lookups and factual queries. */
const VECTOR_ONLY: QuerySignals = { vector: true }

/**
 * Lightweight query complexity classifier. No LLM call — pure heuristics.
 *
 * Returns full signals (vector+keyword+graph+memory) for queries that likely
 * benefit from graph-augmented retrieval:
 * - Multi-entity queries (mentions multiple names/concepts)
 * - Multi-hop questions (require connecting information across documents)
 * - Relational queries (ask about connections between entities)
 *
 * Returns vector-only for simple lookups and factual queries.
 */
export function classifyQuery(text: string): QuerySignals {
  const lower = text.toLowerCase()

  // Multi-hop indicators: connecting language
  const multiHopPatterns = [
    /\bwho\b.*\b(works?|worked)\b.*\bat\b/,       // "who works at X"
    /\bwhat\b.*\b(connect|relat|link)/,             // "what connects X and Y"
    /\bhow\b.*\b(relat|connect)/,                    // "how does X relate to Y"
    /\band\b.*\band\b/,                              // multiple conjunctions
    /\bbetween\b/,                                    // "between X and Y"
    /\bthrough\b/,                                    // "through what"
    /\bvia\b/,                                        // "via what connection"
  ]

  // Question complexity: multi-clause questions
  const complexityIndicators = [
    /\bwhy\b.*\b(because|since|due)\b/,
    /\bwhat\b.*\bif\b/,
    /\bgiven\b.*\bwhat\b/,
    /\bconsidering\b/,
  ]

  // Check for relational/multi-hop patterns
  for (const pattern of multiHopPatterns) {
    if (pattern.test(lower)) return FULL_SIGNALS
  }

  // Check for complex questions
  for (const pattern of complexityIndicators) {
    if (pattern.test(lower)) return FULL_SIGNALS
  }

  // Count potential entity mentions (capitalized words not at sentence start)
  const words = text.split(/\s+/)
  let entityCount = 0
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!
    if (word.length > 1 && word[0] === word[0]!.toUpperCase() && word[0] !== word[0]!.toLowerCase()) {
      entityCount++
    }
  }
  if (entityCount >= 3) return FULL_SIGNALS

  return VECTOR_ONLY
}
