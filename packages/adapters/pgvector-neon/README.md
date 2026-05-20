# @typegraph-ai/adapter-pgvector-neon

Neon convenience wrapper for TypeGraph's Postgres + pgvector adapter.

Use this package when your self-hosted TypeGraph deployment stores data in Neon
and you want the adapter to create the Neon SQL executor for you.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector-neon @ai-sdk/gateway
```

## Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { createNeonAdapter } from '@typegraph-ai/adapter-pgvector-neon'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const vectorStore = createNeonAdapter(process.env.DATABASE_URL!, {
  schema: 'public',
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

`createNeonAdapter(connectionString, opts)` returns the same `PgVectorAdapter`
from `@typegraph-ai/adapter-pgvector`, with Neon wired as the SQL executor.

## Exports

| Export | Purpose |
| --- | --- |
| `createNeonAdapter` | Create a `PgVectorAdapter` from a Neon connection string |
| `PgVectorAdapter` | Re-export of the core pgvector adapter |
| `PgVectorAdapterConfig`, `SqlExecutor` | Re-exported core adapter types |

## Related

- [Core pgvector adapter](../pgvector/README.md)
- [SDK README](../../sdk/README.md)
