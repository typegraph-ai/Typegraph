<div align="center">
  <img src="typegraph-logo-dark.png" alt="TypeGraph" width="50" />
  <h1>TypeGraph</h1>
  <p>A TypeScript context layer for AI agents.</p>
</div>

<div align="center">
  <p>
    <img src="https://img.shields.io/badge/MIT%20License-3DA639?logo=opensourceinitiative&logoColor=white" alt="MIT License" />
    <img src="https://img.shields.io/badge/TypeScript%20Native-3178C6?logo=typescript&logoColor=white" alt="TypeScript native" />
    <img src="https://img.shields.io/badge/PostgreSQL%20Native-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL native" />
    <img src="https://img.shields.io/badge/Vercel%20AI%20SDK-000000?logo=vercel&logoColor=white" alt="Vercel AI SDK" />
  </p>
</div>

TypeGraph gives AI apps one composable SDK for document retrieval, graph-augmented retrieval, and memory. It is TypeScript-native, works with TypeGraph Cloud or your own Postgres database, and is designed to plug into existing agent stacks rather than replace them.

For deeper setup guides, architecture notes, and production patterns, use the docs: [typegraph.ai/docs](https://typegraph.ai/docs).

## Why TypeGraph

- **One context API** for semantic search, keyword search, graph retrieval, and memory recall.
- **TypeScript-first** with AI SDK-compatible embedding and language model providers.
- **Cloud or self-hosted**: use TypeGraph Cloud with an API key, or run against Postgres + pgvector.
- **Graph-aware RAG**: extract entities/facts during ingest and query them with graph ranking.
- **Composable retrieval signals**: turn `semantic`, `keyword`, `graph`, and `memory` on per query.
- **LLM-ready context building** with XML, Markdown, or plain text output and token budgets.

## Install

Cloud-only projects usually need just the SDK:

```bash
pnpm add @typegraph-ai/sdk
```

Self-hosted Postgres projects also need the pgvector adapter plus the database client and AI provider package used by your app:

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

See [Self-Hosted Initialization](https://typegraph.ai/docs/guides/self-hosted-initialization) for provider-specific setup.

## Quick Start

```ts
import { typegraphInit } from '@typegraph-ai/sdk'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
})

await tg.ingest([
  {
    title: 'Employee handbook',
    content: 'Acme employees configure SSO from the admin security page.',
  },
])

const response = await tg.query('How do employees configure SSO?', {
  signals: { semantic: true, keyword: true },
  context: {
    format: 'xml',
    sections: ['chunks'],
    maxTotalTokens: 4000,
  },
})

console.log(response.context)
```

Self-hosted uses the same runtime API, but provides a vector store and embedding model:

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

See [Simple RAG](https://typegraph.ai/docs/guides/simple-rag) for the full walkthrough.

## Query Signals

TypeGraph query behavior is explicit. The default is fast semantic search; enable more signals when the task needs them.

| Signal | Purpose | Default |
| --- | --- | --- |
| `semantic` | Embedding search over chunks | On |
| `keyword` | BM25 keyword search fused with semantic results | Off |
| `graph` | Fact-filtered graph retrieval over entities, facts, and passages | Off |
| `memory` | Cognitive memory recall | Off |

```ts
await tg.query('How are Alice and Acme related?', {
  signals: { semantic: true, keyword: true, graph: true },
  context: {
    format: 'markdown',
    sections: ['chunks', 'facts'],
    includeAttributes: false,
  },
})
```

Graph retrieval uses the `fact-filtered-narrow` profile by default when `signals.graph` is enabled. See [Graph RAG](https://typegraph.ai/docs/guides/graph-rag) for graph setup, extraction, and tuning.

## Packages

| Package | Purpose |
| --- | --- |
| [`@typegraph-ai/sdk`](packages/sdk) | Main SDK: cloud/self-hosted initialization, ingest, query, graph, memory, policy types |
| [`@typegraph-ai/adapter-pgvector`](packages/adapters/pgvector) | Postgres + pgvector storage adapter and memory/graph backing store |
| [`@typegraph-ai/vercel-ai-provider`](packages/vercel-ai-provider) | Vercel AI SDK tools and middleware |
| [`@typegraph-ai/mcp-server`](packages/mcp-server) | MCP server package |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Contributions are welcome. Keep package-level behavior covered by tests and prefer docs links over duplicating long guides in README files.

## License

[MIT](LICENSE)
