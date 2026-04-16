# @typegraph-ai/core

TypeScript SDK and open protocol for supplying context to LLMs.

## Install

```bash
npm install @typegraph-ai/core
```

## Usage

```ts
import { typegraphInit, typegraphDeploy } from '@typegraph-ai/core'

// One-time setup (creates tables)
const d = await typegraphDeploy({
  vectorStore: myAdapter,
  embedding: embeddingModel,
})

// Runtime init (no DDL, ready for queries)
const d = await typegraphInit({
  vectorStore: myAdapter,
  embedding: embeddingModel,
})

const bucket = await d.buckets.create({ name: 'docs' })

await d.ingest(
  [{ id: 'doc-1', content: 'Your content here', title: 'Doc 1', updatedAt: new Date(), metadata: {} }],
  { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] },
  { bucketId: bucket.id }
)

const { results, context } = await d.query('How does authentication work?', { format: 'xml' })
```

## API

### Core

| Export | Description |
|--------|-------------|
| `typegraphInit()` | Runtime factory — returns a ready-to-use instance |
| `typegraphDeploy()` | One-time DDL provisioning — creates tables/extensions |

### Engines

| Export | Description |
|--------|-------------|
| `IndexEngine` | Chunk, embed, and store documents |
| `mergeAndRank()` | Combine and normalize results from multiple sources |
| `defaultChunker` | Built-in text chunker |

### Types

`Bucket`, `VectorStoreAdapter`, `EmbeddingProvider`, `EmbeddingConfig`, `LLMConfig`, `RawDocument`, `Chunk`, `typegraphDocument`, `Visibility`, `typegraphIdentity`, `QueryOpts`, `QueryResponse`, `QuerySignals`, `IngestOptions`, `IndexResult`, `GraphBridge`, `MemoryRecord`, `Job`, `Policy`

## Related

- [TypeGraph main repo](../../README.md)
- [Agentic RAG Guide](../../README.md#agentic-rag)
