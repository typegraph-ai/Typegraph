<div align="center">
  <img src="typegraph-logo-dark.png" alt="TypeGraph" width="50" />
  <h1>TypeGraph</h1>
  <p>A TypeScript context graph layer for business AI applications.</p>
</div>

<div align="center">
  <p>
    <img src="https://img.shields.io/badge/MIT%20License-3DA639?logo=opensourceinitiative&logoColor=white" alt="MIT License" />
    <img src="https://img.shields.io/badge/TypeScript%20Native-3178C6?logo=typescript&logoColor=white" alt="TypeScript native" />
    <img src="https://img.shields.io/badge/PostgreSQL%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL and pgvector" />
    <img src="https://img.shields.io/badge/Vercel%20AI%20SDK-000000?logo=vercel&logoColor=white" alt="Vercel AI SDK" />
  </p>
</div>

TypeGraph gives AI apps a typed layer for business context: buckets,
documents, events, threads, entities, facts, memory, search, jobs, policies,
ontology, and telemetry. It runs against TypeGraph Cloud or self-hosted
Postgres with pgvector.

This branch reflects the current breaking SDK shape. The old `source` and
`query` surfaces have been replaced by `document` and `search`, `tenantId` is
client-scoped, per-call identity/access lives under `context`, and SQLite vector
storage is no longer supported.

