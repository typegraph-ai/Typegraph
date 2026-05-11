# @typegraph-ai/adapter-redis-upstash

Upstash Redis coreference-cache adapter for self-hosted TypeGraph deployments.

This package is a small Upstash-friendly wrapper around
`@typegraph-ai/adapter-redis`. It provides the same extraction coreference cache
behavior, but its option names and examples are written for `@upstash/redis`.

Cloud users do not configure this adapter. TypeGraph Cloud manages extraction
cache infrastructure for hosted API-key clients.

## What It Does

TypeGraph graph extraction often runs over many chunks, documents, event
payloads, attached transcripts, and thread turns. The extractor needs continuity:
if one chunk resolves `Acme Inc.` to an organization entity, later chunks should
reuse that context instead of treating every mention as a fresh candidate.

This adapter stores a temporary, compact list of recently extracted entities in
Upstash Redis. TypeGraph passes those entities back into subsequent extraction
calls as coreference context.

It helps with:

- consistent entity resolution across chunked documents;
- event extraction with attached documents;
- thread-turn extraction;
- multi-worker and serverless ingestion jobs;
- retries where the extractor benefits from prior context.

It does not store TypeGraph documents, memories, facts, graph edges, embeddings,
jobs, or buckets. Use `@typegraph-ai/adapter-pgvector` for TypeGraph storage.

## Install

```bash
pnpm add @typegraph-ai/adapter-redis-upstash @upstash/redis
```

`@typegraph-ai/adapter-redis-upstash` depends on
`@typegraph-ai/adapter-redis`, so you do not need to import the base Redis
adapter directly unless you are using a different Redis client.

## Usage

```ts
import { Redis } from '@upstash/redis'
import { typegraphInit } from '@typegraph-ai/sdk'
import { createUpstashCoreferenceCache } from '@typegraph-ai/adapter-redis-upstash'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const typegraph = await typegraphInit({
  vectorStore,
  embedding,
  searchEmbedding,
  llm,
  extractionCoreferenceCache: createUpstashCoreferenceCache({
    redis,
    namespace: 'tenant_public',
    ttlSeconds: 4 * 60 * 60,
  }),
})
```

`tenantId` defaults to `public` when omitted. For multi-tenant self-hosted apps,
include your schema, environment, or tenant in `namespace`:

```ts
extractionCoreferenceCache: createUpstashCoreferenceCache({
  redis,
  namespace: `prod:${schemaName}:${tenantId}`,
})
```

## TypeGraph App Usage

The TypeGraph Cloud app uses this package only for its own self-hosted backend
runtime. End users of TypeGraph Cloud should not configure Redis.

Example app wrapper:

```ts
import { Redis } from '@upstash/redis'
import { createUpstashCoreferenceCache } from '@typegraph-ai/adapter-redis-upstash'

export function createCoreferenceCache(schema: string, tenantId = 'public') {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return undefined

  return createUpstashCoreferenceCache({
    redis: new Redis({ url, token }),
    namespace: `${schema}:${tenantId}`,
    onError(error) {
      console.warn('TypeGraph coreference cache unavailable', error)
    },
  })
}
```

## Options

```ts
type UpstashCoreferenceCacheOptions = {
  redis: Redis
  namespace?: string
  ttlSeconds?: number
  maxEntities?: number
  maxAliases?: number
  maxTypeCandidates?: number
  onError?: (error: unknown) => void
}
```

### `redis`

Required `@upstash/redis` client or compatible object with `get` and `set`
methods.

### `namespace`

Optional logical prefix for cache keys. Use this to isolate deployments,
schemas, tenants, or test runs.

### `ttlSeconds`

How long cache entries live. Defaults to 4 hours.

The cache is intentionally temporary. TypeGraph’s durable state still lives in
the configured TypeGraph storage adapter.

### `maxEntities`, `maxAliases`, `maxTypeCandidates`

Compaction limits applied before saving:

- `maxEntities`: default `120`
- `maxAliases`: default `12`
- `maxTypeCandidates`: default `4`

### `onError`

Optional error callback. Cache failures are swallowed after this hook runs, so
Redis downtime does not fail an otherwise valid ingest request.

## When To Use This

Use this package when:

- you self-host TypeGraph or TypeGraph Cloud backend code;
- extraction runs across multiple workers or serverless invocations;
- you want better entity continuity during graph extraction;
- Upstash Redis is already part of your infrastructure.

Do not use it when:

- you are a TypeGraph Cloud customer using only an API key;
- you need a vector database, graph database, or job queue;
- you want permanent memory storage.

## Related Packages

- `@typegraph-ai/adapter-redis`: generic Redis-compatible cache adapter.
- `@typegraph-ai/adapter-pgvector`: Postgres/pgvector TypeGraph storage adapter.
- `@typegraph-ai/sdk`: TypeGraph SDK.
