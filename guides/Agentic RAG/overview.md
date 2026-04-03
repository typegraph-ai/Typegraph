# Agentic RAG with d8um

## What is Agentic RAG?

Retrieval-Augmented Generation (RAG) gives LLMs access to external knowledge at inference time. Instead of relying solely on training data, the model retrieves relevant documents and uses them as context to generate grounded, factual responses.

**Agentic RAG** takes this further. Rather than a single retrieve-then-generate step, an agentic system can decide _which_ sources to query, _how_ to formulate the retrieval query, whether to refine and re-retrieve, and how to synthesize results from multiple heterogeneous sources. The retrieval system becomes a tool the agent wields, not a fixed pipeline it passes through.

This matters because real-world knowledge is fragmented. A customer support agent might need to pull from product documentation (indexed and embedded), a live pricing API (fetched at query time), and a cached compliance reference (refreshed daily). Each source has different latency, freshness, and relevance characteristics. Agentic RAG systems handle this heterogeneity naturally.

## How d8um's Retrieval Works

d8um is a TypeScript SDK that provides a unified retrieval interface across all your data sources. You define sources once, and d8um handles chunking, embedding, storage, retrieval, score merging, and prompt assembly.

### Sources and Modes

Every data source in d8um is registered as a **source** with one of three modes:

| Mode | Behavior | Best for |
|------|----------|----------|
| `indexed` | Content is chunked, embedded, and stored. Semantic + keyword search runs against the vector store. | Docs, wikis, knowledge bases |
| `live` | Fetched at query time. Never stored. | APIs, search engines, real-time data |
| `cached` | Fetched once, stored until a TTL expires, then re-fetched. | Slowly-changing reference data |

### Per-Source Embedding Models

Each source can use a different embedding model. A documentation source might use OpenAI's `text-embedding-3-small` (1536 dimensions) while a support ticket source uses Cohere's `embed-english-v3.0` (1024 dimensions). d8um manages separate vector tables per model and handles the complexity at query time:

```ts
d8um.initialize({
  embedding: {
    model: openai.embedding('text-embedding-3-small'),
    dimensions: 1536,
  },
  vectorStore: adapter,
})

// Create buckets - each can use the global default or a per-bucket override
const docs = await d8um.buckets.create({ name: 'docs' })
const tickets = await d8um.buckets.create({ name: 'tickets' })
```

### Hybrid Search: Vector + BM25

For indexed sources backed by the pgvector adapter, d8um runs **hybrid search** combining semantic vector similarity (HNSW index) with keyword matching (PostgreSQL tsvector/BM25). Both retrieval paths run in a single SQL query using CTEs, and results are fused via Reciprocal Rank Fusion.

The sqlite-vec adapter uses KNN vector search for local development environments.

### Multi-Model Fan-Out

When you call `d8um.query()`, the `QueryPlanner` orchestrates the full retrieval pipeline:

1. **Group** sources by their embedding model
2. **Embed** the query text once per distinct model (not once per source)
3. **Search** each model's dedicated vector table via the `IndexedRunner`
4. **Merge** all results via the `ScoreMerger` using RRF across models and modes
5. **Deduplicate** results by URL, document ID + chunk index, or content hash
6. **Return** a unified ranked result set

### RRF Score Merging

d8um uses [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) to merge results from heterogeneous sources. RRF is rank-based rather than score-based, which means it works even when scores from different models or retrieval methods are on incompatible scales.

The formula for each result: `score = weight * (1 / (k + rank))` where `k = 60` (the standard RRF constant). Weights default to `indexed: 0.7, live: 0.2, cached: 0.1` and are configurable per query.

### Context Assembly with `assemble()`

After retrieval, `d8um.assemble()` formats the ranked results into prompt-ready context. It supports XML (default), markdown, and plain text formats, plus custom formatter functions:

```ts
const response = await d8um.query('how do I configure SSO?')
const context = d8um.assemble(response.results, { format: 'xml' })
// <context>
//   <source id="faq" title="How do I set up SSO?">
//     <passage score="0.9142">
//       To enable SSO, navigate to Settings > Authentication...
//     </passage>
//   </source>
// </context>
```

