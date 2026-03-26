import { describe, it, expect } from 'vitest'
import { decayScore, scoreMemories, findDecayedMemories, DEFAULT_DECAY_CONFIG } from '../decay.js'
import type { MemoryRecord } from '@d8um/memory'
import { buildScope } from '@d8um/memory'

const scope = buildScope({ userId: 'test' })

function makeRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'r1',
    category: 'semantic',
    content: 'Test memory',
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope,
    validAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  }
}

describe('decayScore', () => {
  it('returns high score for recently accessed, important memory', () => {
    const record = makeRecord({
      importance: 0.9,
      accessCount: 10,
      lastAccessedAt: new Date(),
    })
    const score = decayScore(record)
    expect(score).toBeGreaterThan(0.5)
  })

  it('returns lower score for old, rarely accessed memory', () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
    const record = makeRecord({
      importance: 0.1,
      accessCount: 0,
      lastAccessedAt: longAgo,
    })
    const score = decayScore(record)
    expect(score).toBeLessThan(0.3)
  })

  it('applies exponential decay based on half-life', () => {
    const now = new Date()
    const halfLife = DEFAULT_DECAY_CONFIG.halfLifeMs

    const fresh = makeRecord({ lastAccessedAt: now })
    const atHalfLife = makeRecord({ lastAccessedAt: new Date(now.getTime() - halfLife) })
    const atTwoHalfLives = makeRecord({ lastAccessedAt: new Date(now.getTime() - 2 * halfLife) })

    const freshScore = decayScore(fresh, DEFAULT_DECAY_CONFIG, now)
    const halfScore = decayScore(atHalfLife, DEFAULT_DECAY_CONFIG, now)
    const twoScore = decayScore(atTwoHalfLives, DEFAULT_DECAY_CONFIG, now)

    // Scores should decrease with age
    expect(freshScore).toBeGreaterThan(halfScore)
    expect(halfScore).toBeGreaterThan(twoScore)
  })

  it('access count boosts score', () => {
    const noAccess = makeRecord({ accessCount: 0 })
    const manyAccess = makeRecord({ accessCount: 50 })

    expect(decayScore(manyAccess)).toBeGreaterThan(decayScore(noAccess))
  })
})

describe('scoreMemories', () => {
  it('returns records sorted by score (highest first)', () => {
    const records = [
      makeRecord({ id: 'old', importance: 0.1, accessCount: 0, lastAccessedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }),
      makeRecord({ id: 'fresh', importance: 0.9, accessCount: 10, lastAccessedAt: new Date() }),
    ]

    const scored = scoreMemories(records)
    expect(scored[0]!.record.id).toBe('fresh')
    expect(scored[1]!.record.id).toBe('old')
  })
})

describe('findDecayedMemories', () => {
  it('identifies memories below the threshold', () => {
    const old = makeRecord({
      id: 'old',
      importance: 0.01,
      accessCount: 0,
      lastAccessedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
    })

    const fresh = makeRecord({
      id: 'fresh',
      importance: 0.9,
      accessCount: 10,
      lastAccessedAt: new Date(),
    })

    const decayed = findDecayedMemories([old, fresh])
    expect(decayed.map(m => m.id)).toContain('old')
    expect(decayed.map(m => m.id)).not.toContain('fresh')
  })
})
