<p align="center">
  <img src="logo-dark.png" alt="d8um" width="150" />
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
// Register a data source
d8um.addSource({
  id: 'faq',
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
})

// Ingest document(s) into your source
await d8um.ingest('faq', {
  title: 'How do I set up SSO?',
  content: 'To enable SSO, navigate to Settings > Authentication and select your identity provider. We support SAML 2.0 and OpenID Connect.'
})

// Fan-out query across all sources, merge, and rank
const response = await d8um.query('how do I configure SSO?', { count: 8 })
// response.results contains ranked chunks from your sources:
// [
//   {
//     content: 'To enable SSO, navigate to Settings > Authentication...',
//     score: 0.9142,
//     source: { id: 'faq', title: 'How do I set up SSO?' },
//   },
//   ...
// ]

// Assemble the results as LLM prompt context
const context = d8um.assemble(response.results, { format: 'xml' })
// context contains a string of formatted response.results:
// <context>
// <source id="faq" title="How do I set up SSO?">
//   <passage score="0.9142">
//     To enable SSO, navigate to Settings > Authentication...
//   </passage>
// </source>
// ...
// </context>
```

## Why d8um?

Most RAG setups devolve into bespoke plumbing - a different retrieval path for each data source, ad-hoc score normalization, and fragile prompt formatting. d8um replaces that with a single, composable interface.


|                  | Frameworks (LangChain, LlamaIndex) | **d8um**                                                                    |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| **Philosophy**   | Build *inside* the framework       | Compose *alongside* your stack                                              |
| **Embeddings**   | Baked-in provider wrappers         | [Vercel AI SDK](https://ai-sdk.dev) ecosystem - 40+ providers, zero lock-in |
| **Multi-model**  | One model for everything           | Per-source embedding models, merged at query time                           |
| **Data sources** | Per-source wiring                  | Unified `Connector` interface                                               |
| **Retrieval**    | Manual per-source                  | Fan-out + merge + re-rank in one call                                       |
| **Storage**      | Tightly coupled                    | Swappable adapters (Postgres, SQLite, ...)                                  |
| **Output**       | Raw results                        | Prompt-ready context (`xml`, `markdown`, `plain`)                           |


## How It Works

d8um organizes every data source into one of three modes:


| Mode          | Behavior                                                                                 | Best for                             |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| `**indexed`** | Content is chunked, embedded, and stored. Semantic search runs against the vector store. | Docs, wikis, knowledge bases         |
| `**live**`    | Fetched at query time. Never stored - always fresh.                                      | APIs, search engines, real-time data |
| `**cached**`  | Fetched once, stored until a TTL expires, then re-fetched.                               | Slowly-changing reference data       |


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

### Option A: Hosted (zero infrastructure)

#### 1) Install

```bash
npm install @d8um/core @d8um/hosted
```

#### 2) Initialize

```ts
import { d8umHosted } from '@d8um/hosted'

// Initialize d8um using the d8um api key
const d8um = d8umHosted({ apiKey: process.env.D8UM_API_KEY! })
```

#### 3) Create a Source

```ts
// Create a source - in this case, a basic source you send documents to - FAQ questions and answers
d8um.addSource({
  id: 'faq',
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
})
```

#### 4) Ingest Documents

```ts
// Send documents to your FAQ source - d8um handles chunking and embedding
//    document id is optional - d8um generates an UUID id if none is sent, and automatically deduplicates by content hash

await d8um.ingest('faq', {
  title: 'How do I set up SSO?',
  content: 'To enable SSO, navigate to Settings > Authentication and select your identity provider. We support SAML 2.0 and OpenID Connect.',
  updatedAt: new Date(),
  metadata: {},
})

await d8um.ingest('faq', {
  title: 'How do I reset my password?',
  content: 'Click "Forgot password" on the login page. You will receive a reset link via email within 5 minutes.',
  updatedAt: new Date(),
  metadata: {},
})

// Optionally check source statuses because we're thorough?
const sources = await d8um.listSources()
// [
//   { id: 'faq', status: 'ready', documentCount: 2 }
// ]
```

#### 5) Query

```ts
// Query - fans out across faq (and any other sources), merges, re-ranks
const response = await d8um.query('how do I configure SSO?')

