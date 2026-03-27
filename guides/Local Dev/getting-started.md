# d8um Local Dev Getting Started

No API keys, no cloud services, no external database. Everything runs on your machine.

## Prerequisites

- Node.js 18+

That's it. No database server, no API keys, no cloud accounts.

## 1) Install

```bash
# Core SDK
npm install @d8um/core

# Local embedding model - BAAI/bge-small-en-v1.5 via fastembed + ONNX Runtime
# MIT licensed, 33M params, 384 dimensions, ~32 MB model (downloaded on first run)
npm install @d8um/embedding-local

# SQLite vector store - zero-infra, single-file database
npm install @d8um/adapter-sqlite-vec
```

## 2) Initialize

```ts
import { d8um } from '@d8um/core'
import { LocalEmbeddingProvider } from '@d8um/embedding-local'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'

// Initialize d8um - fully local, no API keys needed
const embedding = new LocalEmbeddingProvider()

d8um.initialize({
  embedding,
  vectorStore: new SqliteVecAdapter({ dbPath: './my-app.db' }),
})
```

### Under the Hood: Local Initialization

- `LocalEmbeddingProvider` wraps fastembed + onnxruntime-node
- On first use, the ONNX model (~32 MB) is downloaded and cached locally
- `SqliteVecAdapter` creates a SQLite database file at `./my-app.db`
- Tables are created: `d8um_chunks_registry`, `d8um_hashes`, `d8um_hashes_run_times`

## 3) Create a Source

```ts
// Same API as the hosted and self-hosted options - the source config is identical
d8um.addSource({
  id: 'faq',
  mode: 'indexed',
  index: { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
})
```

### Under the Hood: SQLite Tables

d8um creates the following tables for the local embedding model:

```sql
d8um_chunks_local_fast_bge_small_en_v1_5 (
  chunk_rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT,
  bucket_id       TEXT,
  document_id     TEXT,
  content         TEXT,
  embedding_model TEXT,
  chunk_index     INTEGER,
  ...
)

-- sqlite-vec virtual table for vector search
d8um_chunks_local_fast_bge_small_en_v1_5_vec
  embedding float[384]   -- 384-dim vectors for cosine similarity search
```

## 4) Ingest Documents

```ts
// Same API as the hosted and self-hosted options — batched embedding in a single call
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

### Under the Hood: Local Ingestion Pipeline

For each document, d8um:

1. Hashes the content for deduplication
2. Checks `d8um_hashes` -- skips if content unchanged
3. Chunks the content based on `chunkSize`/`chunkOverlap`
4. Runs the chunks through the local ONNX model (bge-small-en-v1.5) -- no network call
5. Inserts chunks into the SQLite chunks table
6. Inserts 384-dim embeddings into the sqlite-vec virtual table
7. Updates `d8um_hashes` for deduplication on next run

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

### Under the Hood: Local Vector Search

d8um performs the query entirely offline:

1. Embeds the query locally using bge-small-en-v1.5
2. Runs a KNN search against the sqlite-vec virtual table:

```sql
SELECT c.*, v.distance
FROM d8um_chunks_local_fast_bge_small_en_v1_5_vec v
JOIN d8um_chunks_local_fast_bge_small_en_v1_5 c ON c.chunk_rowid = v.rowid
WHERE v.embedding MATCH ? AND k = 10
ORDER BY v.distance
```

3. Converts cosine distance to similarity scores
4. Returns ranked results -- entirely offline, no network calls

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
```

## When to Use Local Dev

The local dev setup is the best option for:

- **Local development** -- iterate fast without network calls or API costs
- **Testing** -- deterministic embeddings make tests reproducible
- **CI/CD pipelines** -- no external service dependencies to mock or manage
- **Edge deployments** -- run d8um where there is no internet
- **Air-gapped environments** -- everything runs on the machine, no data leaves

When you're ready for production, swap in a cloud embedding provider and pgvector -- the rest of your code stays the same. See the [Self-Hosted Setup Guide](../Self%20Hosted/setup.md) for the production path, or the [d8um Cloud Quickstart](../d8um%20Cloud/quickstart.md) for the zero-infrastructure option.
