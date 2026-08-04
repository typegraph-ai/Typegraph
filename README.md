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
ontology, and telemetry. It is MIT-licensed and runs in your application
against Postgres with pgvector.

The current SDK uses `document` for durable content, `search` for retrieval,
tenant-scoped clients, per-call actor identity under `context`, graph access on
graph config, and Postgres/pgvector for self-hosted vector storage.

For deeper guides and production patterns, use the docs:
[typegraph.ai/docs](https://typegraph.ai/docs).

## Install

Install the SDK, the pgvector adapter, a Postgres client, and the AI provider
package used by your app:

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

## Quick Start

TypeGraph runs inside your application. You provide storage, embedding, and LLM
configuration. `vectorStore + embedding + llm` enables document ingest, search,
graph extraction, graph APIs, and memory APIs when the adapter supports those
capabilities.

```ts
import { gateway } from '@ai-sdk/gateway'
import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@typegraph-ai/adapter-pgvector'
import {
  GroupId,
  ThreadId,
  UserId,
  entityRef,
  typegraphDeploy,
  typegraphInit,
} from '@typegraph-ai/sdk'

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
    model: gateway('openai/gpt-5.4-mini'),
  },
  graphs: {
    public: { access: 'public' },
    internal: {
      extends: ['public'],
      access: {
        read: { groups: [GroupId('employees')] },
        write: { groups: [GroupId('employees')] },
      },
    },
  },
  buckets: {
    public: { graph: 'public' },
    handbook: { name: 'Employee Handbook', graph: 'internal', graphExtraction: true },
    gong: { name: 'Gong Calls', graph: 'internal', graphExtraction: true },
  },
  ontology: {
    version: '2026-05-08',
    profiles: ['saas'],
    entities: {
      organization: {
        description: 'A company, customer, vendor, or partner.',
        vocabulary: [{ vocabulary: 'schema.org', id: 'Organization', uri: 'https://schema.org/Organization' }],
      },
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
Applications do not need to call graph or memory bridge constructors.

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
| `tg.memory` | Private memory, conversation extraction, progressive memory context, and database-backed memory artifacts. |
| `tg.job` | Job tracking primitives. |
| `tg.policy` | Governance policy CRUD when a policy store is configured. |

## Identity, Graphs, And Access

`tenantId` is configured once on `typegraphInit()` or `typegraphDeploy()`.
Per-call actor identity uses one optional key: `context`.

```ts
import {
  AgentId,
  GroupId,
  OrganizationId,
  ThreadId,
  UserId,
  type TypeGraphContext,
} from '@typegraph-ai/sdk'

const context: TypeGraphContext = {
  organizationId: OrganizationId('org_acme'),
  groupId: GroupId('product'),
  userId: UserId('dana'),
  agentId: AgentId('product-ops-agent'),
  threadId: ThreadId('thread_123'),
}
```

Graphs are the logical knowledge boundaries inside a tenant. Reads from graph
`internal` include `internal` plus its ancestors, such as `public`. Parent
graphs never read child graph data.

Buckets own write routing. If no bucket is supplied, writes use bucket `public`,
which writes to graph `public`. Event `participants`, entities, and facts model
business relationships; they do not grant access.

## Documents, Events, And Threads

Documents are the primary long-form ingest target. A raw transcript often has a
narrower audience than the product signal extracted from it:

```ts
await tg.document.ingest(
  {
    id: 'gong:transcript:123',
    name: 'Acme discovery call transcript',
    description: 'Transcript from the Acme discovery call.',
    url: 'https://gong.example.com/calls/123/transcript',
    content: transcriptText,
    metadata: { provider: 'gong' },
  },
  {
    context: {
      userId: UserId('dana'),
      groupId: GroupId('success'),
    },
    bucketId: 'gong',
    idempotencyKey: 'gong:transcript:123',
  },
)
```

Events model business activity. This event is a product signal from the Acme
call. The `participants` create the business shape for graph extraction and
exploration; the `gong` bucket routes the write into the internal graph.

```ts
await tg.event.ingest(
  {
    id: 'gong:meeting:123:signal:sso-redirect-loop',
    name: 'Acme reports SSO redirect loop',
    description: 'Acme is blocked by a SAML redirect loop during SSO rollout.',
    url: 'https://gong.example.com/calls/123',
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
      groupId: GroupId('success'),
    },
    bucketId: 'gong',
  },
)
```

That supports cross-customer questions:

```ts
const response = await tg.search('Which customers are experiencing SSO redirect loops?', {
  graph: 'internal',
  context: { groupId: GroupId('product') },
  resources: ['events', 'facts', 'entities'],
  weights: { semantic: 1, bm25: 0.5, graph: 0.9, recency: 0.4 },
  promptBuilder: { format: 'markdown', sections: ['facts', 'entities'] },
})
```

If a customer portal user should see only public knowledge, search graph
`public`. Internal teams can search graph `internal`, which includes public
knowledge plus internal customer activity.

Threads are ordered containers. `thread.addTurn()` stores the turn as an event
and links the event back to the thread. A turn has only role, content, URL,
timestamp, and metadata.

```ts
await tg.thread.addTurn(
  'thread_support_123',
  {
    role: 'user',
    content: 'Can you send the SOC2 report?',
    url: 'https://slack.example.com/archives/C123/p456',
    timestamp: new Date(),
    metadata: { channel: 'slack' },
  },
  {
    context: {
      userId: UserId('dana'),
      threadId: ThreadId('thread_support_123'),
      groupId: GroupId('support'),
    },
    bucketId: 'gong',
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
```

`weights` controls how candidates are scored and fused:

| Weight | Purpose | Default |
| --- | --- | --- |
| `semantic` | Embedding search over content-bearing records | `1` |
| `bm25` | Keyword/BM25 search fused with semantic results | `0.7` |
| `graph` | Graph-aware facts, entities, and chunk expansion | `0.5` |
| `recency` | Prefer fresher records in final scoring | `0.3` |

Set a weight to `false` to disable that signal.

Configure an optional reranker at initialization time. A provider wrapper
receives TypeGraph's `QueryChunkResult[]` candidates and must return those
candidates in the desired order:

```ts
import { cohere } from '@ai-sdk/cohere'
import { rerank } from 'ai'
import type { QueryChunkResult, Reranker } from '@typegraph-ai/sdk'

const cohereReranker: Reranker<QueryChunkResult> = {
  name: 'cohere-rerank-v3.5',
  async rerank(query, candidates, opts) {
    const { ranking } = await rerank({
      model: cohere.reranking('rerank-v3.5'),
      query,
      documents: candidates,
      topN: opts?.topK,
      abortSignal: opts?.abortSignal,
    })

    return ranking
      .map(item => candidates[item.originalIndex])
      .filter((candidate): candidate is QueryChunkResult => candidate !== undefined)
  },
}

const rerankedTypegraph = await typegraphInit({
  ...config,
  reranker: cohereReranker,
})

const response = await rerankedTypegraph.search('How are Alice and Acme related?', {
  context: { userId: UserId('dana') },
  buckets: ['salesforce', 'slack'],
  resources: ['documents', 'events', 'facts', 'entities'],
  weights: { semantic: 1, bm25: 0.7, graph: 0.8, recency: 0.2 },
  fusion: { method: 'rrf', k: 60 },
  rerank: { topK: 20 },
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

`rerank` uses the `reranker` passed to `typegraphInit()`. TypeGraph overfetches
candidates before reranking, applies the configured `topK`, and then returns the
normal `QueryResponse`. If reranking is requested without a configured
reranker, or the reranker fails, TypeGraph logs a warning and returns the normal
fused search results.

Reranker wrappers should map provider output back to the original candidates.
For example, Vercel AI SDK `rerank()` returns `ranking[].originalIndex`/`score`/
`document`, and raw Cohere returns `results[].index`/`relevance_score`. A
TypeGraph `Reranker<QueryChunkResult>` should return reordered chunk results,
not the raw provider response. `scores.output.reranker` is TypeGraph's
normalized rank-position score.

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
  vectorStore,
  embedding,
  searchEmbedding,
  llm,
  extractor, // optional custom extractor
  ontology: {
    version: '2026-05-08',
    profiles: ['general'], // built-ins: general, literary, medical, legal, saas
    // optional custom entity/relation definitions use the same shape as profiles
  },
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
      groupId: GroupId('product'),
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
      groupId: GroupId('product'),
    },
  },
)
```

Facts use `description` as their assertion and search text.

## Memory

TypeGraph memory has two layers:

- Structured memory records for `remember`, `recall`, `correct`, `forget`, and `healthCheck`.
- Agent-facing artifact memory for conversation extraction and progressive context.

```ts
await tg.memory.remember('Dana prefers concise renewal risk summaries.', {
  context: { userId: UserId('dana') },
  graphExtraction: true,
})

await tg.thread.addTurn('thread_support_123', {
  role: 'user',
  content: 'Please keep the rollout plan short and implementation-ready.',
}, {
  context: {
    userId: UserId('dana'),
    threadId: ThreadId('thread_support_123'),
  },
})

await tg.memory.extractThread('thread_support_123', {
  context: { userId: UserId('dana') },
})

await tg.memory.consolidate({
  context: { userId: UserId('dana') },
})

const memory = await tg.memory.context('rollout plan style', {
  context: { userId: UserId('dana') },
  includeStructuredRecall: true,
})

console.log(memory.prompt)
```

Conversation memory writes database-backed artifacts such as
`raw_memories/<thread-id>.md`, `rollout_summaries/*.md`, `MEMORY.md`,
`memory_summary.md`, and `phase_two_selection.json`. Use
`tg.memory.artifacts.get/list/upsert/delete` when you need direct access to
those files. The pgvector memory store persists them in Postgres; no local
Markdown files are written.

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
| [`@typegraph-ai/adapter-redis`](packages/adapters/redis) | Redis-backed extraction coreference cache for self-hosted deployments. |
| [`@typegraph-ai/adapter-redis-upstash`](packages/adapters/redis-upstash) | Upstash Redis coreference cache adapter for self-hosted deployments. |
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