Results can be grouped by source, with citation metadata preserved for downstream attribution.

### Context Search with Neighbor Expansion

For richer context, `d8um.searchWithContext()` extends basic retrieval with **neighbor chunk expansion**. Each hit is expanded to include surrounding chunks from the same document, then stitched into coherent passages with truncation markers for gaps:

```ts
const response = await d8um.searchWithContext('SSO configuration', {
  surroundingChunks: 2,  // include 2 chunks before and after each hit
  count: 10,
})

// response.passages contains stitched documents with full context
// response.rawResults contains the original ranked chunks
```

## Architecture

```
                        d8um.query("how do I configure SSO?")
                                      |
                     +----------------+----------------+
                     v                v                v
              +-----------+    +-----------+    +-----------+
              |  indexed  |    |   live    |    |  cached   |
              | (vector + |    | (connector|    | (TTL-based|
              |  keyword) |    |  .query())|    |  refresh) |
              +-----+-----+    +-----+-----+    +-----+-----+
                    |                |                |
       +------------+                |                |
       v            v                |                |
 +----------+  +----------+         |                |
 | Model A  |  | Model B  |         |                |
 | (OpenAI) |  | (Cohere) |         |                |
 | embed +  |  | embed +  |         |                |
 | search   |  | search   |         |                |
 +----+-----+  +----+-----+         |                |
      |             |                |                |
      +------+------+----------------+----------------+
             v
    +----------------+
    |  Score Merger  |
    |  (normalize +  |
    |   RRF + dedup) |
    +--------+-------+
             v
    +----------------+
    |   assemble()   |
    |  (xml/md/plain)|
    +----------------+
             v
       Prompt-ready
         context
```

**Core modules:**

```
@d8um-ai/core
+-- d8um()              Main orchestrator, per-source embedding resolution
+-- embedding/
|   +-- provider.ts     EmbeddingProvider interface
|   +-- ai-sdk-adapter  Wraps any AI SDK model via structural typing (zero deps)
+-- IndexEngine         Chunk, embed, store -- model-aware, idempotent
+-- QueryPlanner        Multi-model fan-out, timeout, error handling
+-- ScoreMerger         Normalize + RRF + dedup across models
+-- assemble()          Format results for prompt injection
+-- types/              Full TypeScript type system

@d8um-ai/adapter-*         Swappable vector store backends (per-model table isolation)
@d8um-ai/integration-*     Modular 3rd party integrations (Slack, HubSpot, Google Drive, etc.)
```

## Embedding Providers

