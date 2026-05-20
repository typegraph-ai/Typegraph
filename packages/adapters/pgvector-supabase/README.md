# @typegraph-ai/adapter-pgvector-supabase

Supabase/Postgres convenience wrapper for TypeGraph's Postgres + pgvector
adapter.

Use this package when your self-hosted TypeGraph deployment connects to
Supabase Postgres through `postgres.js`.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector-supabase @ai-sdk/gateway
```

## Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { createSupabaseAdapter } from '@typegraph-ai/adapter-pgvector-supabase'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const vectorStore = createSupabaseAdapter(process.env.SUPABASE_DATABASE_URL!, {
  postgresOptions: {
    max: 5,
  },
})

const config = {
  vectorStore,
  embedding: {
    model: gateway.embeddingModel('openai/text-embedding-3-small'),
    dimensions: 1536,
  },
  llm: {
    model: gateway.languageModel('openai/gpt-4.1-mini'),
  },
}

await typegraphDeploy(config)
const tg = await typegraphInit(config)
```

The wrapper uses `postgres.js` with SSL required, exposes the core SQL executor,
and provides transaction support through `client.begin()`.

## Exports

| Export | Purpose |
| --- | --- |
| `createSupabaseAdapter` | Create a `PgVectorAdapter` from a Supabase/Postgres connection string |
| `PgVectorAdapter` | Re-export of the core pgvector adapter |
| `PgVectorAdapterConfig`, `SqlExecutor` | Re-exported core adapter types |

## Related

- [Core pgvector adapter](../pgvector/README.md)
- [SDK README](../../sdk/README.md)
