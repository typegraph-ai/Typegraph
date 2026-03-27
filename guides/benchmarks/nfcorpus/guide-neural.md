# NFCorpus Benchmark — d8um Graph (Neural Search)

Run the full [BEIR NFCorpus](https://www.nfcorpus.org/) benchmark against d8um using neural search — hybrid retrieval augmented with memory recall and Personalized PageRank (PPR) graph traversal over an automatically-constructed knowledge graph.

## What You'll Measure

| Metric | Description |
|--------|-------------|
| **nDCG@10** | Normalized Discounted Cumulative Gain — primary BEIR metric, accounts for graded relevance |
| **MAP@10** | Mean Average Precision — rewards placing relevant docs earlier |
| **Recall@10** | Fraction of relevant docs retrieved in top 10 |
| **Precision@10** | Fraction of top 10 that are relevant |

**Reference baseline:** BM25 achieves nDCG@10 ≈ 0.325 on NFCorpus.

## How Neural Mode Differs from Core

| Aspect | Core (Hybrid) | Neural (Graph) |
|--------|---------------|----------------|
| **Ingest** | Chunk + embed | Chunk + embed + LLM triple extraction |
| **Query runners** | IndexedRunner (vector + BM25) | IndexedRunner + MemoryRunner + GraphRunner |
| **Graph** | None | Knowledge graph built from S-P-O triples |
| **Merge** | RRF over vector + keyword | RRF over hybrid + memory + PPR graph |
| **LLM at ingest** | None | Yes (triple extraction per chunk) |
| **LLM at query** | None | None (scoring is deterministic) |

### The Neural Query Pipeline

At query time, three runners execute in parallel:

1. **IndexedRunner** — Standard hybrid search (same as core mode)
2. **MemoryRunner** — Semantic memory recall via `graph.recall()`
3. **GraphRunner** — Seeds on entities matching the query, runs PPR over the knowledge graph, retrieves linked chunks

Results from all three are merged via **Reciprocal Rank Fusion (RRF)**.

### How the Knowledge Graph Gets Built

During ingestion, when both `llm` and `graph` are configured, d8um's `TripleExtractor` automatically:

1. Sends each chunk to the LLM to extract Subject-Predicate-Object triples
2. Calls `graph.addTriple()` for each triple
3. The graph bridge resolves entities (deduplication via alias matching + vector similarity)
4. Creates edges between entities with chunk provenance stored in edge properties

No separate jobs or post-processing needed — the graph is fully populated during ingest.

## About NFCorpus

NFCorpus (NeurIPS 2021, part of BEIR) is the smallest benchmark in the BEIR suite:

- **3,633** PubMed medical/nutrition abstracts
- **323** test queries with graded relevance judgments (0/1/2)
- Entity-rich medical content (diseases, nutrients, treatments) — ideal for graph augmentation
- Small enough to run in full

## Prerequisites

- Node.js 18+
- A [Vercel AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-core/settings#api-key) API key (routes to both OpenAI for embeddings and Google for LLM)

## Setup

```bash
mkdir nfcorpus-benchmark && cd nfcorpus-benchmark
npm init -y
npm install @d8um/core @d8um/adapter-sqlite-vec @d8um/graph @ai-sdk/gateway ai
```

Set your API key:

```bash
export AI_GATEWAY_API_KEY=your-key-here
```

## Understanding the Script

The script (`run-neural.ts`) runs through 7 phases:

### Phase 1: Initialize d8um with Graph Bridge

```typescript
import { d8umCreate } from '@d8um/core'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'
import { createGraphBridge } from '@d8um/graph'
import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'

const adapter = new SqliteVecAdapter({ dbPath: './nfcorpus-neural.db' })
const llm = createLLMProvider() // wraps gateway('google/gemini-3.1-flash-lite-preview')

const graph = createGraphBridge({
  memoryStore: adapter,
  embedding: embeddingProvider, // wraps gateway.textEmbeddingModel(...)
  llm,
  scope: { agentId: 'nfcorpus-benchmark' },
})

const d = await d8umCreate({
  vectorStore: adapter,
  embedding: { model: gateway.textEmbeddingModel('openai/text-embedding-3-small'), dimensions: 1536 },
  llm,
  graph,
})
```

Key difference from core: the `llm` and `graph` fields are provided. This activates:
- **Triple extraction** during ingest (LLM calls per chunk)
- **Neural query mode** with all three runners (hybrid + memory + graph PPR)

#### The LLM Provider

The script wraps Vercel AI Gateway's `generateText` into d8um's `LLMProvider` interface:

```typescript
function createLLMProvider() {
  const model = gateway('google/gemini-3.1-flash-lite-preview')
  return {
    async generateText(prompt, systemPrompt?) {
      const result = await generateText({ model, prompt, system: systemPrompt })
      return result.text
    },
    async generateJSON<T>(prompt, systemPrompt?) {
      const result = await generateText({ model, prompt: prompt + '\n\nRespond with valid JSON only.', system: systemPrompt })
      return JSON.parse(result.text.replace(/```json?\s*/g, '').replace(/```/g, '')) as T
    },
  }
}
```

#### The Graph Bridge

`createGraphBridge` from `@d8um/graph` composes:
- **d8umMemory** — semantic memory recall (the 5 required `GraphBridge` methods)
- **EmbeddedGraph** — entity/edge CRUD and graph traversal
- **EntityResolver** — entity deduplication (alias matching + vector similarity)

It implements all optional `GraphBridge` methods that power neural retrieval:
- `addTriple()` — stores entities + edges with chunk provenance during ingest
- `searchEntities()` — vector-searches entities matching a query
- `getAdjacencyList()` — builds bidirectional adjacency for PPR with 2-hop expansion
- `getChunksForEntities()` — retrieves chunk content from edge properties

### Phase 2: Download NFCorpus

Identical to core — data fetched from HuggingFace Datasets Server REST API.

### Phase 3: Ingest Corpus (with Triple Extraction)

Same ingestion call as core, but with LLM triple extraction running automatically:

```typescript
await d.ingest(bucket.id, [{ ... }], { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] })
```

Behind the scenes, for each chunk:
1. d8um embeds the chunk (same as core)
2. `TripleExtractor` sends the chunk to Gemini 3.1 Flash Lite
3. LLM returns S-P-O triples like: `("Vitamin D", "prevents", "osteoporosis")`
4. `graph.addTriple()` resolves entities and creates edges

**This phase is significantly slower than core** due to LLM calls. Triple extraction errors are non-blocking — if extraction fails for a chunk, indexing continues.

### Phase 4: Run Queries (Neural Mode)

```typescript
const response = await d.query(queryText, {
  mode: 'neural',
  count: 10,
  buckets: [bucket.id],
})
```

Neural mode runs three parallel runners:

1. **IndexedRunner** — Same hybrid search as core (vector + BM25)
2. **MemoryRunner** — Calls `graph.recall()` for semantic memory matches
3. **GraphRunner** — PPR pipeline:
   - Calls `graph.searchEntities()` to find entities matching the query
   - Calls `graph.getAdjacencyList()` to build a local subgraph
   - Runs Personalized PageRank seeded on matching entities
   - Calls `graph.getChunksForEntities()` to retrieve content from high-scoring entities

All results are merged via RRF. **Zero LLM calls at query time** — scoring is fully deterministic.

### Phases 5-7: Scoring, Output, Cleanup

Identical to core — same IR metrics, same output format, same automatic cleanup.

## Running the Benchmark

```bash
npx tsx run-neural.ts
```

Expected runtime: longer than core due to LLM triple extraction during ingestion. Query time should be comparable (local SQLite + graph traversal, no LLM calls).

## Example Output

```
══════════════════════════════════════════════════════
  NFCorpus Benchmark — d8um Graph (Neural Search)
══════════════════════════════════════════════════════

  Corpus:        3,633 documents ingested
  Queries:       323 (full BEIR test set)
  Mode:          neural (hybrid + memory + PPR graph, RRF fusion)
  LLM:           google/gemini-3.1-flash-lite-preview (ingest only)

  ── Retrieval Scores ──
  nDCG@10:       0.XXXX
  MAP@10:        0.XXXX
  Recall@10:     0.XXXX
  Precision@10:  0.XXXX

  ── Reference Baselines ──
  BM25:          nDCG@10 = 0.325

  ── Timing ──
  Ingestion:     XX.Xs (XXX docs/sec)
  Avg Query:     XX.Xms
  Total:         Xm XXs
```

## When Does Neural Mode Help?

Neural mode is most beneficial when:

- **Entity-rich queries** — "What nutrients prevent bone loss?" connects concepts through the knowledge graph that keyword/vector search might miss
- **Multi-hop reasoning** — The graph links entities across documents, so a query about "Vitamin D" can surface documents about "osteoporosis" through triple edges
- **Recall-oriented tasks** — PPR expands the retrieval frontier beyond direct lexical/semantic matches

NFCorpus is a good test case because medical literature has dense entity relationships (nutrients, diseases, treatments, mechanisms).

## Customization

| Parameter | Default | Notes |
|-----------|---------|-------|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Any model via Vercel AI Gateway |
| `EMBEDDING_DIMS` | `1536` | Must match model output |
| `LLM_MODEL` | `google/gemini-3.1-flash-lite-preview` | Used only for triple extraction |
| `CHUNK_SIZE` | `512` | Tokens per chunk |
| `CHUNK_OVERLAP` | `64` | Overlap between chunks |
| `K` | `10` | Results per query |

## Comparing with Core Mode

Run the core variant (`run-core.ts`) to establish a hybrid-only baseline, then compare neural results. See [guide-core.md](./guide-core.md).

Key comparison points:
- **Ingestion time**: Neural is slower (LLM calls per chunk)
- **Query time**: Should be similar (no LLM at query time)
- **nDCG@10**: Neural may improve on entity-rich queries

## Troubleshooting

**Slow ingestion:** Triple extraction adds an LLM call per chunk. Use a fast model (Gemini 3.1 Flash Lite) and expect 5-10x slower ingestion than core. Triple extraction errors don't block indexing.

**Rate limits:** Both embedding (OpenAI) and LLM (Google) APIs are called during ingestion. Monitor rate limit errors in the output.

**Missing API key:** `AI_GATEWAY_API_KEY` must be set. The Vercel AI Gateway routes requests to the appropriate provider based on the model string.

**Low graph impact:** If neural scores are similar to core, the knowledge graph may not have enough edges. Check `tripleExtractionErrors` in the results JSON — high error rates mean fewer triples were extracted.
