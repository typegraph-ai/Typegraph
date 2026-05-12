import { describe, expect, it } from 'vitest'
import type { ExtractionCoreferenceCacheKey } from '@typegraph-ai/sdk'
import { createUpstashCoreferenceCache, type UpstashCoreferenceClient } from '../src/index.js'

class FakeUpstashRedis implements UpstashCoreferenceClient {
  values = new Map<string, unknown>()
  sets: Array<{ key: string; value: unknown; options?: { ex?: number | undefined } | undefined }> = []

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.values.get(key) ?? null) as T | null
  }

  async set(key: string, value: unknown, options?: { ex?: number | undefined }): Promise<unknown> {
    this.sets.push({ key, value, options })
    this.values.set(key, value)
    return 'OK'
  }
}

describe('Upstash coreference cache adapter', () => {
  it('delegates to the Redis coreference cache implementation', async () => {
    const redis = new FakeUpstashRedis()
    const cache = createUpstashCoreferenceCache({
      redis,
      namespace: 'upstash',
      ttlSeconds: 120,
    })
    const key: ExtractionCoreferenceCacheKey = {
      tenantId: 'tenant_a',
      graphId: 'internal',
      bucketId: 'gong',
      documentId: 'doc_1',
      userId: 'dana',
    }

    await cache.save(key, [{ type: 'person', name: 'Dana' }])

    expect(redis.sets).toHaveLength(1)
    expect(redis.sets[0]?.key).toContain('typegraph:coreference:upstash')
    expect(redis.sets[0]?.key).toContain('tenant:tenant_a')
    expect(redis.sets[0]?.key).toContain('graph:internal')
    expect(redis.sets[0]?.key).toContain('bucket:gong')
    expect(redis.sets[0]?.key).toContain('document:doc_1')
    expect(redis.sets[0]?.key).toContain('user:dana')
    expect(redis.sets[0]?.options).toEqual({ ex: 120 })
    await expect(cache.load(key)).resolves.toEqual([{ type: 'person', name: 'Dana' }])
  })
})