// response.results contains ranked chunks from your sources:
// [
//   {
//     content: 'To enable SSO, navigate to Settings > Authentication...',
//     score: 0.9142,
//     source: { id: 'faq', title: 'How do I set up SSO?' },
//   },
//   ...
// ]
```

#### 6) Format results (optional)

```ts
// Assemble ranked chunks into structured LLM context
const xml = d8um.assemble(response.results) // defaults to XML format
// <context>
// <source id="faq" title="How do I set up SSO?">
//   <passage score="0.9142">
//     To enable SSO, navigate to Settings > Authentication...
//   </passage>
// </source>
// ...
// </context>

// Also available as markdown:
const md = d8um.assemble(response.results, { format: 'markdown' })
// # How do I set up SSO?
// To enable SSO, navigate to Settings > Authentication...
//
// ---
//...
```

### Option B: Self-Hosted (full control)

#### 1) Install

```bash
# Core SDK
npm install @d8um/core

# Pick an embedding provider
npm install @ai-sdk/openai           
# npm install @ai-sdk/anthropic      
# npm install @ai-sdk/cohere          
# ... or any other pre-built, or custom embedding providers

# Pick a vector store adapter
npm install @d8um/adapter-pgvector      # Production - Postgres + pgvector
# npm install @d8um/adapter-sqlite-vec  # Local dev - zero external dependencies
# ... or any other pre-built, or custom vector store adapters

# Pick connectors (optional)
#npm install @d8um/connector-domain          # Recursively crawl a domain/website
#npm install @d8um/connector-url             # Scrape individual web pages
#npm install @d8um/connector-slack           # Sync Slack conversations
#npm install @d8um/connector-google-drive    # Sync Google Drive documents and files
#npm install @d8um/connector-fathom          # Sync Fathom call transcripts
#npm install @d8um/connector-notion          # Sync Notion pages and databases
# ... or any other pre-built, or custom connectors
```

#### 2) Initialize

```ts
// d8um specific import stuff
import { d8um } from '@d8um/core'
import { PgVectorAdapter } from '@d8um/adapter-pgvector'

// Then, these imports here will be specific to your app:
// i.e. your embedding provider
import { openai } from '@ai-sdk/openai'
// i.e. your vector database provider
import { neon } from '@neondatabase/serverless'

// 1) Initialize d8um — point it at your embedding model and your database
d8um.initialize({
  embedding: {
    model: openai.embedding('text-embedding-3-small'),
    dimensions: 1536,
  },
  vectorStore: new PgVectorAdapter({ sql: neon(process.env.DATABASE_URL!) }),
})

// Under the hood, d8um creates these tables in your database:
//
//   d8um_documents     — stores document records (id, source_id, title, url, content_hash, status, ...)
//   d8um_hashes        — tracks content hashes for deduplication and incremental sync
//   d8um_chunks_registry — registry of which embedding models have been used

```

#### 3) Create a Source

```ts
// Create a source - in this case, a basic source you send documents to - FAQ questions and answers
d8um.addSource({
  id: 'faq',
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
})

// Under the hood, d8um creates a per-model chunks table for the embedding model:
//
//   d8um_chunks_openai_text_embedding_3_small (
//     id              UUID PRIMARY KEY,
//     source_id       TEXT,
//     document_id     UUID REFERENCES d8um_documents,
//     content         TEXT,
//     embedding       VECTOR(1536),          -- pgvector column
//     chunk_index     INTEGER,
//     total_chunks    INTEGER,
//     metadata        JSONB,
//     search_vector   TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
//     ...
//   )
//
// Each embedding model gets its own table — so if you later switch models or use
// different models per source, d8um isolates them automatically.
```

#### 4) Ingest Documents

```ts
// Send documents to your FAQ source - d8um handles chunking and embedding under the hood
//    document id is optional - d8um generates an UUID id if none is sent, and automatically deduplicates by content hash

await d8um.ingest('faq', {
  title: 'How do I set up SSO?',
  content: 'To enable SSO, navigate to Settings > Authentication and select your identity provider. We support SAML 2.0 and OpenID Connect.',
  updatedAt: new Date(),
  metadata: {},
})

await d8um.ingest('faq', {
  title: 'How do I reset my password?',
  content: 'Click "Forgot password" on the login page. You will receive a reset link via email within 5 minutes.',
  updatedAt: new Date(),
  metadata: {},
})

