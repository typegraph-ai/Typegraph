# @typegraph-ai/sdk

The TypeGraph SDK is the main TypeScript API for building an AI context layer: ingest sources, query them with composable retrieval signals, build LLM-ready context, and wire graph or memory features when needed.

Use this README for the essentials. Use [typegraph.ai/docs](https://typegraph.ai/docs) for complete guides, deployment details, and deeper architecture notes.

## Install

```bash
pnpm add @typegraph-ai/sdk
```

For self-hosted Postgres, also install the adapter plus the database client and AI provider package used by your app:

```bash
pnpm add @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

## Cloud Quick Start

```ts
import { typegraphInit } from '@typegraph-ai/sdk'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
})

await tg.ingest([
  {
    id: 'handbook',
    title: 'Employee handbook',
    content: 'Acme employees configure SSO from the admin security page.',
    metadata: { source: 'handbook' },
  },
])

const response = await tg.query('How do employees configure SSO?', {
  signals: { semantic: true, keyword: true },
  context: {
    format: 'xml',
    sections: ['chunks'],
  },
})

console.log(response.context)
```

See [TypeGraph Cloud docs](https://typegraph.ai/docs) for API keys, hosted buckets, and production setup.

## Self-Hosted Quick Start

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

`typegraphDeploy(config)` is for setup/DDL and is safe to run in deploy scripts. `typegraphInit(config)` is the lightweight runtime initializer for app boot.

See [Self-Hosted Initialization](https://typegraph.ai/docs/guides/self-hosted-initialization) for database providers, environment variables, and deployment patterns.

## Query API

Queries return structured results and can optionally build an LLM-ready context string.

```ts
const response = await tg.query('What changed in the SSO rollout?', {
  signals: {
    semantic: true,
    keyword: true,
    graph: true,
    memory: false,
  },
  context: {
    format: 'markdown',
    sections: ['chunks', 'facts'],
    includeAttributes: false,
    maxTotalTokens: 6000,
    maxChunkTokens: 4000,
    maxFactTokens: 2000,
  },
})

response.results.chunks
response.results.facts
response.context
response.contextStats
```

| Signal | Purpose | Default |
| --- | --- | --- |
| `semantic` | Embedding search over chunks | On |
| `keyword` | BM25 keyword search | Off |
| `graph` | Fact-filtered graph retrieval | Off |
| `memory` | Cognitive memory recall | Off |

Graph retrieval uses the `fact-filtered-narrow` profile by default when enabled. See [Graph RAG](https://typegraph.ai/docs/guides/graph-rag) for extraction, graph storage, query tuning, and graph APIs.

## Context Builder

The `context` option replaces ad hoc formatting with a predictable context builder:

```ts
context: {
  format: 'xml',                 // 'xml' | 'markdown' | 'plain'
  sections: ['chunks', 'facts'], // 'chunks' | 'facts' | 'entities' | 'memories'
  includeAttributes: true,
  maxTotalTokens: 8000,
  maxChunkTokens: 5000,
  maxFactTokens: 3000,
}
```

`includeAttributes` defaults to `false`. When true, scalar provenance is included and complex metadata is rendered as nested content so JSON stays readable.

## Main Exports

| Export | Purpose |
| --- | --- |
| `typegraphInit` | Initialize a runtime instance |
| `typegraphDeploy` | Create required storage objects for self-hosted mode |
| `createKnowledgeGraphBridge` | Build a graph bridge over a memory store |
| `createMemoryBridge` | Build a cognitive memory bridge |
| `aiSdkEmbeddingProvider` / `aiSdkLlmProvider` | Wrap AI SDK models explicitly when needed |
| `QueryOpts`, `QueryResponse`, `QueryContextOptions` | Core query types |

## Learn More

- [Docs home](https://typegraph.ai/docs)
- [Simple RAG](https://typegraph.ai/docs/guides/simple-rag)
- [Self-Hosted Initialization](https://typegraph.ai/docs/guides/self-hosted-initialization)
- [Graph RAG](https://typegraph.ai/docs/guides/graph-rag)
