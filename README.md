<p align="center">
  <img src="d8um_logo_text.webp" alt="d8um" width="400" />
</p>

<p align="center">
  <strong>One SDK. Every data source. Context, ready for your LLM agent.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&bull;&nbsp;
  <a href="#embedding-providers">Embedding</a> &nbsp;&bull;&nbsp;
  <a href="#packages">Packages</a> &nbsp;&bull;&nbsp;
  <a href="#api-overview">API</a> &nbsp;&bull;&nbsp;
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-first-blue?logo=typescript&logoColor=white" alt="TypeScript first" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Alpha" />
</p>

---

**d8um** (pronounced "datum") is a TypeScript SDK and open protocol for supplying context to LLMs. Define your data sources once - websites, documents, integrations, APIs, databases - and query all of them with a single call. d8um handles chunking, embedding, storage, retrieval, score merging, and prompt assembly so you can focus on building your application.

```ts
const { results } = await d8um.query('how do I configure SSO?', { topK: 8 })
const context = d8um.assemble(results, { format: 'xml', maxTokens: 4000 })
```

## Why d8um?

Most RAG setups devolve into bespoke plumbing - a different retrieval path for each data source, ad-hoc score normalization, and fragile prompt formatting. d8um replaces that with a single, composable interface.

| | Frameworks (LangChain, LlamaIndex) | **d8um** |
|---|---|---|
| **Philosophy** | Build *inside* the framework | Compose *alongside* your stack |
| **Embeddings** | Baked-in provider wrappers | [Vercel AI SDK](https://ai-sdk.dev) ecosystem - 40+ providers, zero lock-in |
| **Multi-model** | One model for everything | Per-source embedding models, merged at query time |
| **Data sources** | Per-source wiring | Unified `Connector` interface |
| **Retrieval** | Manual per-source | Fan-out + merge + re-rank in one call |
| **Storage** | Tightly coupled | Swappable adapters (Postgres, SQLite, ...) |
| **Output** | Raw results | Prompt-ready context (`xml`, `markdown`, `plain`) |

## How It Works

d8um organizes every data source into one of three modes:

| Mode | Behavior | Best for |
|------|----------|----------|
| **`indexed`** | Content is chunked, embedded, and stored. Semantic search runs against the vector store. | Docs, wikis, knowledge bases |
| **`live`** | Fetched at query time. Never stored - always fresh. | APIs, search engines, real-time data |
| **`cached`** | Fetched once, stored until a TTL expires, then re-fetched. | Slowly-changing reference data |

A single `d8um.query()` call fans out across all three modes in parallel, normalizes scores, merges results via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf), and returns a unified ranked result set.

```
                        d8um.query("how do I configure SSO?")
                                      │
                     ┌────────────────┼────────────────┐
                     ▼                ▼                ▼
              ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
              │   indexed   │  │    live     │  │   cached    │
              │  (vector +  │  │  (connector │  │  (TTL-based │
              │   keyword)  │  │   .query()) │  │   refresh)  │
              └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
                     │                │                │
      ┌──────────────┤                │                │
      ▼              ▼                │                │
 ┌──────────┐   ┌──────────┐          │                │
 │ Model A  │   │ Model B  │          │                │
 │ (OpenAI) │   │ (Cohere) │          │                │
 │ embed +  │   │ embed +  │          │                │
 │ search   │   │ search   │          │                │
 └────┬─────┘   └────┬─────┘          │                │
      │              │                │                │
      └──────┬───────┴────────────────┴────────────────┘
             ▼
    ┌────────────────┐
    │  Score Merger  │
    │  (normalize +  │
    │   RRF + dedup) │
    └────────┬───────┘
             ▼
    ┌────────────────┐
    │   assemble()   │
    │  (xml/md/plain)│
    └────────────────┘
             ▼
       Prompt-ready
         context
```

## Quick Start

### Install

