# @typegraph-ai/adapter-pgvector-prisma

Prisma convenience wrapper for TypeGraph's Postgres + pgvector adapter.

Use this package when your app already owns a Prisma client and you want
TypeGraph to execute its SQL through that client.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector-prisma @ai-sdk/gateway @prisma/client
```

## Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { PrismaClient } from '@prisma/client'
import { createPrismaAdapter } from '@typegraph-ai/adapter-pgvector-prisma'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const prisma = new PrismaClient()
const vectorStore = createPrismaAdapter(prisma)

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

The wrapper uses Prisma `$queryRawUnsafe` with TypeGraph's parameterized SQL and
passes values separately. It also uses Prisma `$transaction` for operations that
need a transaction-scoped executor.

## Exports

| Export | Purpose |
| --- | --- |
| `createPrismaAdapter` | Create a `PgVectorAdapter` from a Prisma-compatible client |
| `PgVectorAdapter` | Re-export of the core pgvector adapter |
| `PgVectorAdapterConfig`, `SqlExecutor` | Re-exported core adapter types |

## Related

- [Core pgvector adapter](../pgvector/README.md)
- [SDK README](../../sdk/README.md)
