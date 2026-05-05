# @typegraph-ai/adapter-pgvector

Postgres + [pgvector](https://github.com/pgvector/pgvector) storage for TypeGraph.

This adapter provides source/chunk storage, vector search, BM25 keyword search, hybrid retrieval, jobs, events, policies, and the memory/graph backing store used by TypeGraph graph and memory features.

For complete setup instructions, see [Self-Hosted Initialization](https://typegraph.ai/docs/guides/self-hosted-initialization).

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

Swap `@neondatabase/serverless` for `pg`, Supabase, or another Postgres client if that is what your app uses.

## Basic Usage

```ts
import { gateway } from '@ai-sdk/gateway'
import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@typegraph-ai/adapter-pgvector'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const sql = neon(process.env.DATABASE_URL!)
const vectorStore = new PgVectorAdapter({ sql })

const config = {
  vectorStore,
  embedding: {
    model: gateway.embeddingModel('openai/text-embedding-3-small'),
    dimensions: 1536,
  },
}

await typegraphDeploy(config)
const tg = await typegraphInit(config)
```

The adapter accepts a small `SqlExecutor`, so it is driver-agnostic:

```ts
type SqlExecutor = (
  query: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>
```

## Driver Examples

Neon:

```ts
import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@typegraph-ai/adapter-pgvector'

const sql = neon(process.env.DATABASE_URL!)
const adapter = new PgVectorAdapter({ sql })
```

node-postgres:

```ts
import { Pool } from 'pg'
import { PgVectorAdapter, type SqlExecutor } from '@typegraph-ai/adapter-pgvector'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const sql: SqlExecutor = (query, params) =>
  pool.query(query, params).then(result => result.rows)

const adapter = new PgVectorAdapter({ sql })
```

## Graph And Memory Store

Graph and memory features use the same Postgres connection with `PgMemoryStoreAdapter`.

```ts
import {
  PgMemoryStoreAdapter,
  PgVectorAdapter,
} from '@typegraph-ai/adapter-pgvector'
import {
  createKnowledgeGraphBridge,
  createMemoryBridge,
} from '@typegraph-ai/sdk'

const vectorStore = new PgVectorAdapter({ sql })
const memoryStore = new PgMemoryStoreAdapter({
  sql,
  embeddingDimensions: 1536,
})

const config = {
  vectorStore,
  embedding,
  llm,
  memory: createMemoryBridge({ memoryStore, embedding, llm }),
  knowledgeGraph: createKnowledgeGraphBridge({
    memoryStore,
    embedding,
    resolveChunksTable: model => vectorStore.getTable(model),
  }),
}
```

See [Graph RAG](https://typegraph.ai/docs/guides/graph-rag) for extraction and graph retrieval setup.

## Configuration

```ts
new PgVectorAdapter({
  sql,
  schema: 'public',
  tablePrefix: 'typegraph_chunks',
  hashesTable: 'typegraph_hashes',
  sourcesTable: 'typegraph_sources',
  bucketsTable: 'typegraph_buckets',
  jobsTable: 'typegraph_jobs',
})
```

Most projects only need `sql`. Use `schema` or table overrides when sharing a database with existing applications.

## Exports

| Export | Purpose |
| --- | --- |
| `PgVectorAdapter` | Main Postgres + pgvector adapter |
| `PgMemoryStoreAdapter` | Persistent memory/entity/fact/passage backing store |
| `PgHashStore` | Content-hash deduplication store |
| `PgSourceStore` | Source CRUD store |
| `PgJobStore` | Job tracking store |
| `PgEventSink` | Event sink for query/index telemetry |
| `PgPolicyStore` | Policy storage |
| `SqlExecutor` | Driver-agnostic query function type |

## Learn More

- [TypeGraph docs](https://typegraph.ai/docs)
- [Self-Hosted Initialization](https://typegraph.ai/docs/guides/self-hosted-initialization)
- [Simple RAG](https://typegraph.ai/docs/guides/simple-rag)
- [Graph RAG](https://typegraph.ai/docs/guides/graph-rag)