```bash
# Core SDK
npm install @d8um/core

# Pick an embedding provider (any AI SDK provider works)
npm install @ai-sdk/openai           # OpenAI
npm install @ai-sdk/anthropic        # Anthropic
npm install @ai-sdk/cohere           # Cohere
# ... or any of 40+ AI SDK providers

# Pick a vector store adapter
npm install @d8um/adapter-pgvector    # Production - Postgres + pgvector
npm install @d8um/adapter-sqlite-vec  # Local dev - zero external dependencies

# Pick connectors
npm install @d8um/connector-domain    # Recursively crawl a domain/website
npm install @d8um/connector-url       # Scrape individual web pages
npm install @d8um/connector-notion    # Sync Notion pages and databases
```

### Define sources, index, query

```ts
import { d8um } from '@d8um/core'
import { PgVectorAdapter } from '@d8um/adapter-pgvector'
import { DomainConnector } from '@d8um/connector-domain'
import { UrlConnector } from '@d8um/connector-url'
import { openai } from '@ai-sdk/openai'
import { neon } from '@neondatabase/serverless'

// 1. Initialize d8um — bring your own Postgres driver
const sql = neon(process.env.DATABASE_URL!)

d8um.initialize({
  embedding: {
    model: openai.embedding('text-embedding-3-small'),
    dimensions: 1536,
  },
  vectorStore: new PgVectorAdapter({ sql }),
})

// Need multiple instances? Use d8umCreate():
// import { d8umCreate } from '@d8um/core'
// const other = d8umCreate({ embedding: ..., vectorStore: ... })

// 2. Add your data sources
d8um.addSource({
  id: 'marketing-site',
  connector: new DomainConnector({
    startUrl: 'https://acme.com',
    denyPatterns: ['/blog/*'],
    maxPages: 200,
  }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['url'],
  },
})

d8um.addSource({
  id: 'docs',
  connector: new DomainConnector({
    startUrl: 'https://docs.acme.com',
    maxPages: 500,
  }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['url'],
  },
})

d8um.addSource({
  id: 'changelog',
  connector: new UrlConnector({
    urls: ['https://acme.com/changelog'],
  }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['url'],
  },
})

// 3. Index (run in a background job, cron, or on deploy)
await d8um.index('marketing-site', { mode: 'upsert' })
await d8um.index('docs', { mode: 'upsert', pruneDeleted: true })
await d8um.index('changelog', { mode: 'upsert' })

// 4. Query - fans out across all sources, merges, re-ranks
const { results } = await d8um.query('how do I configure SSO?', { topK: 8 })

// 5. Get prompt-ready context
const context = d8um.assemble(results, {
  format: 'xml',
  maxTokens: 4000,
  citeSources: true,
})
```

### Output

`assemble()` produces structured context ready to drop into any prompt:

```xml
<context>
<source id="docs" title="SSO Configuration Guide" url="https://docs.acme.com/sso">
  <passage score="0.9142">
    To enable SSO, navigate to Settings > Authentication and select your
    identity provider. d8um supports SAML 2.0 and OpenID Connect...
  </passage>
</source>
<source id="wiki" title="SSO Troubleshooting" url="https://notion.so/acme/sso-troubleshooting">
  <passage score="0.8731">
    If users see a "redirect loop" error after enabling SSO, verify that
    the callback URL matches exactly...
  </passage>
</source>
</context>
```

## API Overview

### `d8um`

| Method | Description |
|--------|-------------|
| `d8um.initialize(config)` | Configure the singleton with a vector store adapter and embedding provider |
| `d8umCreate(config)` | Create an independent instance (for multi-instance use cases) |
| `.addSource(source)` | Register a data source (indexed, live, or cached) |
| `.index(sourceId?, opts?)` | Index one or all indexed sources - idempotent, incremental by default |
| `.query(text, opts?)` | Fan-out query across all sources, merge, and rank |
| `.assemble(results, opts?)` | Format results for prompt injection (`xml`, `markdown`, `plain`, or custom) |
| `.destroy()` | Clean up connections |

### Indexing Options