// Under the hood, for each document d8um:
//   1. Generates a UUID (since no id was provided)
//   2. Hashes the content for deduplication (deduplicateBy: ['content'])
//   3. Checks d8um_hashes — skips if content unchanged (idempotent re-ingestion)
//   4. Inserts a record into d8um_documents (title, url, content_hash, status, ...)
//   5. Chunks the content based on chunkSize/chunkOverlap
//   6. Calls openai.embedding() to generate a 1536-dim vector for each chunk
//   7. Bulk inserts chunks + embeddings:
//
//        INSERT INTO d8um_chunks_openai_text_embedding_3_small
//          (source_id, document_id, content, embedding, chunk_index, total_chunks, metadata, ...)
//        SELECT * FROM unnest($1::text[], $2::uuid[], ..., $6::vector[], ...)
//        ON CONFLICT (idempotency_key, chunk_index, source_id) DO UPDATE SET ...
//
//   8. Updates d8um_hashes so the next ingest() call can skip unchanged docs
```

#### 5) Query

```ts
// Query - fans out across faq (and any other sources), merges, re-ranks
const response = await d8um.query('how do I configure SSO?')

// response.results contains ranked chunks:
// [
//   {
//     content: 'To enable SSO, navigate to Settings > Authentication...',
//     score: 0.9142,
//     source: { id: 'faq', title: 'How do I set up SSO?' },
//   },
//   ...
// ]

// Under the hood, d8um:
//   1. Groups your sources by embedding model. If you have sources using different
//      models (e.g. openai text-embedding-3-small for docs, cohere embed-v4 for
//      support tickets), d8um handles each model separately — embedding your query
//      with each model, searching each model's table, then merging all results
//      together with RRF re-ranking. You just call query() once and get back a
//      single ranked result set. The multi-model complexity is invisible to you.
//   2. Embeds the query text using each model for the sources you're querying
//   3. Runs a hybrid search per model, combining vector similarity + full-text keyword matching:
//
//        WITH vector_ranked AS (
//          SELECT *, 1 - (embedding <=> $1::vector) AS similarity,
//                 ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vrank
//          FROM d8um_chunks_openai_text_embedding_3_small
//          WHERE source_id = 'faq'
//          LIMIT 60
//        ),
//        keyword_ranked AS (
//          SELECT *, ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS kw_score,
//                 ROW_NUMBER() OVER (ORDER BY ts_rank(...) DESC) AS krank
//          FROM d8um_chunks_openai_text_embedding_3_small
//          WHERE search_vector @@ websearch_to_tsquery('english', $2)
//          LIMIT 60
//        )
//        SELECT *, (1.0/(60 + vrank) + 1.0/(60 + krank)) AS rrf_score
//        FROM (vector_ranked FULL OUTER JOIN keyword_ranked ...)
//        ORDER BY rrf_score DESC LIMIT 10
//
//   3. Maps results back to d8umResult objects with scores, source info, and chunk positions

```

#### 6) Format results (optional)

```ts
// Assemble ranked chunks into structured LLM context
const xml = d8um.assemble(response.results) // defaults to XML
// <context>
// <source id="faq" title="How do I set up SSO?">
//   <passage score="0.9142">
//     To enable SSO, navigate to Settings > Authentication...
//   </passage>
// </source>
// ...
// </context>

// Or you can assemble into markdown
const md = d8um.assemble(response.results, { format: 'markdown' })
// # How do I set up SSO?
// To enable SSO, navigate to Settings > Authentication...
//
// ---
// ...
```

### Option C: Local Dev (zero external dependencies)

No API keys, no cloud services, no external database. Everything runs on your machine.

#### 1) Install

```bash
# Core SDK
npm install @d8um/core

# Local embedding model — BAAI/bge-small-en-v1.5 via fastembed + ONNX Runtime
# MIT licensed, 33M params, 384 dimensions, ~32 MB model (downloaded on first run)
npm install @d8um/embedding-local

# SQLite vector store — zero-infra, single-file database
npm install @d8um/adapter-sqlite-vec
```

#### 2) Initialize

```ts
import { d8um } from '@d8um/core'
import { LocalEmbeddingProvider } from '@d8um/embedding-local'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'

// Initialize d8um — fully local, no API keys needed
const embedding = new LocalEmbeddingProvider()

