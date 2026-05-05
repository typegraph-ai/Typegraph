import { describe, it, expect } from 'vitest'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from '../index-engine/hash.js'
import { createTestSource } from './helpers/mock-connector.js'

describe('sha256', () => {
  it('returns 64-char hex string', () => {
    const result = sha256('hello')
    expect(result).toHaveLength(64)
    expect(result).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'))
  })

  it('produces different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'))
  })
})

describe('resolveIdempotencyKey', () => {
  it('resolves field-based spec', () => {
    const source = createTestSource({ url: 'https://example.com/page' })
    const key = resolveIdempotencyKey(source, ['url'])
    expect(key).toBe('https://example.com/page')
  })

  it('resolves multi-field spec joined by ::', () => {
    const source = createTestSource({ id: 'source-1', url: 'https://example.com/page' })
    const key = resolveIdempotencyKey(source, ['id', 'url'])
    expect(key).toBe('source-1::https://example.com/page')
  })

  it('resolves metadata fields', () => {
    const source = createTestSource({ metadata: { category: 'tech' } })
    const key = resolveIdempotencyKey(source, ['metadata.category'])
    expect(key).toBe('tech')
  })

  it('returns empty string for missing fields', () => {
    const source = createTestSource({ metadata: {} })
    const key = resolveIdempotencyKey(source, ['metadata.nonexistent'])
    expect(key).toBe('')
  })

  it('supports function-based spec', () => {
    const source = createTestSource({ id: 'source-1' })
    const key = resolveIdempotencyKey(source, (d) => `custom-${d.id}`)
    expect(key).toBe('custom-source-1')
  })
})

describe('buildHashStoreKey', () => {
  it('joins tenantId::bucketId::idempotencyKey', () => {
    const key = buildHashStoreKey('tenant-1', 'source-1', 'key-1')
    expect(key).toBe('tenant-1::source-1::key-1')
  })

  it('uses __global__ for undefined tenantId', () => {
    const key = buildHashStoreKey(undefined, 'source-1', 'key-1')
    expect(key).toBe('__global__::source-1::key-1')
  })
})
