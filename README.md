<p align="center">
  <img src="d8um_logo_text.webp" alt="d8um" width="400" />
</p>

<p align="center">
  <strong>One SDK. Every data source. Context, ready for your LLM agent.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&bull;&nbsp;
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

**d8um** (pronounced "datum") is a TypeScript SDK and open protocol for supplying context to LLMs. Define your data sources once — docs, wikis, APIs, databases — and query all of them with a single call. d8um handles chunking, embedding, storage, retrieval, score merging, and prompt assembly so you can focus on building your application.

```ts
const { results } = await ctx.query('how do I configure SSO?', { topK: 8 })
const context = ctx.assemble(results, { format: 'xml', maxTokens: 4000 })
```

## Why d8um?

Most RAG setups devolve into bespoke plumbing — a different retrieval path for each data source, ad-hoc score normalization, and fragile prompt formatting. d8um replaces that with a single, composable interface.

| | Frameworks (LangChain, LlamaIndex) | **d8um** |
|---|---|---|
| **Philosophy** | Build *inside* the framework | Compose *alongside* your stack |
| **Data sources** | Per-source wiring | Unified `Connector` interface |
| **Retrieval** | Manual per-source | Fan-out + merge + re-rank in one call |
| **Storage** | Tightly coupled | Swappable adapters (Postgres, SQLite, ...) |
| **Output** | Raw results | Prompt-ready context (`xml`, `markdown`, `plain`) |

## How It Works

d8um organizes every data source into one of three modes:

| Mode | Behavior | Best for |
|------|----------|----------|
| **`indexed`** | Content is chunked, embedded, and stored. Semantic search runs against the vector store. | Docs, wikis, knowledge bases |
| **`live`** | Fetched at query time. Never stored — always fresh. | APIs, search engines, real-time data |
| **`cached`** | Fetched once, stored until a TTL expires, then re-fetched. | Slowly-changing reference data |

A single `ctx.query()` call fans out across all three modes in parallel, normalizes scores, merges results via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf), and returns a unified ranked result set.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   indexed   │     │    live      │     │   cached     │
│  (vector +  │     │  (connector  │     │  (TTL-based  │
│   keyword)  │     │   .query())  │     │   refresh)   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────┬───────┴───────────────────┘
                   ▼
          ┌────────────────┐
          │  Score Merger   │
          │  (normalize +   │
          │   RRF + dedup)  │
          └────────┬───────┘
                   ▼
          ┌────────────────┐
          │   assemble()   │
          │  (xml/md/plain) │
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

# Pick an adapter
npm install @d8um/adapter-pgvector    # Production — Postgres + pgvector
npm install @d8um/adapter-sqlite-vec  # Local dev — zero external dependencies

# Pick connectors
npm install @d8um/connector-url       # Crawl URLs and sitemaps
npm install @d8um/connector-notion    # Sync Notion pages and databases
```

### Define sources, index, query

```ts
import { D8um } from '@d8um/core'
import { PgVectorAdapter } from '@d8um/adapter-pgvector'
import { UrlConnector } from '@d8um/connector-url'
import { NotionConnector } from '@d8um/connector-notion'

// 1. Create a d8um instance
const ctx = new D8um({
  embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  vectorStore: new PgVectorAdapter({
    connectionString: process.env.DATABASE_URL!,
  }),
})

// 2. Add your data sources
ctx.addSource({
  id: 'docs',
  connector: new UrlConnector({
    urls: ['https://docs.acme.com/sitemap.xml'],
  }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['url'],
  },
})

ctx.addSource({
  id: 'wiki',
  connector: new NotionConnector({
    apiKey: process.env.NOTION_API_KEY!,
  }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['metadata.pageId'],
    propagateMetadata: ['url', 'title', 'updatedAt', 'metadata.pageId'],
  },
})

// 3. Index (run in a background job, cron, or on deploy)
await ctx.index('docs', { mode: 'upsert' })
await ctx.index('wiki', { mode: 'upsert', pruneDeleted: true })

// 4. Query — fans out across all sources, merges, re-ranks
const { results } = await ctx.query('how do I configure SSO?', { topK: 8 })