d8um.initialize({
  embedding,
  vectorStore: new SqliteVecAdapter({ dbPath: './my-app.db' }),
})

// Under the hood:
//   - LocalEmbeddingProvider wraps fastembed + onnxruntime-node
//   - On first use, the ONNX model (~32 MB) is downloaded and cached locally
//   - SqliteVecAdapter creates a SQLite database file at ./my-app.db
//   - Tables are created: d8um_chunks_registry, d8um_hashes, d8um_hashes_run_times
```

#### 3) Create a Source

```ts
// Same API as Options A and B — the source config is identical
d8um.addSource({
  id: 'faq',
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
})

// Under the hood, d8um creates:
//
//   d8um_chunks_local_fast_bge_small_en_v1_5 (
//     chunk_rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
//     id              TEXT,
//     source_id       TEXT,
//     document_id     TEXT,
//     content         TEXT,
//     embedding_model TEXT,
//     chunk_index     INTEGER,
//     ...
//   )
//
//   d8um_chunks_local_fast_bge_small_en_v1_5_vec — sqlite-vec virtual table
//     embedding float[384]   -- 384-dim vectors for cosine similarity search
```

#### 4) Ingest Documents

```ts
// Same API as Options A and B
await d8um.ingest('faq', {
  title: 'How do I set up SSO?',
  content: 'To enable SSO, navigate to Settings > Authentication and select your identity provider. We support SAML 2.0 and OpenID Connect.',
  updatedAt: new Date(),
  metadata: {},
})

await d8um.ingest('faq', {
  title: 'How do I reset my password?',
  content: 'Click "Forgot password" on the login page. You will receive a reset link via email within 5 minutes.',
  updatedAt: new Date(),
  metadata: {},
})

// Under the hood, for each document d8um:
//   1. Hashes the content for deduplication
//   2. Checks d8um_hashes — skips if content unchanged
//   3. Chunks the content based on chunkSize/chunkOverlap
//   4. Runs the chunks through the local ONNX model (bge-small-en-v1.5) — no network call
//   5. Inserts chunks into the SQLite chunks table
//   6. Inserts 384-dim embeddings into the sqlite-vec virtual table
//   7. Updates d8um_hashes for deduplication on next run
```

#### 5) Query

```ts
// Query - fans out across faq (and any other sources), merges, re-ranks
const response = await d8um.query('how do I configure SSO?')

// response.results contains ranked chunks:
// [
//   {
//     content: 'To enable SSO, navigate to Settings > Authentication...',
//     score: 0.9142,
//     source: { id: 'faq', title: 'How do I set up SSO?' },
//   },
//   ...
// ]