For deeper guides and production patterns, use the docs:
[typegraph.ai/docs](https://typegraph.ai/docs).

## Install

Cloud projects usually need only the SDK:

```bash
pnpm add @typegraph-ai/sdk
```

Self-hosted projects need the SDK, the pgvector adapter, a Postgres client, and
the AI provider package used by your app:

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

## Quick Start

Cloud mode runs storage, embedding, indexing, graph, and memory server-side.
`tenantId` is required on init and is the hard namespace boundary for every
record.

```ts
import { typegraphInit, UserId, entityRef } from '@typegraph-ai/sdk'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
  tenantId: 'tenant_acme',
})

await tg.document.ingest(
  {
    id: 'handbook:sso',
    name: 'Employee handbook',
    description: 'Internal handbook section for SSO setup.',
    content: 'Acme employees configure SSO from the admin security page.',
    metadata: { system: 'notion' },
  },
  {
    context: {
      userId: UserId('dana'),
      principals: [entityRef('group', 'it')],
      access: [entityRef('group', 'it')],
    },
    graphExtraction: true,
  },
)

const response = await tg.search('How do employees configure SSO?', {
  context: {
    userId: UserId('dana'),
    principals: [entityRef('group', 'it')],
  },
  resources: ['documents', 'facts', 'entities'],
  weights: { semantic: 1, bm25: 0.7, graph: 0.5, recency: 0.3 },
  promptBuilder: {
    format: 'xml',
    sections: ['chunks', 'facts', 'entities'],
    maxTotalTokens: 4000,
  },
})

console.log(response.prompt)
```

Self-hosted mode uses the same runtime API, but you provide storage, embedding,
and LLM configuration. `vectorStore + embedding + llm` is enough to enable
document ingest, search, graph extraction, graph APIs, and memory APIs when the
adapter supports those capabilities.

```ts
import { gateway } from '@ai-sdk/gateway'
import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@typegraph-ai/adapter-pgvector'
import { typegraphDeploy, typegraphInit } from '@typegraph-ai/sdk'

const sql = neon(process.env.DATABASE_URL!)
const vectorStore = new PgVectorAdapter({ sql })

const config = {
  tenantId: 'tenant_acme',
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
    entities: {
      organization: { description: 'A company, customer, vendor, or partner.' },
      person: { description: 'A human user, employee, or contact.' },
      system: { description: 'A software system or business application.' },
    },
    relations: {
      USES: { from: ['organization'], to: ['system'] },
      OWNS: { from: ['organization', 'person'], to: ['system'] },
      WORKS_WITH: { from: ['person'], to: ['organization', 'person'] },
    },
  },
}

await typegraphDeploy(config)
const tg = await typegraphInit(config)
```

`typegraphDeploy(config)` provisions storage and is intended for deploy scripts.
`typegraphInit(config)` is the lightweight runtime initializer for app boot.
Self-hosted users do not need to call bridge constructors.

## Core Model

Primary records use the same naming shape where applicable:

```ts
{
  id: string
  name: string
  description?: string
  metadata?: Record<string, unknown>
}
```

The main public namespaces are:

| Namespace | Purpose |
| --- | --- |
| `tg.bucket` | Named containers for documents and events. Search accepts bucket ids or bucket names. |
| `tg.document` | Durable long-form content with chunks and embeddings. |
| `tg.event` | Time-anchored business occurrences with participants and attached documents. |
| `tg.thread` | Ordered containers; turns are stored as linked events. |
| `tg.search` | Unified retrieval over selected resources. |
| `tg.graph` | Entity, fact, edge, external ID, merge, explore, and graph search APIs. |
| `tg.remember`, `tg.recall`, `tg.correct`, `tg.forget` | Memory operations. |
| `tg.job` | Job tracking primitives. |
| `tg.policy` | Governance policy CRUD when a policy store is configured. |

## Identity And Access

`tenantId` is configured once on `typegraphInit()` or `typegraphDeploy()`.
Per-call identity and record access use one optional key: `context`.

```ts
import {
  AgentId,
  GroupId,
  ThreadId,
  UserId,
  entityRef,
  type TypeGraphContext,
} from '@typegraph-ai/sdk'

const context: TypeGraphContext = {
  groupId: GroupId('product'),
  userId: UserId('dana'),
  agentId: AgentId('product-ops-agent'),
  threadId: ThreadId('thread_123'),
  principals: [entityRef('group', 'success')],
  access: [entityRef('group', 'product'), entityRef('group', 'success')],
}
```

`context.access` is not the graph model. It does not mean "link this record to
these entities." It only controls who can search the record later. Empty or
omitted means tenant-wide visibility. A non-empty access list is OR-based: the
record is searchable when the caller has at least one matching read principal.
Read principals are derived from `groupId`, `userId`, `agentId`, `threadId`,
plus `principals`.

Use events, participants, entities, and facts to model business relationships.
Use `context.access` to model read permissions. Event `participants` are
provenance only; they do not grant access.

For B2B product intelligence, do not scope every customer signal only to the
customer organization. If a product manager needs to ask "Which customers are
experiencing SSO redirect loops?", the product team must be able to read the
customer-signal records. Use `participants` to link the signal to
`org_acme`; use `context.access` to make the signal visible to internal teams
such as product and customer success.

## Documents, Events, And Threads

Documents are the primary long-form ingest target. A raw transcript often has a
narrower audience than the product signal extracted from it:

```ts
await tg.document.ingest(
  {
    id: 'gong:transcript:123',
    name: 'Acme discovery call transcript',
    description: 'Transcript from the Acme discovery call.',
    content: transcriptText,
    metadata: { provider: 'gong' },
  },
  {
    context: {
      userId: UserId('dana'),
      access: [
        entityRef('group', 'sales'),
        entityRef('group', 'success'),
      ],
    },
    bucketId: 'gong',
    graphExtraction: true,
    idempotencyKey: 'gong:transcript:123',
  },
)
```

Events model business activity. This event is a product signal from the Acme
call. The `participants` create the business shape for graph extraction and
exploration; `context.access` makes the signal searchable by internal product
and success teams across customers.

```ts
await tg.event.ingest(
  {
    id: 'gong:meeting:123:signal:sso-redirect-loop',
    name: 'Acme reports SSO redirect loop',
    description: 'Acme is blocked by a SAML redirect loop during SSO rollout.',
    occurredAt: new Date(),
    participants: [
      entityRef('organization', 'org_acme'),
      entityRef('product_area', 'auth'),
      entityRef('issue', 'sso_redirect_loop'),
    ],
    content: 'Acme reports that SAML login loops after the IdP callback. This is blocking enterprise rollout.',
    metadata: { provider: 'gong', meetingId: '123', severity: 'high' },
  },
  {
    context: {
      userId: UserId('dana'),
      access: [
        entityRef('group', 'product'),
        entityRef('group', 'success'),
      ],
    },
    bucketId: 'gong',
    graphExtraction: true,
  },
)
```

That supports cross-customer questions:

```ts
const response = await tg.search('Which customers are experiencing SSO redirect loops?', {
  context: { groupId: GroupId('product') },
  resources: ['events', 'facts', 'entities'],
  weights: { semantic: 1, bm25: 0.5, graph: 0.9, recency: 0.4 },
  promptBuilder: { format: 'markdown', sections: ['facts', 'entities'] },
})
```

If a customer portal user should see their own records, include
`entityRef('organization', 'org_acme')` in `context.access`. If a record is
internal-only, do not include the customer organization in `context.access`;
keep the customer organization in `participants` instead.

Threads are ordered containers. `thread.addTurn()` stores the turn as an event
and links the event back to the thread. A turn has only role, content,
timestamp, and metadata.

```ts
await tg.thread.addTurn(
  'thread_support_123',
  {
    role: 'user',
    content: 'Can you send the SOC2 report?',
    timestamp: new Date(),
    metadata: { channel: 'slack' },
  },
  {
    context: {
      userId: UserId('dana'),
      threadId: ThreadId('thread_support_123'),
      access: [
        entityRef('group', 'support'),
        entityRef('group', 'success'),
      ],
    },
    graphExtraction: true,
  },
)
```

`document.ingest()` and `event.ingest()` accept a single input or an array.
`abortSignal` is available on write and search options for cancellation.

## Search

`tg.search()` separates target selection from retrieval scoring.

`resources` selects what to search:

```ts
type SearchResource =
  | 'documents'
  | 'events'
  | 'threads'
  | 'entities'
  | 'facts'
  | 'memories'
```

`weights` controls how candidates are scored and fused:

| Weight | Purpose | Default |
| --- | --- | --- |
| `semantic` | Embedding search over content-bearing records | `1` |
| `bm25` | Keyword/BM25 search fused with semantic results | `0.7` |
| `graph` | Graph-aware facts, entities, and chunk expansion | `0.5` |
| `recency` | Prefer fresher records in final scoring | `0.3` |

Set a weight to `false` to disable that signal.

```ts
const response = await tg.search('How are Alice and Acme related?', {
  context: { userId: UserId('dana') },
  buckets: ['salesforce', 'slack'],
  resources: ['documents', 'events', 'facts', 'entities'],
  weights: { semantic: 1, bm25: 0.7, graph: 0.8, recency: 0.2 },
  fusion: { method: 'rrf', k: 60 },
  rerank: { topK: 20, domain: 'general' },
  explain: true,
  promptBuilder: {
    format: 'markdown',
    sections: ['chunks', 'facts', 'entities'],
    includeAttributes: false,
    maxTotalTokens: 6000,
  },
})

response.results.chunks
response.results.facts
response.results.entities
response.explanation
response.prompt
```

Hits expose output scores, not input weights:

```ts
hit.scores.output
// {
//   semantic?: number
//   bm25?: number
//   graph?: number
//   recency?: number
//   fused: number
//   reranker?: number
// }
```

## Embedding And Extraction

TypeGraph uses final `Embedder` naming:

```ts
type Embedder = {
  name: string
  dimensions: number
  maxBatchSize?: number
  supportsAsymmetric?: boolean
  embed(input: {
    texts: string[]
    inputType?: 'document' | 'search'
    outputDimensions?: number
    abortSignal?: AbortSignal
  }): Promise<number[][]>
}
```

Ingest uses `embedding`; search uses `searchEmbedding` when supplied. Bucket
configuration uses `embeddingModel` and `searchEmbeddingModel`.

Graph extraction runs the configured extractor. If you pass `llm`, TypeGraph
builds its default extractor. If you pass `extractor`, your extractor wins.
Single-pass vs. multi-pass prompting is private implementation detail.

```ts
const config = {
  tenantId: 'tenant_acme',
  vectorStore,
  embedding,
  searchEmbedding,
  llm,
  extractor, // optional custom extractor
  ontology,  // optional config-driven ontology
}
```

## Graph Seeding

Applications can seed business entities and facts directly instead of relying
only on extraction:

```ts
await tg.graph.upsertEntity(
  {
    id: 'org_acme',
    name: 'Acme Corp',
    entityType: 'organization',
    description: 'Customer account for Acme Corp.',
    externalIds: [{ type: 'salesforce_account_id', id: '001xx000003DGSW' }],
  },
  {
    context: {
      userId: UserId('dana'),
      access: [
        entityRef('group', 'product'),
        entityRef('group', 'success'),
      ],
    },
  },
)

await tg.graph.upsertFact(
  {
    source: { id: 'org_acme' },
    relation: 'USES',
    target: { name: 'Salesforce', entityType: 'system' },
    description: 'Acme Corp uses Salesforce as its CRM.',
  },
  {
    context: {
      userId: UserId('dana'),
      access: [
        entityRef('group', 'product'),
        entityRef('group', 'success'),
      ],
    },
  },
)
```

Facts use `description` as their assertion and search text.

## Packages

| Package | Purpose |
| --- | --- |
| [`@typegraph-ai/sdk`](packages/sdk) | Main SDK: initialization, documents, events, threads, search, graph, memory, jobs, policies, and types. |
| [`@typegraph-ai/adapter-pgvector`](packages/adapters/pgvector) | Core Postgres + pgvector adapter and memory/graph backing store. |
| [`@typegraph-ai/adapter-pgvector-neon`](packages/adapters/pgvector-neon) | Neon convenience adapter. |
| [`@typegraph-ai/adapter-pgvector-pg`](packages/adapters/pgvector-pg) | node-postgres convenience adapter. |
| [`@typegraph-ai/adapter-pgvector-supabase`](packages/adapters/pgvector-supabase) | Supabase/Postgres convenience adapter. |
| [`@typegraph-ai/adapter-pgvector-rds`](packages/adapters/pgvector-rds) | AWS RDS/Postgres convenience adapter. |
| [`@typegraph-ai/adapter-pgvector-nile`](packages/adapters/pgvector-nile) | Nile/Postgres convenience adapter. |
| [`@typegraph-ai/adapter-pgvector-prisma`](packages/adapters/pgvector-prisma) | Prisma convenience adapter. |
| [`@typegraph-ai/vercel-ai-provider`](packages/vercel-ai-provider) | Vercel AI SDK tools and middleware. |
| [`@typegraph-ai/mcp-server`](packages/mcp-server) | MCP server package. |
| [`@typegraph-ai/otel`](packages/otel) | OpenTelemetry event sink integration. |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Focused SDK checks:

```bash
pnpm --filter @typegraph-ai/sdk test
pnpm --filter @typegraph-ai/sdk typecheck
```

## License

[MIT](LICENSE)
