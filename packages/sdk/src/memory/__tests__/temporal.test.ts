import { describe, it, expect } from 'vitest'
import {
  isActiveAt,
  isActiveBetween,
  invalidateRecord,
  expireRecord,
  createTemporal,
  temporalOverlaps,
  transitionStatus,
} from '../temporal.js'
import type { TemporalRecord } from '../types/memory.js'

function makeRecord(overrides?: Partial<TemporalRecord>): TemporalRecord {
  return {
    validAt: new Date('2025-01-01'),
    createdAt: new Date('2025-01-01'),
    ...overrides,
  }
}

describe('isActiveAt', () => {
  it('returns true for a record valid at the given time', () => {
    const record = makeRecord({ validAt: new Date('2025-01-01') })
    expect(isActiveAt(record, new Date('2025-06-01'))).toBe(true)
  })

  it('returns false before validAt', () => {
    const record = makeRecord({ validAt: new Date('2025-06-01') })
    expect(isActiveAt(record, new Date('2025-01-01'))).toBe(false)
  })

  it('returns false after invalidAt', () => {
    const record = makeRecord({
      validAt: new Date('2025-01-01'),
      invalidAt: new Date('2025-06-01'),
    })
    expect(isActiveAt(record, new Date('2025-07-01'))).toBe(false)
  })

  it('returns true at exact validAt boundary', () => {
    const t = new Date('2025-01-01')
    const record = makeRecord({ validAt: t })
    expect(isActiveAt(record, t)).toBe(true)
  })

  it('returns false at exact invalidAt boundary', () => {
    const t = new Date('2025-06-01')
    const record = makeRecord({ validAt: new Date('2025-01-01'), invalidAt: t })
    expect(isActiveAt(record, t)).toBe(false)
  })

  it('returns false after expiredAt', () => {
    const record = makeRecord({
      validAt: new Date('2025-01-01'),
      expiredAt: new Date('2025-03-01'),
    })
    expect(isActiveAt(record, new Date('2025-04-01'))).toBe(false)
  })
})

describe('isActiveBetween', () => {
  it('returns true when record overlaps the range', () => {
    const record = makeRecord({ validAt: new Date('2025-01-01') })
    expect(isActiveBetween(record, new Date('2025-06-01'), new Date('2025-12-01'))).toBe(true)
  })

  it('returns false when record starts after range ends', () => {
    const record = makeRecord({ validAt: new Date('2026-01-01') })
    expect(isActiveBetween(record, new Date('2025-01-01'), new Date('2025-12-01'))).toBe(false)
  })

  it('returns false when record invalidated before range starts', () => {
    const record = makeRecord({
      validAt: new Date('2024-01-01'),
      invalidAt: new Date('2024-06-01'),
    })
    expect(isActiveBetween(record, new Date('2025-01-01'), new Date('2025-12-01'))).toBe(false)
  })
})

describe('invalidateRecord', () => {
  it('sets invalidAt and expiredAt', () => {
    const record = makeRecord()
    const invalidated = invalidateRecord(record, new Date('2025-06-01'))
    expect(invalidated.invalidAt).toEqual(new Date('2025-06-01'))
    expect(invalidated.expiredAt).toBeDefined()
  })

  it('does not mutate the original', () => {
    const record = makeRecord()
    invalidateRecord(record, new Date('2025-06-01'))
    expect(record.invalidAt).toBeUndefined()
  })

  it('defaults invalidAt to now when not provided', () => {
    const before = new Date()
    const record = makeRecord()
    const invalidated = invalidateRecord(record)
    expect(invalidated.invalidAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })
})

describe('expireRecord', () => {
  it('sets expiredAt', () => {
    const record = makeRecord()
    const expired = expireRecord(record)
    expect(expired.expiredAt).toBeDefined()
  })

  it('does not mutate the original', () => {
    const record = makeRecord()
    expireRecord(record)
    expect(record.expiredAt).toBeUndefined()
  })
})

describe('createTemporal', () => {
  it('creates a record with validAt and createdAt set to now', () => {
    const before = new Date()
    const record = createTemporal()
    expect(record.validAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(record.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(record.invalidAt).toBeUndefined()
    expect(record.expiredAt).toBeUndefined()
  })

  it('accepts a custom validAt', () => {
    const custom = new Date('2020-01-01')
    const record = createTemporal(custom)
    expect(record.validAt).toEqual(custom)
  })
})

describe('temporalOverlaps', () => {
  it('detects overlapping records', () => {
    const a = makeRecord({ validAt: new Date('2025-01-01'), invalidAt: new Date('2025-06-01') })
    const b = makeRecord({ validAt: new Date('2025-03-01'), invalidAt: new Date('2025-09-01') })
    expect(temporalOverlaps(a, b)).toBe(true)
  })

  it('detects non-overlapping records', () => {
    const a = makeRecord({ validAt: new Date('2025-01-01'), invalidAt: new Date('2025-03-01') })
    const b = makeRecord({ validAt: new Date('2025-06-01'), invalidAt: new Date('2025-09-01') })
    expect(temporalOverlaps(a, b)).toBe(false)
  })

  it('treats open-ended records as overlapping with everything after validAt', () => {
    const a = makeRecord({ validAt: new Date('2025-01-01') }) // no invalidAt
    const b = makeRecord({ validAt: new Date('2030-01-01') })
    expect(temporalOverlaps(a, b)).toBe(true)
  })
})

describe('transitionStatus', () => {
  it('allows pending → active', () => {
    expect(transitionStatus('pending', 'active')).toBe('active')
  })

  it('allows active → consolidated', () => {
    expect(transitionStatus('active', 'consolidated')).toBe('consolidated')
  })

  it('allows active → invalidated', () => {
    expect(transitionStatus('active', 'invalidated')).toBe('invalidated')
  })

  it('allows active → archived', () => {
    expect(transitionStatus('active', 'archived')).toBe('archived')
  })

  it('allows archived → active (reactivation)', () => {
    expect(transitionStatus('archived', 'active')).toBe('active')
  })

  it('allows archived → expired', () => {
    expect(transitionStatus('archived', 'expired')).toBe('expired')
  })

  it('allows invalidated → expired', () => {
    expect(transitionStatus('invalidated', 'expired')).toBe('expired')
  })

  it('allows consolidated → archived', () => {
    expect(transitionStatus('consolidated', 'archived')).toBe('archived')
  })

  it('allows consolidated → expired', () => {
    expect(transitionStatus('consolidated', 'expired')).toBe('expired')
  })

  it('throws on invalid transition: pending → archived', () => {
    expect(() => transitionStatus('pending', 'archived')).toThrow('Invalid status transition')
  })

  it('throws on invalid transition: expired → active', () => {
    expect(() => transitionStatus('expired', 'active')).toThrow('Invalid status transition')
  })

  it('throws on invalid transition: active → pending', () => {
    expect(() => transitionStatus('active', 'pending')).toThrow('Invalid status transition')
  })
})