// Under the hood, d8um:
//   1. Embeds the query locally using bge-small-en-v1.5
//   2. Runs a KNN search against the sqlite-vec virtual table:
//
//        SELECT c.*, v.distance
//        FROM d8um_chunks_local_fast_bge_small_en_v1_5_vec v
//        JOIN d8um_chunks_local_fast_bge_small_en_v1_5 c ON c.chunk_rowid = v.rowid
//        WHERE v.embedding MATCH ? AND k = 10
//        ORDER BY v.distance
//
//   3. Converts cosine distance to similarity scores
//   4. Returns ranked results — entirely offline, no network calls
```

#### 6) Format results (optional)

```ts
// Assemble ranked chunks into structured LLM context
const xml = d8um.assemble(response.results) // defaults to XML
// <context>
// <source id="faq" title="How do I set up SSO?">
//   <passage score="0.9142">
//     To enable SSO, navigate to Settings > Authentication...
//   </passage>
// </source>
// ...
// </context>
```

> **When to use Option C:** Local development, testing, CI/CD pipelines, edge deployments, air-gapped environments, or anywhere you want zero external dependencies. When you're ready for production, swap in a cloud embedding provider and pgvector — the rest of your code stays the same.

## API Overview

### `d8um`


| Method                      | Description                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| `d8um.initialize(config)`   | Configure the singleton with a vector store adapter and embedding provider  |
| `d8umCreate(config)`        | Create an independent instance (for multi-instance use cases)               |
| `.addSource(source)`        | Register a data source (indexed, live, or cached)                           |
| `.index(sourceId?, opts?)`  | Index one or all indexed sources - idempotent, incremental by default       |
| `.query(text, opts?)`       | Fan-out query across all sources, merge, and rank                           |
| `.assemble(results, opts?)` | Format results for prompt injection (`xml`, `markdown`, `plain`, or custom) |
| `.destroy()`                | Clean up connections                                                        |


### Indexing Options

```ts
await d8um.index('docs', {
  mode: 'upsert',       // 'upsert' (incremental) or 'replace' (full rebuild)
  tenantId: 'acme',     // Multi-tenant isolation
  removeDeleted: true,    // Remove chunks for documents no longer in the source
  dryRun: true,          // Preview what would change without writing
  onProgress: (event) => console.log(event),  // Progress callbacks
})
```

### Query Options

```ts
const response = await d8um.query('search text', {
  count: 10,
  sources: ['docs', 'wiki'],     // Filter to specific sources
  tenantId: 'acme',
  mergeStrategy: 'rrf',          // 'rrf', 'linear', or 'custom'
  mergeWeights: { indexed: 0.7, live: 0.2, cached: 0.1 },
  onSourceError: 'warn',         // 'omit', 'warn', or 'throw'
})
```

## Packages


| Package                                                            | Description                                                              | Status |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------ |
| `[@d8um/core](packages/core)`                                      | Query engine, index engine, types, embedding providers                   | Alpha  |
| `[@d8um/hosted](packages/hosted)`                                  | Hosted client SDK - zero infrastructure, just an API key                 | Alpha  |
| `[@d8um/embedding-local](packages/embeddings/local)`               | Local embeddings via fastembed + ONNX Runtime (bge-small-en-v1.5, MIT)   | Alpha  |
| `[@d8um/adapter-pgvector](packages/adapters/pgvector)`             | PostgreSQL + pgvector - driver-agnostic (bring your own Postgres client) | Alpha  |
| `[@d8um/adapter-sqlite-vec](packages/adapters/sqlite-vec)`         | SQLite + sqlite-vec - zero-infra local development                       | Alpha  |
| `[@d8um/connector-domain](packages/connectors/domain)`             | Recursively crawl a domain with BFS, respecting depth/page limits        | Alpha  |
| `[@d8um/connector-url](packages/connectors/url)`                   | Scrape individual web pages, strip HTML to clean text                    | Alpha  |
| `[@d8um/connector-notion](packages/connectors/notion)`             | Sync Notion pages and databases with block-aware chunking                | Alpha  |
| `[@d8um/connector-slack](packages/connectors/slack)`               | Sync Slack conversations, threads, and messages                          | Stub   |
| `[@d8um/connector-google-drive](packages/connectors/google-drive)` | Sync Google Drive documents, spreadsheets, and files                     | Stub   |
| `[@d8um/connector-fathom](packages/connectors/fathom)`             | Sync Fathom call recordings and transcripts                              | Stub   |


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
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['id'] },
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
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['url'] },
})

// Overrides with Cohere (1024 dims) - gets its own vector table automatically
d8um.addSource({
  id: 'wiki',
  connector: wikiConnector,
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['metadata.pageId'] },
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

- AI SDK embedding provider integration (40+ providers)
- Per-source embedding model support with automatic multi-model query fan-out
- Per-model vector table isolation
- Indexed query runner and QueryPlanner implementation
- Full pgvector adapter with hybrid search (iterative HNSW + tsvector RRF)
- Driver-agnostic pgvector adapter (bring your own Postgres client)
- URL connector with HTML stripping and link extraction
- Domain connector with BFS crawling, domain boundaries, and allow/deny patterns
- Hosted client SDK (`@d8um/hosted`) - zero-infra SaaS mode
- Live and cached query runners
- SQLite-vec adapter implementation
- Notion connector with block tree traversal
- Neighbor chunk joining in `assemble()`
- Token budget trimming
- Additional adapters (Qdrant, Pinecone, Weaviate)
- Additional connectors (GitHub, Confluence, Google Drive, S3)
- MCP server integration

## Contributing

d8um is open source and contributions are welcome. Whether it's a new connector, adapter, bug fix, or documentation improvement - we'd love your help.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-connector`)
3. Make your changes
4. Run `pnpm run build && pnpm run typecheck` to verify
5. Open a PR

## License

[MIT](LICENSE)