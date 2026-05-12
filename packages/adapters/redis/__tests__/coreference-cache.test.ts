import { describe, expect, it, vi } from 'vitest'
import type { ExtractedEntity, ExtractionCoreferenceCacheKey } from '@typegraph-ai/sdk'
import { createRedisCoreferenceCache, type RedisCoreferenceClient } from '../src/index.js'

class FakeRedis implements RedisCoreferenceClient {
  values = new Map<string, unknown>()
  getKeys: string[] = []
  sets: Array<{ key: string; value: unknown; options?: { ex?: number | undefined } | undefined }> = []
  failGet = false
  failSet = false

  async get<T = unknown>(key: string): Promise<T | null> {
    this.getKeys.push(key)
    if (this.failGet) throw new Error('get failed')
    return (this.values.get(key) ?? null) as T | null
  }

  async set(key: string, value: unknown, options?: { ex?: number | undefined }): Promise<unknown> {
    if (this.failSet) throw new Error('set failed')
    this.sets.push({ key, value, options })
    this.values.set(key, value)
    return 'OK'
  }
}

const baseKey: ExtractionCoreferenceCacheKey = {
  tenantId: 'tenant_a',
  graphId: 'internal',
  bucketId: 'gong',
  documentId: 'doc_1',
}

function entity(name: string, overrides: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    type: 'organization',
    name,
    aliases: ['alias_1', 'alias_2', 'alias_3'],
    typeCandidates: [
      { type: 'organization', confidence: 0.9 },
      { type: 'customer', confidence: 0.8 },
      { type: 'account', confidence: 0.7 },
    ],
    ...overrides,
  }
}

describe('Redis coreference cache', () => {
  it('saves compacted entities with a TTL', async () => {
    const redis = new FakeRedis()
    const cache = createRedisCoreferenceCache({
      redis,
      ttlSeconds: 60,
      maxEntities: 2,
      maxAliases: 1,
      maxTypeCandidates: 1,
    })

    await cache.save(baseKey, [
      entity('Acme', { id: 'ent_1' }),
      entity('Acme', { id: 'ent_duplicate' }),
      entity('Globex', { id: 'ent_2' }),
      entity('Initech', { id: 'ent_3' }),
    ])

    expect(redis.sets).toHaveLength(1)
    expect(redis.sets[0]?.options).toEqual({ ex: 60 })
    expect(redis.sets[0]?.value).toEqual([
      {
        type: 'organization',
        id: 'ent_1',
        name: 'Acme',
        description: undefined,
        aliases: ['alias_1'],
        typeCandidates: [{ type: 'organization', confidence: 0.9 }],
        metadata: undefined,
      },
      {
        type: 'organization',
        id: 'ent_2',
        name: 'Globex',
        description: undefined,
        aliases: ['alias_1'],
        typeCandidates: [{ type: 'organization', confidence: 0.9 }],
        metadata: undefined,
      },
    ])
  })

  it('loads object arrays and JSON strings and ignores invalid payloads', async () => {
    const redis = new FakeRedis()
    const cache = createRedisCoreferenceCache({ redis })
    await cache.save(baseKey, [])
    const key = redis.sets[0]!.key

    redis.values.set(key, [entity('Acme'), { type: 'organization' }, null])
    expect(await cache.load(baseKey)).toEqual([entity('Acme')])

    redis.values.set(key, JSON.stringify([entity('Globex')]))
    expect(await cache.load(baseKey)).toEqual([entity('Globex')])

    redis.values.set(key, '{not json')
    expect(await cache.load(baseKey)).toEqual([])

    redis.values.delete(key)
    expect(await cache.load(baseKey)).toEqual([])
  })

  it('isolates cache keys by tenant, graph, bucket, actor context, and document', async () => {
    const redis = new FakeRedis()
    const cache = createRedisCoreferenceCache({ redis, namespace: 'cloud' })

    const variants: ExtractionCoreferenceCacheKey[] = [
      baseKey,
      { ...baseKey, tenantId: 'tenant_b' },
      { ...baseKey, graphId: 'public' },
      { ...baseKey, bucketId: 'salesforce' },
      { ...baseKey, organizationId: 'org_acme' },
      { ...baseKey, groupId: 'employees' },
      { ...baseKey, userId: 'dana' },
      { ...baseKey, agentId: 'salesbot' },
      { ...baseKey, threadId: 'thread_1' },
      { ...baseKey, documentId: 'doc_2' },
      { tenantId: 'tenant_a', graphId: 'internal', bucketId: 'gong', documentName: 'Meeting Transcript' },
    ]

    for (const variant of variants) {
      await cache.save(variant, [])
    }

    const keys = redis.sets.map(set => set.key)
    expect(new Set(keys).size).toBe(variants.length)
    expect(keys[0]).toContain('typegraph:coreference:cloud')
    expect(keys[0]).toContain('tenant:tenant_a')
    expect(keys[0]).toContain('graph:internal')
    expect(keys[0]).toContain('bucket:gong')
    expect(keys[0]).toContain('document:doc_1')
    expect(keys[4]).toContain('organization:org_acme')
    expect(keys[5]).toContain('group:employees')
    expect(keys[6]).toContain('user:dana')
    expect(keys[7]).toContain('agent:salesbot')
    expect(keys[8]).toContain('thread:thread_1')
    expect(keys[10]).toContain('documentName:Meeting%20Transcript')
  })

  it('reports Redis failures through onError and degrades to empty loads', async () => {
    const redis = new FakeRedis()
    const onError = vi.fn()
    const cache = createRedisCoreferenceCache({ redis, onError })

    redis.failGet = true
    await expect(cache.load(baseKey)).resolves.toEqual([])

    redis.failSet = true
    await expect(cache.save(baseKey, [entity('Acme')])).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledTimes(2)
  })
})