// 5. Get prompt-ready context
const context = ctx.assemble(results, {
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

### `D8um`

| Method | Description |
|--------|-------------|
| `new D8um(config)` | Create an instance with a vector store adapter and embedding provider |
| `.addSource(source)` | Register a data source (indexed, live, or cached) |
| `.index(sourceId?, opts?)` | Index one or all indexed sources — idempotent, incremental by default |
| `.query(text, opts?)` | Fan-out query across all sources, merge, and rank |
| `.assemble(results, opts?)` | Format results for prompt injection (`xml`, `markdown`, `plain`, or custom) |
| `.initialize()` | Initialize the vector store (idempotent — safe to call on every cold start) |
| `.destroy()` | Clean up connections |

### Indexing Options

```ts
await ctx.index('docs', {
  mode: 'upsert',       // 'upsert' (incremental) or 'replace' (full rebuild)
  tenantId: 'acme',     // Multi-tenant isolation
  pruneDeleted: true,    // Remove chunks for documents no longer in the source
  dryRun: true,          // Preview what would change without writing
  onProgress: (event) => console.log(event),  // Progress callbacks
})
```

### Query Options

```ts
const response = await ctx.query('search text', {
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
| [`@d8um/adapter-pgvector`](packages/adapters/pgvector) | PostgreSQL + pgvector — production-ready vector store | Alpha |
| [`@d8um/adapter-sqlite-vec`](packages/adapters/sqlite-vec) | SQLite + sqlite-vec — zero-infra local development | Alpha |
| [`@d8um/connector-url`](packages/connectors/url) | Crawl URLs and sitemaps, strip HTML to clean text | Alpha |
| [`@d8um/connector-notion`](packages/connectors/notion) | Sync Notion pages and databases with block-aware chunking | Alpha |

### Build Your Own

d8um is designed to be extended. Implement the `Connector` interface to add any data source, or the `VectorStoreAdapter` interface to bring your own storage.

```ts
// Custom connector — just implement fetch()
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

ctx.addSource({
  id: 'my-source',
  connector: myConnector,
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, idempotencyKey: ['id'] },
})
```

## Architecture

```
@d8um/core
├── D8um              Main orchestrator
├── IndexEngine       Chunk, embed, store with idempotency
├── QueryPlanner      Fan-out, timeout, error handling
├── ScoreMerger       Normalize + RRF + dedup across modes
├── assemble()        Format results for prompt injection
└── types/            Full TypeScript type system

@d8um/adapter-*       Swappable vector store backends
@d8um/connector-*     Pluggable data source integrations
```

**Key design decisions:**

- **Idempotent indexing** — Content is hashed. Unchanged documents are skipped. Partial failures are recoverable.
- **Atomic writes** — All chunks for a document are written in a single operation. No partial states.
- **Multi-tenant** — Every operation accepts an optional `tenantId` for data isolation.
- **Hybrid search** — pgvector adapter supports both semantic (HNSW) and keyword (tsvector) search with RRF fusion.
- **Connector-owned chunking** — Connectors can override the default token-count chunker with structure-aware splitting (e.g., Notion chunks by block hierarchy).

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

- [ ] Query runners (indexed, live, cached) and QueryPlanner implementation
- [ ] Full pgvector adapter with hybrid search (iterative HNSW + tsvector RRF)
- [ ] SQLite-vec adapter implementation
- [ ] OpenAI and Cohere embedding API integrations
- [ ] URL connector with sitemap expansion and HTML stripping
- [ ] Notion connector with block tree traversal
- [ ] Neighbor chunk joining in `assemble()`
- [ ] Token budget trimming
- [ ] Additional adapters (Qdrant, Pinecone, Weaviate)
- [ ] Additional connectors (GitHub, Confluence, Google Drive, S3)
- [ ] MCP server integration

## Contributing

d8um is open source and contributions are welcome. Whether it's a new connector, adapter, bug fix, or documentation improvement — we'd love your help.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-connector`)
3. Make your changes
4. Run `pnpm run build && pnpm run typecheck` to verify
5. Open a PR

## License

[MIT](LICENSE)
