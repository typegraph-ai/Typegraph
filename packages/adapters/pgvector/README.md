# @typegraph-ai/adapter-pgvector

Postgres + pgvector storage for TypeGraph self-hosted deployments.

This adapter is the default self-hosted storage target for the SDK. It stores
documents, chunks, buckets, business events, threads, links, jobs, policies,
ontology config, telemetry, and the memory/graph backing store used by
`graphExtraction`, `graph.*`, and `memory.*`.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

Use `@neondatabase/serverless`, `pg`, Supabase, Drizzle, or any Postgres driver
that can expose the adapter's small `SqlExecutor` function.

## Requirements

- Postgres with the `vector` extension available.
- pgvector with `halfvec` support. Use pgvector `0.7.0` or newer.
- A database role allowed to run `CREATE EXTENSION IF NOT EXISTS vector`.
- Permission to create tables and indexes in the configured schema.

`typegraphDeploy(config)` creates the extension and all TypeGraph tables. Run it
from deploy/setup code. Use `typegraphInit(config)` from app runtime after
deployment.

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
  searchEmbedding: {
    model: gateway.embeddingModel('openai/text-embedding-3-small'),
    dimensions: 1536,
  },
  llm: {
    model: gateway.languageModel('openai/gpt-4.1-mini'),
  },
  ontology: {
    version: '2026-05-08',
    presets: ['b2b-saas'],
  },
}

