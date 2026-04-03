# @d8um-ai/core

TypeScript SDK and open protocol for supplying context to LLMs.

## Install

```bash
npm install @d8um-ai/core
```

## Usage

```ts
import { d8um, registerJobType, assemble } from '@d8um-ai/core'

await d8um.deploy({
  vectorStore: myAdapter,
  embedding: embeddingModel,
})

await d8um.initialize({
  vectorStore: myAdapter,
  embedding: embeddingModel,
})

const bucket = await d8um.buckets.create({ name: 'docs' })

await d8um.ingest(bucket.id, [{ id: 'doc-1', content: 'Your content here', title: 'Doc 1', updatedAt: new Date(), metadata: {} }], { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] })

const { results } = await d8um.query('How does authentication work?')
const context = d8um.assemble(results)
```

## API

### Core

| Export | Description |
|--------|-------------|
| `d8um` | Singleton instance |
| `d8umCreate()` | Factory for multiple instances |
| `registerJobType()` | Register a built-in or integration job type |
| `getJobType()` | Look up a registered job type |
| `listJobTypes()` | List all registered job types |
| `builtInJobTypes` | Array of built-in job definitions |

### Engines

| Export | Description |
|--------|-------------|
| `IndexEngine` | Chunk, embed, and store documents |
| `assemble()` | Turn scored results into an LLM-ready context string |
| `mergeAndRank()` | Combine and normalize results from multiple sources |
| `searchWithContext()` | Contextual passage search with surrounding chunks |
| `defaultChunker` | Built-in text chunker |

### Built-in Jobs

| Export | Description |
|--------|-------------|
| `urlScrapeJob` | Scrape and parse a single URL |
| `domainCrawlJob` | BFS crawl an entire domain |
| `fetchPage()` | Fetch and convert HTML to markdown |
| `Crawler` | Configurable BFS crawler |

### Types

`Bucket`, `Job`, `JobTypeDefinition`, `JobRunContext`, `JobRunResult`, `ApiClient`, `VectorStoreAdapter`, `EmbeddingProvider`, `RawDocument`, `Chunk`, `d8umDocument`, `Visibility`, `d8umIdentity`, `QueryOpts`, `QueryResponse`, `AssembleOpts`, `IndexOpts`, `IndexResult`

## Related

- [d8um main repo](../../README.md)
- [Agentic RAG Guide](../../README.md#agentic-rag)
