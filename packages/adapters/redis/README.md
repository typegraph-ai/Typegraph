# @typegraph-ai/adapter-redis

Redis-backed cache utilities for self-hosted TypeGraph deployments.

This package currently provides an extraction coreference cache. It is not a
vector store, memory store, graph store, or queue adapter. Its job is narrower:
it lets TypeGraph remember recently resolved entities during extraction so
large document, event, and thread ingestion jobs keep entity names consistent
across chunks and batches.

Cloud users do not configure this adapter. TypeGraph Cloud manages extraction
cache infrastructure for hosted API-key clients.

## What It Does

During graph extraction, TypeGraph may see the same real-world entity many times:

- `Acme`
- `Acme Inc.`
- `ACME Corporation`
- `the customer`

The extractor resolves those mentions into normalized entities. Without a shared
cache, each chunk or worker may have to rediscover the same mappings. With this
adapter, TypeGraph stores a compact list of recently extracted entities in Redis
and passes it back into later extraction calls.

That improves:

- entity consistency across chunks;
- event/document/thread extraction continuity;
- multi-worker self-hosted ingestion behavior;
- retry behavior after transient extraction failures.

It does not grant access, route graph writes, or change search results by itself.
Access and graph boundaries still come from TypeGraph tenant, graph, bucket, and
context configuration.

## Install

```bash
pnpm add @typegraph-ai/adapter-redis
```

You also need a Redis client. This package intentionally does not depend on a
specific Redis library. It accepts any client with compatible `get` and `set`
methods.

```ts
interface RedisCoreferenceClient {
  get<T = unknown>(key: string): Promise<T | null>
  set(key: string, value: unknown, options?: { ex?: number }): Promise<unknown>
}
```

For Upstash, use `@typegraph-ai/adapter-redis-upstash`.

## Usage

```ts
import { typegraphInit } from '@typegraph-ai/sdk'
import { createRedisCoreferenceCache } from '@typegraph-ai/adapter-redis'

const extractionCoreferenceCache = createRedisCoreferenceCache({
  redis,
  namespace: 'tenant_public',
  ttlSeconds: 4 * 60 * 60,
})

const typegraph = await typegraphInit({
  vectorStore,
  embedding,
  searchEmbedding,
  llm,
  extractionCoreferenceCache,
})
```

`tenantId` defaults to `public` when omitted. For multi-tenant self-hosted apps,
use a namespace that includes your tenant or deployment boundary:

```ts
const extractionCoreferenceCache = createRedisCoreferenceCache({
  redis,
  namespace: `schema_${schemaName}:tenant_${tenantId}`,
})
```

## Options

```ts
type RedisCoreferenceCacheOptions = {
  redis: RedisCoreferenceClient
  namespace?: string
  ttlSeconds?: number
  maxEntities?: number
  maxAliases?: number
  maxTypeCandidates?: number
  onError?: (error: unknown) => void
}
```

### `redis`

Required Redis-compatible client.

The adapter stores JSON-compatible arrays of extracted entity records. The Redis
client may serialize values itself, or it may return strings. The adapter handles
both parsed arrays and JSON strings on reads.

### `namespace`

Optional logical prefix for cache keys. Use this to isolate environments,
schemas, tenants, or test runs.

The final key also includes TypeGraph extraction context such as tenant, bucket,
group, user, agent, and thread when those fields are available.

### `ttlSeconds`

How long cache entries live. Defaults to 4 hours.

This cache is intentionally temporary. It should help active ingestion jobs
maintain continuity, not become a permanent entity store.

### `maxEntities`, `maxAliases`, `maxTypeCandidates`

Compaction limits applied before saving. Defaults are conservative so the cache
stays small:

- `maxEntities`: `120`
- `maxAliases`: `12`
- `maxTypeCandidates`: `4`

### `onError`

Optional error hook. Cache failures are swallowed after calling this hook. This
is deliberate: Redis should improve extraction quality and throughput, but it
should not make document ingestion fail when the primary database and extractor
are healthy.

## Key Shape

Keys are URL-encoded and prefixed:

```text
typegraph:coreference:<namespace>:<tenantId>:<bucketId>:group:<groupId>:user:<userId>:agent:<agentId>:thread:<threadId>
```

Only fields present in the extraction context are included.

## Self-Hosted vs Cloud

Use this adapter when you run TypeGraph yourself and want Redis-backed extraction
continuity across workers.

Do not use it when calling TypeGraph Cloud with an API key. Cloud manages this
cache internally and may use different infrastructure.

## Related Packages

- `@typegraph-ai/adapter-redis-upstash`: Upstash Redis wrapper around this package.
- `@typegraph-ai/adapter-pgvector`: Postgres/pgvector storage adapter for TypeGraph data.
- `@typegraph-ai/sdk`: TypeGraph SDK.
