import type { QuerySignals } from '../types/query.js'

/** Query type categories with optimized weight profiles. */
export type QueryType = 'factual-lookup' | 'entity-centric' | 'relational' | 'temporal' | 'exploratory'

export interface QueryClassification {
  type: QueryType
  signals: QuerySignals
  /** Recommended score weights for this query type. Keys match normalized score categories. */
  weights: Record<string, number>
  /** Classifier confidence (0-1). Higher = more distinctive pattern match. */
  confidence: number
}

/** Weight profiles per query type: { semantic, keyword, graph, memory } */
const WEIGHT_PROFILES: Record<QueryType, Record<string, number>> = {
  'factual-lookup':  { semantic: 0.40, keyword: 0.25, graph: 0.05, memory: 0.30 },
  'entity-centric':  { semantic: 0.30, keyword: 0.10, graph: 0.45, memory: 0.15 },
  'relational':      { semantic: 0.20, keyword: 0.05, graph: 0.65, memory: 0.10 },
  'temporal':        { semantic: 0.30, keyword: 0.10, graph: 0.15, memory: 0.45 },
  'exploratory':     { semantic: 0.45, keyword: 0.05, graph: 0.25, memory: 0.25 },
}

/** All signals active — used for complex/multi-hop queries that benefit from graph+memory. */
const FULL_SIGNALS: QuerySignals = { semantic: true, keyword: true, graph: true, memory: true }

/** Semantic-only — used for simple lookups and factual queries. */
const SEMANTIC_ONLY: QuerySignals = { semantic: true }

// ── Pattern sets ──

const FACTUAL_PATTERNS = [
  /^(what|who|where|which) (is|are|was|were)\b/,
  /\b(phone number|address|email|name of|birthday|born|founded|created|invented)\b/,
  /\b(how (many|much|old|tall|long|far))\b/,
  /\b(define|definition of)\b/,
]

const TEMPORAL_PATTERNS = [
  /\b(recent|recently|latest|last (week|month|day|year|time))\b/,
  /\b(when|timeline|history of|chronolog|over time)\b/,
  /\b(before|after|during|since|until)\b.*\b\d{4}\b/,
  /\b(yesterday|today|this (week|month|year))\b/,
  /\b(changed|updated|modified|added)\b.*\b(recently|lately)\b/,
]

const RELATIONAL_PATTERNS = [
  /\bwhat\b.*\b(connect|relat|link)/,
  /\bhow\b.*\b(relat|connect)/,
  /\bbetween\b.*\band\b/,
  /\bthrough\b/,
  /\bvia\b/,
  /\b(path|chain|connection|relationship) (from|between)\b/,
]

const ENTITY_CENTRIC_PATTERNS = [
  /\btell me (about|everything about)\b/,
  /\bwhat do (you|we) know about\b/,
  /\bsummarize\b.*\babout\b/,
  /\bbackground (on|of)\b/,
  /\bprofile (of|for)\b/,
]

/**
 * Classify a query into a type with recommended signals and score weights.
 * Pure heuristics — no LLM call, sub-millisecond.
 */
export function classifyQuery(text: string): QueryClassification {
  const lower = text.toLowerCase()

  // Check relational patterns first (most specific)
  for (const pattern of RELATIONAL_PATTERNS) {
    if (pattern.test(lower)) {
      return { type: 'relational', signals: FULL_SIGNALS, weights: WEIGHT_PROFILES['relational'], confidence: 0.8 }
    }
  }

  // Temporal patterns
  for (const pattern of TEMPORAL_PATTERNS) {
    if (pattern.test(lower)) {
      return { type: 'temporal', signals: FULL_SIGNALS, weights: WEIGHT_PROFILES['temporal'], confidence: 0.7 }
    }
  }

  // Entity-centric patterns
  for (const pattern of ENTITY_CENTRIC_PATTERNS) {
    if (pattern.test(lower)) {
      return { type: 'entity-centric', signals: FULL_SIGNALS, weights: WEIGHT_PROFILES['entity-centric'], confidence: 0.7 }
    }
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
  if (entityCount >= 3) {
    return { type: 'entity-centric', signals: FULL_SIGNALS, weights: WEIGHT_PROFILES['entity-centric'], confidence: 0.6 }
  }

  // Factual lookup patterns
  for (const pattern of FACTUAL_PATTERNS) {
    if (pattern.test(lower)) {
      return { type: 'factual-lookup', signals: SEMANTIC_ONLY, weights: WEIGHT_PROFILES['factual-lookup'], confidence: 0.7 }
    }
  }

  // Default: exploratory
  return { type: 'exploratory', signals: SEMANTIC_ONLY, weights: WEIGHT_PROFILES['exploratory'], confidence: 0.3 }
}
