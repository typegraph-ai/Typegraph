import { describe, it, expect } from 'vitest'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from '../index-engine/hash.js'
import { createTestDocument } from './helpers/mock-connector.js'

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
    const document = createTestDocument({ url: 'https://example.com/page' })
    const key = resolveIdempotencyKey(document, ['url'])
    expect(key).toBe('https://example.com/page')
  })

  it('resolves multi-field spec joined by ::', () => {
    const document = createTestDocument({ id: 'document-1', url: 'https://example.com/page' })
    const key = resolveIdempotencyKey(document, ['id', 'url'])
    expect(key).toBe('document-1::https://example.com/page')
  })

  it('resolves metadata fields', () => {
    const document = createTestDocument({ metadata: { category: 'tech' } })
    const key = resolveIdempotencyKey(document, ['metadata.category'])
    expect(key).toBe('tech')
  })

  it('returns empty string for missing fields', () => {
    const document = createTestDocument({ metadata: {} })
    const key = resolveIdempotencyKey(document, ['metadata.nonexistent'])
    expect(key).toBe('')
  })

  it('supports function-based spec', () => {
    const document = createTestDocument({ id: 'document-1' })
    const key = resolveIdempotencyKey(document, (d) => `custom-${d.id}`)
    expect(key).toBe('custom-document-1')
  })
})

describe('buildHashStoreKey', () => {
  it('joins tenantId::bucketId::idempotencyKey', () => {
    const key = buildHashStoreKey('tenant-1', 'document-1', 'key-1')
    expect(key).toBe('tenant-1::document-1::key-1')
  })

  it('uses __global__ for undefined tenantId', () => {
    const key = buildHashStoreKey(undefined, 'document-1', 'key-1')
    expect(key).toBe('__global__::document-1::key-1')
  })
})
