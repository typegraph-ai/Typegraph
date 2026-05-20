# @typegraph-ai/adapter-pgvector-rds

AWS RDS/Postgres convenience wrapper for TypeGraph's Postgres + pgvector
adapter.

Use this package when your self-hosted TypeGraph deployment runs on RDS and you
want `pg.Pool` wiring plus optional IAM authentication.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector-rds @ai-sdk/gateway
```

Install `@aws-sdk/rds-signer` when using IAM auth.

## Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { createRdsAdapter } from '@typegraph-ai/adapter-pgvector-rds'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const vectorStore = await createRdsAdapter(process.env.DATABASE_URL!, {
  iam: {
    region: 'us-east-1',
    hostname: 'database.example.us-east-1.rds.amazonaws.com',
    username: 'typegraph',
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

`createRdsAdapter()` is async because IAM authentication may need to generate a
short-lived token before creating the pool.

## Exports

| Export | Purpose |
| --- | --- |
| `createRdsAdapter` | Create a `PgVectorAdapter` for RDS/Postgres |
| `PgVectorAdapter` | Re-export of the core pgvector adapter |
| `PgVectorAdapterConfig`, `SqlExecutor` | Re-exported core adapter types |

## Related

- [Core pgvector adapter](../pgvector/README.md)
- [SDK README](../../sdk/README.md)