```ts
await d8um.index('docs', {
  mode: 'upsert',       // 'upsert' (incremental) or 'replace' (full rebuild)
  tenantId: 'acme',     // Multi-tenant isolation
  pruneDeleted: true,    // Remove chunks for documents no longer in the source
  dryRun: true,          // Preview what would change without writing
  onProgress: (event) => console.log(event),  // Progress callbacks
})
```

### Query Options

```ts
const response = await d8um.query('search text', {
  topK: 10,
  sources: ['docs', 'wiki'],     // Filter to specific sources
  tenantId: 'acme',
  mergeStrategy: 'rrf',          // 'rrf', 'linear', or 'custom'
  mergeWeights: { indexed: 0.7, live: 0.2, cached: 0.1 },
  onSourceError: 'warn',         // 'omit', 'warn', or 'throw'
})
```

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`@d8um/core`](packages/core) | Query engine, index engine, types, embedding providers | Alpha |
| [`@d8um/adapter-pgvector`](packages/adapters/pgvector) | PostgreSQL + pgvector - driver-agnostic (bring your own Postgres client) | Alpha |
| [`@d8um/adapter-sqlite-vec`](packages/adapters/sqlite-vec) | SQLite + sqlite-vec - zero-infra local development | Alpha |
| [`@d8um/connector-domain`](packages/connectors/domain) | Recursively crawl a domain with BFS, respecting depth/page limits | Alpha |
| [`@d8um/connector-url`](packages/connectors/url) | Scrape individual web pages, strip HTML to clean text | Alpha |
| [`@d8um/connector-notion`](packages/connectors/notion) | Sync Notion pages and databases with block-aware chunking | Alpha |

### Build Your Own

d8um is designed to be extended. Implement the `Connector` interface to add any data source, or the `VectorStoreAdapter` interface to bring your own storage.

```ts
// Custom connector - just implement fetch()
const myConnector: Connector = {
  async *fetch() {
    for (const item of await getMyData()) {
      yield {
        id: item.id,
        title: item.name,
        content: item.body,
        updatedAt: item.modifiedAt,
        metadata: { category: item.category },
      }
    }
  },
}

d8um.addSource({
  id: 'my-source',
  connector: myConnector,
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, idempotencyKey: ['id'] },
})
```

## Architecture

```
@d8um/core
├── d8um()              Main orchestrator, per-source embedding resolution
├── embedding/
│   ├── provider.ts     EmbeddingProvider interface
│   └── ai-sdk-adapter  Wraps any AI SDK model via structural typing (zero deps)
├── IndexEngine         Chunk, embed, store - model-aware, idempotent
├── QueryPlanner        Multi-model fan-out, timeout, error handling
├── ScoreMerger         Normalize + RRF + dedup across modes and models
├── assemble()          Format results for prompt injection
└── types/              Full TypeScript type system

@d8um/adapter-*         Swappable vector store backends (per-model table isolation)
@d8um/connector-*       Pluggable data source integrations
```

**Key design decisions:**

