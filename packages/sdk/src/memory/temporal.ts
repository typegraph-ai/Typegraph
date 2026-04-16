import type { TemporalRecord, MemoryStatus } from './types/memory.js'

/**
 * Check if a temporal record is active (valid and not expired) at a given point in time.
 *
 * A record is active at time `at` if:
 * - validAt <= at
 * - invalidAt is undefined OR invalidAt > at
 * - expiredAt is undefined OR expiredAt > at
 */
export function isActiveAt(record: TemporalRecord, at: Date): boolean {
  if (record.validAt > at) return false
  if (record.invalidAt !== undefined && record.invalidAt <= at) return false
  if (record.expiredAt !== undefined && record.expiredAt <= at) return false
  return true
}

/**
 * Check if a temporal record is active during any point in a time range.
 */
export function isActiveBetween(record: TemporalRecord, start: Date, end: Date): boolean {
  // Record becomes valid before the range ends
  if (record.validAt > end) return false
  // Record is invalidated before the range starts
  if (record.invalidAt !== undefined && record.invalidAt <= start) return false
  // Record is expired before the range starts
  if (record.expiredAt !== undefined && record.expiredAt <= start) return false
  return true
}

/**
 * Invalidate a temporal record - mark it as no longer true in the real world.
 * Returns a new record with invalidAt set. Does not mutate the original.
 */
export function invalidateRecord<T extends TemporalRecord>(
  record: T,
  invalidAt?: Date,
): T {
  return {
    ...record,
    invalidAt: invalidAt ?? new Date(),
    expiredAt: record.expiredAt ?? new Date(),
  }
}

/**
 * Expire a temporal record - mark it as superseded in the system.
 * Returns a new record with expiredAt set. Does not mutate the original.
 */
export function expireRecord<T extends TemporalRecord>(record: T): T {
  return {
    ...record,
    expiredAt: new Date(),
  }
}

/**
 * Create a fresh TemporalRecord with sensible defaults.
 * validAt defaults to now if not provided.
 */
export function createTemporal(validAt?: Date): TemporalRecord {
  const now = new Date()
  return {
    validAt: validAt ?? now,
    createdAt: now,
  }
}

/**
 * Check if two temporal records overlap in their valid time windows.
 */
export function temporalOverlaps(a: TemporalRecord, b: TemporalRecord): boolean {
  const aEnd = a.invalidAt ?? new Date(8640000000000000) // far future
  const bEnd = b.invalidAt ?? new Date(8640000000000000)
  return a.validAt < bEnd && b.validAt < aEnd
}

// ── Status Transitions ──

const ALLOWED_TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  pending: ['active'],
  active: ['consolidated', 'invalidated', 'archived'],
  consolidated: ['archived', 'expired'],
  invalidated: ['expired'],
  archived: ['active', 'expired'],
  expired: [],
}

/**
 * Transition a memory record to a new status.
 * Validates the transition is allowed. Throws if not.
 * Returns a new status value (does not mutate anything).
 */
export function transitionStatus(
  current: MemoryStatus,
  next: MemoryStatus,
): MemoryStatus {
  const allowed = ALLOWED_TRANSITIONS[current]
  if (!allowed.includes(next)) {
    throw new Error(`Invalid status transition: ${current} → ${next}`)
  }
  return next
}
