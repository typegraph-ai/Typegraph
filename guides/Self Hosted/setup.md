# d8um Self-Hosted Setup

Full control over your data, embedding models, and infrastructure. You bring the database and embedding provider; d8um handles the rest.

## Prerequisites

- Node.js 18+
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension enabled
- An embedding provider API key (OpenAI, Cohere, Anthropic, or any of 40+ [Vercel AI SDK](https://ai-sdk.dev) providers)

## 1) Install

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

# Pick integrations (optional - 3rd party connectors)
#npm install @d8um/integration-core          # Shared integration types
#npm install @d8um/integration-slack         # Slack messages & channels
#npm install @d8um/integration-google-drive  # Google Drive files
#npm install @d8um/integration-hubspot       # HubSpot CRM contacts, companies, deals
# ... or any other integration package
```

## 2) Initialize

```ts
// d8um specific import stuff
import { d8um } from '@d8um/core'
import { PgVectorAdapter } from '@d8um/adapter-pgvector'

// Then, these imports here will be specific to your app:
// i.e. your embedding provider
import { openai } from '@ai-sdk/openai'
// i.e. your vector database provider
import { neon } from '@neondatabase/serverless'

// 1) Initialize d8um - point it at your embedding model and your database
d8um.initialize({
  embedding: {
    model: openai.embedding('text-embedding-3-small'),
    dimensions: 1536,
  },
  vectorStore: new PgVectorAdapter({ sql: neon(process.env.DATABASE_URL!) }),
})
```

### Under the Hood: Database Tables

When you initialize, d8um creates these tables in your database:

| Table | Purpose |
|-------|---------|
| `d8um_documents` | Stores document records (id, bucket_id, title, url, content_hash, status, ...) |
| `d8um_hashes` | Tracks content hashes for deduplication and incremental sync |
| `d8um_chunks_registry` | Registry of which embedding models have been used |

## 3) Create a Source

```ts
// Create a source - in this case, a basic source you send documents to - FAQ questions and answers
d8um.addSource({
  id: 'faq',
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
})
```

### Under the Hood: Per-Model Chunks Table

d8um creates a per-model chunks table for the embedding model:

```sql
d8um_chunks_openai_text_embedding_3_small (
  id              UUID PRIMARY KEY,
  bucket_id       TEXT,
  document_id     UUID REFERENCES d8um_documents,
  content         TEXT,
  embedding       VECTOR(1536),          -- pgvector column
  chunk_index     INTEGER,
  total_chunks    INTEGER,
  metadata        JSONB,
  search_vector   TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  ...
)
```

Each embedding model gets its own table. If you later switch models or use different models per source, d8um isolates them automatically.

## 4) Ingest Documents

```ts
// Send documents to your FAQ source - d8um handles chunking and embedding under the hood
//    document id is optional - d8um generates an UUID id if none is sent, and automatically deduplicates by content hash

await d8um.ingest('faq', [
  {
    title: 'How do I set up SSO?',
    content: 'To enable SSO, navigate to Settings > Authentication and select your identity provider. We support SAML 2.0 and OpenID Connect.',
    updatedAt: new Date(),
    metadata: {},
  },
  {
    title: 'How do I reset my password?',
    content: 'Click "Forgot password" on the login page. You will receive a reset link via email within 5 minutes.',
    updatedAt: new Date(),
    metadata: {},
  },
], { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] })
```

### Under the Hood: Ingestion Pipeline

For each document, d8um:

1. Generates a UUID (since no id was provided)
2. Hashes the content for deduplication (`deduplicateBy: ['content']`)
3. Checks `d8um_hashes` -- skips if content unchanged (idempotent re-ingestion)
4. Inserts a record into `d8um_documents` (title, url, content_hash, status, ...)
5. Chunks the content based on `chunkSize`/`chunkOverlap`
6. Calls `openai.embedding()` to generate a 1536-dim vector for each chunk
7. Bulk inserts chunks + embeddings:

```sql
INSERT INTO d8um_chunks_openai_text_embedding_3_small
  (bucket_id, document_id, content, embedding, chunk_index, total_chunks, metadata, ...)
SELECT * FROM unnest($1::text[], $2::uuid[], ..., $6::vector[], ...)
ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET ...
```

8. Updates `d8um_hashes` so the next `ingest()` call can skip unchanged docs

## 5) Query

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
```

### Under the Hood: Hybrid Search

d8um runs a hybrid search combining vector similarity and full-text keyword matching:

1. **Groups sources by embedding model.** If you have sources using different models (e.g., OpenAI `text-embedding-3-small` for docs, Cohere `embed-v4` for support tickets), d8um handles each model separately -- embedding your query with each model, searching each model's table, then merging all results together with RRF re-ranking. You just call `query()` once and get back a single ranked result set. The multi-model complexity is invisible to you.

2. **Embeds the query text** using each model for the sources you're querying.

3. **Runs a hybrid search per model**, combining vector similarity + full-text keyword matching:

```sql
WITH vector_ranked AS (
  SELECT *, 1 - (embedding <=> $1::vector) AS similarity,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vrank
  FROM d8um_chunks_openai_text_embedding_3_small
  WHERE bucket_id = 'faq'
  LIMIT 60
),
keyword_ranked AS (
  SELECT *, ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS kw_score,
         ROW_NUMBER() OVER (ORDER BY ts_rank(...) DESC) AS krank
  FROM d8um_chunks_openai_text_embedding_3_small
  WHERE search_vector @@ websearch_to_tsquery('english', $2)
  LIMIT 60
)
SELECT *, (1.0/(60 + vrank) + 1.0/(60 + krank)) AS rrf_score
FROM (vector_ranked FULL OUTER JOIN keyword_ranked ...)
ORDER BY rrf_score DESC LIMIT 10
```

4. **Maps results** back to d8um result objects with scores, source info, and chunk positions.

## 6) Assemble Results (optional)

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

## Per-Source Embedding Models

You can set a global default embedding model and override it on individual sources. Each model gets its own vector table automatically.

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

### What Happens at Query Time

When you call `d8um.query()`, d8um:

1. Groups sources by their embedding model
2. Embeds the query text **once per distinct model** (not once per source)
3. Searches each model's dedicated vector table
4. Merges all results via RRF across models and modes

You don't think about which model applies to which source -- d8um handles the fan-out and merge.

### Per-Model Table Isolation

Each embedding model gets its own vector table (e.g., `d8um_chunks_openai_text_embedding_3_small`, `d8um_chunks_cohere_embed_english_v3_0`). This means:

- **No dimension conflicts** -- each table has the correct `VECTOR(n)` column
- **Clean HNSW indexes per model** -- no mixed vector spaces
- **Safe model migration** -- switching a source's model triggers automatic re-embedding, with old chunks cleaned up
- **Works identically across all adapters** (pgvector, sqlite-vec, etc.)

## When to Use Self-Hosted

Self-hosted is the best option when you need:

- **Full control** over your data, infrastructure, and embedding models
- **Production-grade storage** with PostgreSQL + pgvector
- **Per-source embedding models** with automatic multi-model fan-out and merge
- **Hybrid search** combining semantic similarity and keyword matching
- **Compliance requirements** that mandate data stays in your infrastructure

For zero-infrastructure development, see the [d8um Cloud Quickstart](../d8um%20Cloud/quickstart.md). For local development without external dependencies, see the [Local Dev Guide](../Local%20Dev/getting-started.md).