- **AI SDK native** - Embedding providers use the [Vercel AI SDK](https://ai-sdk.dev) ecosystem. Any of 40+ providers work out of the box.
- **Per-source embedding models** - Each source can use a different embedding model. d8um manages separate vector tables per model and merges results at query time.
- **Idempotent indexing** - Content is hashed. Unchanged documents are skipped. Partial failures are recoverable. Model changes are detected and trigger re-embedding.
- **Atomic writes** - All chunks for a document are written in a single operation. No partial states.
- **Multi-tenant** - Every operation accepts an optional `tenantId` for data isolation.
- **Hybrid search** - pgvector adapter supports both semantic (HNSW) and keyword (tsvector) search with RRF fusion.
- **Connector-owned chunking** - Connectors can override the default token-count chunker with structure-aware splitting (e.g., Notion chunks by block hierarchy).

## Embedding Providers

d8um uses the [Vercel AI SDK](https://ai-sdk.dev) provider ecosystem for embeddings. Install the provider package you need, pass the model - done. No wrapper code, no API key plumbing, no HTTP client to maintain.

> **Zero new dependencies.** `@d8um/core` doesn't import `@ai-sdk/provider` or any provider package. It uses [structural typing](https://www.typescriptlang.org/docs/handbook/type-compatibility.html) - any object that looks like an AI SDK embedding model works, whether it comes from `@ai-sdk/openai`, a custom implementation, or a test mock.

### Global default + per-source overrides

Set a default embedding model on the `d8um` instance, then optionally override it on any source:

```ts
import { d8um } from '@d8um/core'
import { openai } from '@ai-sdk/openai'
import { cohere } from '@ai-sdk/cohere'
import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@d8um/adapter-pgvector'

const adapter = new PgVectorAdapter({ sql: neon(process.env.DATABASE_URL!) })

d8um.initialize({
  // Global default - used for all sources unless overridden
  embedding: {
    model: openai.embedding('text-embedding-3-small'),
    dimensions: 1536,
  },
  vectorStore: adapter,
})

// Uses the global default (OpenAI, 1536 dims)
d8um.addSource({
  id: 'docs',
  connector: docsConnector,
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, idempotencyKey: ['url'] },
})

// Overrides with Cohere (1024 dims) - gets its own vector table automatically
d8um.addSource({
  id: 'wiki',
  connector: wikiConnector,
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, idempotencyKey: ['metadata.pageId'] },
  embedding: {
    model: cohere.embedding('embed-english-v3.0'),
    dimensions: 1024,
  },
})
```

### What happens at query time

When you call `d8um.query()`, d8um:

1. Groups sources by their embedding model
2. Embeds the query text **once per distinct model** (not once per source)
3. Searches each model's dedicated vector table
4. Merges all results via RRF across models and modes

You don't think about which model applies to which source - d8um handles the fan-out and merge.

### Per-model table isolation

Each embedding model gets its own vector table (e.g., `d8um_chunks_openai_text_embedding_3_small`, `d8um_chunks_cohere_embed_english_v3_0`). This means:

- No dimension conflicts - each table has the correct `VECTOR(n)` column
- Clean HNSW indexes per model - no mixed vector spaces
- Safe model migration - switching a source's model triggers automatic re-embedding, with old chunks cleaned up
- Works identically across all adapters (pgvector, sqlite-vec, etc.)

### Custom embedding providers

For full control, pass a raw `EmbeddingProvider` object - no AI SDK required:

```ts
d8um.initialize({
  embedding: {
    model: 'custom/my-model',
    dimensions: 768,
    async embed(text) { /* your logic */ },
    async embedBatch(texts) { /* your logic */ },
  },
  vectorStore: new PgVectorAdapter({ sql: neon(process.env.DATABASE_URL!) }),
})
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Run tests
pnpm run test

# Type check
pnpm run typecheck
```

The repo uses [Turborepo](https://turbo.build) for build orchestration and [pnpm](https://pnpm.io) workspaces for package management.

## Roadmap

- [x] AI SDK embedding provider integration (40+ providers)
- [x] Per-source embedding model support with automatic multi-model query fan-out
- [x] Per-model vector table isolation
- [x] Indexed query runner and QueryPlanner implementation
- [x] Full pgvector adapter with hybrid search (iterative HNSW + tsvector RRF)
- [x] Driver-agnostic pgvector adapter (bring your own Postgres client)
- [x] URL connector with HTML stripping and link extraction
- [x] Domain connector with BFS crawling, domain boundaries, and allow/deny patterns
- [ ] Live and cached query runners
- [ ] SQLite-vec adapter implementation
- [ ] Notion connector with block tree traversal
- [ ] Neighbor chunk joining in `assemble()`
- [ ] Token budget trimming
- [ ] Additional adapters (Qdrant, Pinecone, Weaviate)
- [ ] Additional connectors (GitHub, Confluence, Google Drive, S3)
- [ ] MCP server integration

## Contributing

d8um is open source and contributions are welcome. Whether it's a new connector, adapter, bug fix, or documentation improvement - we'd love your help.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-connector`)
3. Make your changes
4. Run `pnpm run build && pnpm run typecheck` to verify
5. Open a PR

## License

[MIT](LICENSE)