await typegraphDeploy(config)
const tg = await typegraphInit(config)
```

Self-hosted apps should not construct public graph or memory bridges. When the
config includes `vectorStore`, `embedding`, and `llm`, the SDK uses this
adapter's `createMemoryStore()` capability to wire graph extraction, graph APIs,
and memory APIs internally.

## SqlExecutor

The adapter accepts a driver-agnostic query function:

```ts
type SqlExecutor = (
  query: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>
```

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

Optional transaction wrapper: pass `transaction` only when your Postgres driver
can pin all statements to the same connection for the duration of the callback.
The adapter uses it for iterative HNSW scan settings that rely on `SET LOCAL`.

## What It Stores

Core storage created by `PgVectorAdapter.deploy()`:

| Table | Purpose |
| --- | --- |
| `typegraph_graphs` | Graph overlay definitions and access config |
| `typegraph_buckets` | Named document/event containers, embedding settings, and write-graph routing |
| `typegraph_documents` | Durable long-form records with `name`, `description`, metadata, and graph id |
| `typegraph_document_chunks_*` | Per-embedding-model chunk tables with `halfvec` embeddings, pgvector HNSW indexes, and Postgres full-text indexes |
| `typegraph_document_chunks_registry` | Registry mapping embedding model keys to dynamic chunk tables |
| `typegraph_hashes` | Content hash and deduplication state |
| `typegraph_hashes_run_times` | Last-run state for replace/sync flows |
| `typegraph_events` | Business events |
| `typegraph_threads` | Ordered containers for turns/messages |
| `typegraph_links` | Internal relationship/provenance links |
| `typegraph_ontology` | Config-driven ontology records |
| `typegraph_telemetry` | SDK telemetry events |
| `typegraph_policies` | Governance policy records |
| `typegraph_jobs` | Job status/progress records |

When graph/memory are enabled, TypeGraph also initializes the memory graph backing
store through `PgMemoryStoreAdapter`. Those internal tables include memories,
semantic entities, entity external IDs, graph edges, chunk mentions, and fact
records. Public SDK calls expose these as entities, facts, graph results, and
private memory APIs.

## Embeddings

The SDK uses separate ingest and search embedders when configured:

```ts
await typegraphInit({
  vectorStore: adapter,
  embedding: documentEmbedder,
  searchEmbedding,
  additionalEmbeddings: [specializedLegalEmbedder],
})
```

Each embedding model/dimension pair gets a separate chunk table. Buckets store
`embeddingModel` and optional `searchEmbeddingModel`; both must point at
registered embedders in the same vector space.

Embeddings are stored as pgvector `halfvec`, not `vector`. The SDK still passes
normal numeric arrays from embedders; the adapter casts them to `halfvec` at the
Postgres boundary and builds HNSW indexes with `halfvec_cosine_ops`. This is a
fresh-schema default, not a compatibility mode. Existing `vector` schemas should
be reset or migrated out of band before reseeding.

## Documents, Events, And Graph Routing

The adapter persists the SDK's public document/event/thread model:

```ts
import { GroupId, UserId, entityRef } from '@typegraph-ai/sdk'

await tg.event.ingest(
  {
    id: 'zendesk:ticket:4242',
    name: 'Acme SSO redirect loop ticket',
    description: 'Acme reported a redirect loop after SAML setup.',
    occurredAt: new Date(),
    participants: [
      entityRef('organization', 'org_acme'),
      entityRef('product_area', 'auth'),
      entityRef('issue', 'sso_redirect_loop'),
    ],
    documents: [
      {
        id: 'zendesk:ticket:4242:body',
        name: 'Acme SSO ticket body',
        description: 'Support ticket details and troubleshooting notes.',
        content: ticketBody,
        metadata: { provider: 'zendesk' },
      },
    ],
    metadata: { provider: 'zendesk', ticketId: '4242' },
  },
  {
    bucketId: 'zendesk',
    context: {
      userId: UserId('dana'),
      groupId: GroupId('support'),
    },
  },
)
```

The selected bucket decides the write graph. If no bucket is supplied, TypeGraph
uses bucket `public`, which writes to graph `public`. Participants are stored for
business graph/provenance and do not grant access automatically.

## Search Support

The adapter supports:

- Semantic vector search over chunk embeddings.
- Postgres full-text keyword search over chunk content.
- Hybrid search used by SDK `weights.semantic` and `weights.bm25`.
- Metadata, bucket, document, tenant, identity, and graph filtering.
- Recency fields used by SDK recency scoring.
- Graph/memory backing store when configured through TypeGraph.

Use SDK search options to select resources and weights:

```ts
const response = await tg.search('Which customers are blocked by SSO issues?', {
  graph: 'internal',
  context: {
    userId: UserId('dana'),
    groupId: GroupId('product'),
  },
  resources: ['events', 'documents', 'facts', 'entities'],
  weights: { semantic: 1, bm25: 0.7, graph: 0.8, recency: 0.3 },
  promptBuilder: true,
  explain: true,
})
```

## Configuration

```ts
new PgVectorAdapter({
  sql,
  transaction,
  schema: 'public',
  tablePrefix: 'typegraph_document_chunks',
  hashesTable: 'typegraph_hashes',
  documentsTable: 'typegraph_documents',
  bucketsTable: 'typegraph_buckets',
  jobsTable: 'typegraph_jobs',
})
```

Most projects only need `sql`. Use `schema` when TypeGraph should live in a
dedicated Postgres schema. Use table overrides only when integrating into an
existing database naming scheme.

`tablePrefix` controls the dynamic per-embedding-model chunk table prefix, not
every TypeGraph table name.

## Exports

| Export | Purpose |
| --- | --- |
| `PgVectorAdapter` | Main Postgres + pgvector adapter |
| `PgMemoryStoreAdapter` | Internal persistent memory/entity/fact backing store |
| `PgHashStore` | Content-hash deduplication store |
| `PgDocumentStore` | Document CRUD store |
| `PgJobStore` | Job tracking store |
| `PgEventSink` | Telemetry event sink backed by `typegraph_telemetry` |
| `PgPolicyStore` | Policy storage |
| `SqlExecutor` | Driver-agnostic query function type |

## Learn More

- [TypeGraph docs](https://typegraph.ai/docs)
- [Self-Hosted Initialization](https://typegraph.ai/docs/guides/self-hosted-initialization)
- [Repository README](../../../README.md)
