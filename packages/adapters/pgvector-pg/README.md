# @typegraph-ai/adapter-pgvector-pg

node-postgres convenience wrapper for TypeGraph's Postgres + pgvector adapter.

Use this package when your self-hosted TypeGraph deployment uses `pg.Pool` and
you want transaction support for adapter operations that need a pinned
connection.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector-pg @ai-sdk/gateway
```

## Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { createPgAdapter } from '@typegraph-ai/adapter-pgvector-pg'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const vectorStore = createPgAdapter(process.env.DATABASE_URL!, {
  poolOptions: {
    max: 10,
    ssl: { rejectUnauthorized: false },
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

`createPgAdapter(connectionString, opts)` creates a `pg.Pool`, wires the
adapter's `SqlExecutor`, and provides a transaction wrapper.

## Exports

| Export | Purpose |
| --- | --- |
| `createPgAdapter` | Create a `PgVectorAdapter` from a node-postgres pool |
| `PgVectorAdapter` | Re-export of the core pgvector adapter |
| `PgVectorAdapterConfig`, `SqlExecutor` | Re-exported core adapter types |

## Related

- [Core pgvector adapter](../pgvector/README.md)
- [SDK README](../../sdk/README.md)
