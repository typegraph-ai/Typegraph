import type { MemoryRecord } from '../types/index.js'

// ── Decay Configuration ──

export interface DecayConfig {
  /** Time in milliseconds for a memory's recency score to halve. Default: 7 days */
  halfLifeMs: number
  /** Importance boost per access. Default: 0.01 */
  accessBoost: number
  /** Below this score, memory is a candidate for forgetting. Default: 0.1 */
  minScore: number
  /** Scoring weights */
  weights: {
    recency: number
    importance: number
    accessFrequency: number
  }
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  accessBoost: 0.01,
  minScore: 0.1,
  weights: {
    recency: 0.4,
    importance: 0.4,
    accessFrequency: 0.2,
  },
}

// ── Decay Scoring ──

/**
 * Compute a memory's decay score.
 * Combines recency (Ebbinghaus-inspired exponential decay),
 * importance, and access frequency.
 *
 * Score range: 0.0 to 1.0
 */
export function decayScore(
  record: MemoryRecord,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
  now: Date = new Date(),
): number {
  const { halfLifeMs, weights } = config

  // Recency: exponential decay based on time since last access
  const lastAccess = record.lastAccessedAt ?? record.createdAt
  const ageMs = Math.max(0, now.getTime() - lastAccess.getTime())
  const decayRate = Math.LN2 / halfLifeMs
  const recency = Math.exp(-decayRate * ageMs)

  // Importance: directly from the record (0-1)
  const importance = Math.max(0, Math.min(1, record.importance))

  // Access frequency: logarithmic scaling, normalized
  const accessFreq = Math.min(1, Math.log(1 + (record.accessCount ?? 0)) / Math.log(100))

  return (
    weights.recency * recency +
    weights.importance * importance +
    weights.accessFrequency * accessFreq
  )
}

/**
 * Apply decay scoring to a list of memory records.
 * Returns records sorted by score (highest first) with scores attached.
 */
export function scoreMemories(
  records: MemoryRecord[],
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
  now: Date = new Date(),
): { record: MemoryRecord; score: number }[] {
  return records
    .map(record => ({ record, score: decayScore(record, config, now) }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Identify memories that have decayed below the minimum score threshold.
 */
export function findDecayedMemories(
  records: MemoryRecord[],
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
  now: Date = new Date(),
): MemoryRecord[] {
  return records.filter(
    record => decayScore(record, config, now) < config.minScore
  )
}
