import {
  createRedisCoreferenceCache,
  type RedisCoreferenceCacheOptions,
  type RedisCoreferenceClient,
} from '@typegraph-ai/adapter-redis'

export interface UpstashCoreferenceClient extends RedisCoreferenceClient {}

export interface UpstashCoreferenceCacheOptions extends Omit<RedisCoreferenceCacheOptions, 'redis'> {
  redis: UpstashCoreferenceClient
}

export function createUpstashCoreferenceCache(options: UpstashCoreferenceCacheOptions) {
  return createRedisCoreferenceCache(options)
}
