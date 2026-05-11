import type {
  ExtractedEntity,
  ExtractionCoreferenceCache,
  ExtractionCoreferenceCacheKey,
} from '@typegraph-ai/sdk'

export interface RedisCoreferenceClient {
  get<T = unknown>(key: string): Promise<T | null>
  set(key: string, value: unknown, options?: { ex?: number | undefined }): Promise<unknown>
}

export interface RedisCoreferenceCacheOptions {
  redis: RedisCoreferenceClient
  namespace?: string | undefined
  ttlSeconds?: number | undefined
  maxEntities?: number | undefined
  maxAliases?: number | undefined
  maxTypeCandidates?: number | undefined
  onError?: ((error: unknown) => void) | undefined
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 4
const DEFAULT_MAX_ENTITIES = 120
const DEFAULT_MAX_ALIASES = 12
const DEFAULT_MAX_TYPE_CANDIDATES = 4

export function createRedisCoreferenceCache(options: RedisCoreferenceCacheOptions): ExtractionCoreferenceCache {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES
  const maxAliases = options.maxAliases ?? DEFAULT_MAX_ALIASES
  const maxTypeCandidates = options.maxTypeCandidates ?? DEFAULT_MAX_TYPE_CANDIDATES

  return {
    async load(key) {
      try {
        return normalizeEntities(await options.redis.get(cacheKey(options.namespace, key)))
      } catch (error) {
        options.onError?.(error)
        return []
      }
    },
    async save(key, entities) {
      try {
        await options.redis.set(
          cacheKey(options.namespace, key),
          compactEntities(entities, maxEntities, maxAliases, maxTypeCandidates),
          { ex: ttlSeconds },
        )
      } catch (error) {
        options.onError?.(error)
      }
    },
  }
}

function cacheKey(namespace: string | undefined, key: ExtractionCoreferenceCacheKey): string {
  const parts = [
    'typegraph',
    'coreference',
    namespace ?? 'default',
    key.tenantId ?? 'public',
    key.bucketId,
    key.groupId ? `group:${key.groupId}` : undefined,
    key.userId ? `user:${key.userId}` : undefined,
    key.agentId ? `agent:${key.agentId}` : undefined,
    key.threadId ? `thread:${key.threadId}` : undefined,
  ].filter((part): part is string => Boolean(part))

  return parts.map(encodeURIComponent).join(':')
}

function normalizeEntities(value: unknown): ExtractedEntity[] {
  if (typeof value === 'string') {
    try {
      return normalizeEntities(JSON.parse(value))
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter(isExtractedEntity)
}

function isExtractedEntity(value: unknown): value is ExtractedEntity {
  if (!value || typeof value !== 'object') return false
  const entity = value as Record<string, unknown>
  return typeof entity.type === 'string' && typeof entity.name === 'string'
}

function compactEntities(
  entities: ExtractedEntity[],
  maxEntities: number,
  maxAliases: number,
  maxTypeCandidates: number,
): ExtractedEntity[] {
  const byKey = new Map<string, ExtractedEntity>()
  for (const entity of entities) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`
    if (byKey.has(key)) continue
    byKey.set(key, {
      type: entity.type,
      id: entity.id,
      name: entity.name,
      description: entity.description,
      aliases: entity.aliases?.slice(0, maxAliases),
      typeCandidates: entity.typeCandidates?.slice(0, maxTypeCandidates),
      metadata: entity.metadata,
    })
    if (byKey.size >= maxEntities) break
  }
  return [...byKey.values()]
}