d8um builds on the [Vercel AI SDK](https://ai-sdk.dev) provider ecosystem for embeddings. The core package does not import any AI SDK dependency directly. Instead, it uses TypeScript structural typing: any object that satisfies the `EmbeddingProvider` interface works, whether it comes from `@ai-sdk/openai`, `@ai-sdk/cohere`, `@ai-sdk/anthropic`, a local model, or a test mock.

This means access to 40+ embedding providers with zero wrapper code:

```ts
import { openai } from '@ai-sdk/openai'
import { cohere } from '@ai-sdk/cohere'
import { google } from '@ai-sdk/google'
```

For full control, implement the `EmbeddingProvider` interface directly:

```ts
d8um.initialize({
  embedding: {
    model: 'custom/my-model',
    dimensions: 768,
    async embed(text) { /* your logic */ },
    async embedBatch(texts) { /* your logic */ },
  },
  vectorStore: adapter,
})
```

For full control, implement the `EmbeddingProvider` interface directly — any object with `embed()` and `embedBatch()` methods works, whether from the AI SDK, a custom model, or a test mock.

## Query Options and Configuration

The `query()` method accepts a rich set of options:

```ts
const response = await d8um.query('search text', {
  count: 10,                              // max results
  buckets: ['docs', 'wiki'],              // filter to specific buckets
  tenantId: 'acme',                       // multi-tenant isolation
  mergeStrategy: 'rrf',                   // 'rrf', 'linear', or 'custom'
  mergeWeights: {
    indexed: 0.7,
    live: 0.2,
    cached: 0.1,
  },
  timeouts: {
    indexed: 5000,                        // per-mode timeout in ms
    live: 3000,
    cached: 2000,
  },
  onSourceError: 'warn',                  // 'omit', 'warn', or 'throw'
  documentFilter: {                       // filter by document-level fields
    status: 'published',
    visibility: 'tenant',
  },
  temporalAt: new Date('2025-01-01'),     // point-in-time query
})
```

The response includes per-source diagnostics (timing, result counts, errors) alongside the merged results, giving full observability into retrieval performance.

## Landscape: Where d8um Fits

The retrieval and RAG tooling ecosystem has grown rapidly, with several excellent frameworks serving different audiences and use cases. The field benefits from this diversity -- advances in one project raise the bar for everyone.

### LangChain

[LangChain](https://github.com/langchain-ai/langchain) is the largest and most widely adopted framework in the LLM application space, with over 90,000 GitHub stars. It provides a comprehensive, batteries-included approach to building LLM-powered applications. LangChain is Python-first but offers [LangChain.js](https://github.com/langchain-ai/langchainjs) for TypeScript developers. Its strength is breadth: it covers everything from document loaders and text splitters to chains, agents, and memory. The framework approach means you build _inside_ LangChain's abstractions. For teams that want a single framework governing their entire LLM application, LangChain is a strong choice.

### LlamaIndex

[LlamaIndex](https://github.com/run-llama/llama_index) has the strongest RAG-specific focus in the ecosystem, with over 40,000 GitHub stars. It positions itself as a "data framework" and excels at connecting LLMs to diverse data sources through an extensive loader ecosystem. LlamaIndex is Python-first with [LlamaIndex.TS](https://github.com/run-llama/LlamaIndexTS) for TypeScript. Its index abstractions (vector, list, tree, keyword table) provide multiple retrieval strategies out of the box. For Python teams building data-intensive RAG applications, LlamaIndex offers deep, well-tested retrieval primitives.

### Haystack (deepset)

[Haystack](https://github.com/deepset-ai/haystack) by deepset takes a pipeline-based approach to RAG, designed for production NLP systems. It is Python-only and emphasizes component architecture where each step (retrieval, ranking, generation) is a modular node in a directed acyclic graph. Haystack has strong production tooling with monitoring, evaluation, and deployment support. For teams building production NLP pipelines in Python, Haystack provides a well-structured, enterprise-ready framework.

### Vercel AI SDK

The [Vercel AI SDK](https://github.com/vercel/ai) is a TypeScript-native, lightweight toolkit for building AI-powered applications. It takes a provider-agnostic approach to model access, with a clean abstraction layer over 40+ LLM and embedding providers. The AI SDK is intentionally minimal -- it provides the building blocks (streaming, tool calling, embeddings) without imposing framework-level opinions on how you structure your application. d8um builds directly on the AI SDK's embedding ecosystem, using its provider interface as the standard for embedding model access.

### Where d8um fits

d8um occupies a specific position in this landscape:

- **TypeScript-native.** Not a Python framework with a TypeScript port. The type system, APIs, and developer experience are designed for TypeScript from the ground up.
- **Composable, not a framework.** d8um does not ask you to build inside it. It provides retrieval as a library that composes alongside your existing stack -- your web framework, your database, your deployment model.
- **Per-source embedding models.** Different data sources have different characteristics. d8um lets each source use the embedding model best suited to its content, then handles the multi-model fan-out and merge transparently.
- **Unified retrieval + memory.** d8um's retrieval engine and cognitive memory system share the same embedding infrastructure and adapter layer, providing a single SDK for both RAG and agent memory.
- **AI SDK ecosystem.** Rather than maintaining its own embedding provider wrappers, d8um builds on the Vercel AI SDK ecosystem. Any provider that works with the AI SDK works with d8um.

The RAG landscape benefits from having tools optimized for different audiences and runtimes. LangChain and LlamaIndex serve the Python ecosystem exceptionally well. d8um serves TypeScript developers who want composable retrieval without framework lock-in.
