# @typegraph-ai/adapter-pgvector-nile

Nile convenience wrapper for TypeGraph's Postgres + pgvector adapter.

Use this package when your self-hosted TypeGraph deployment uses a Nile
`Server` instance and you want TypeGraph to run against `server.db`.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector-nile @ai-sdk/gateway
```

## Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { type Server, createNileAdapter } from '@typegraph-ai/adapter-pgvector-nile'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

declare const server: Server

const vectorStore = createNileAdapter(server)

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

Nile tenant scoping remains the responsibility of your Nile server setup.
TypeGraph still uses its own `tenantId`, graph config, buckets, and per-call
`context` for TypeGraph access boundaries.

## Exports

| Export | Purpose |
| --- | --- |
| `createNileAdapter` | Create a `PgVectorAdapter` from a Nile `Server` |
| `Server`, `ServerConfig` | Re-exported Nile types |
| `PgVectorAdapter`, `PgVectorAdapterConfig`, `SqlExecutor` | Re-exported core adapter APIs |

## Related

- [Core pgvector adapter](../pgvector/README.md)
- [SDK README](../../sdk/README.md)
