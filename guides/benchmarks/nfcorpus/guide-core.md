# NFCorpus Benchmark — d8um Core (Hybrid Search)

Run the full [BEIR NFCorpus](https://www.nfcorpus.org/) benchmark against d8um using hybrid search (vector + BM25 with RRF fusion). This evaluates pure retrieval quality with zero LLM calls at query time.

## What You'll Measure

| Metric | Description |
|--------|-------------|
| **nDCG@10** | Normalized Discounted Cumulative Gain — primary BEIR metric, accounts for graded relevance |
| **MAP@10** | Mean Average Precision — rewards placing relevant docs earlier |
| **Recall@10** | Fraction of relevant docs retrieved in top 10 |
| **Precision@10** | Fraction of top 10 that are relevant |

**Reference baseline:** BM25 achieves nDCG@10 ≈ 0.325 on NFCorpus.

## About NFCorpus

NFCorpus (NeurIPS 2021, part of BEIR) is the smallest benchmark in the BEIR suite:

- **3,633** PubMed medical/nutrition abstracts
- **323** test queries with graded relevance judgments (0/1/2)
- Clean plain text, no preprocessing needed
- Small enough to run in full — no subsetting required

## Prerequisites

- Node.js 18+
- A [Vercel AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-core/settings#api-key) API key

## Setup

```bash
mkdir nfcorpus-benchmark && cd nfcorpus-benchmark
npm init -y
npm install @d8um/core @d8um/adapter-sqlite-vec @ai-sdk/gateway ai
```

Set your API key:

```bash
export AI_GATEWAY_API_KEY=your-key-here
```

## Understanding the Script

The script (`run-core.ts`) runs through 7 phases:

### Phase 1: Initialize d8um

```typescript
import { d8umCreate } from '@d8um/core'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'
import { gateway } from '@ai-sdk/gateway'

const adapter = new SqliteVecAdapter({ dbPath: './nfcorpus-core.db' })
const d = await d8umCreate({
  vectorStore: adapter,
  embedding: {
    model: gateway.textEmbeddingModel('openai/text-embedding-3-small'),
    dimensions: 1536,
  },
})
```

This creates a d8um instance with:
- **SQLite** for local vector storage (no external database)
- **text-embedding-3-small** (1536 dims) via Vercel AI Gateway
- **No LLM** — core mode is pure retrieval, no generation needed

### Phase 2: Download NFCorpus

Data is fetched directly from the HuggingFace Datasets Server REST API — no Python, no `datasets` library:

```typescript
const corpus = await fetchAllRows('BeIR/nfcorpus', 'corpus', 'corpus')    // 3,633 docs
const queries = await fetchAllRows('BeIR/nfcorpus', 'queries', 'queries') // test queries
const qrels = await fetchAllRows('BeIR/nfcorpus-qrels', 'default', 'test') // relevance judgments
```

Each corpus document has `{ _id, title, text }`. Each query has `{ _id, text }`. Qrels map `(query-id, corpus-id) → score`.

### Phase 3: Ingest Corpus

Each document is chunked (512 tokens, 64 overlap) and embedded:

```typescript
const bucket = await d.buckets.create({ name: 'nfcorpus' })

for (const doc of corpus) {
  await d.ingest(bucket.id, [{
    id: doc._id,
    title: doc.title,
    content: `${doc.title}\n\n${doc.text}`,
    updatedAt: new Date(),
    metadata: { corpusId: doc._id },
  }], {
    chunkSize: 512,
    chunkOverlap: 64,
    deduplicateBy: ['content'],
  })
}
```

The `corpusId` in metadata is critical — it's how we map retrieval results back to BEIR document IDs for scoring.

### Phase 4: Run Queries

For each of the 323 test queries, call `d8um.query()` in hybrid mode:

```typescript
const response = await d.query(queryText, {
  mode: 'hybrid', // vector + BM25, merged via RRF
  count: 10,
  buckets: [bucket.id],
})
```

**Hybrid mode** runs two parallel retrieval paths:
1. **Vector search** — cosine similarity on chunk embeddings
2. **BM25 keyword search** — term frequency matching

Results are merged using **Reciprocal Rank Fusion (RRF)**, which combines the rankings from both paths without needing score calibration.

### Phase 5: Scoring

Standard IR metrics are computed by comparing retrieved document IDs against BEIR ground truth:

- **nDCG@10** uses graded relevance (0/1/2) — a score-2 document ranked first contributes more than a score-1 document
- **MAP@10** treats any score > 0 as relevant (binary)
- **Recall/Precision@10** also use binary relevance

All scoring is deterministic — zero LLM calls.

### Phase 6: Results Output

The script prints a formatted results table and saves detailed JSON to `nfcorpus-results-core.json`.

### Phase 7: Cleanup

The SQLite database is automatically deleted after the run.

## Running the Benchmark

```bash
npx tsx run-core.ts
```

Expected runtime: depends on embedding API throughput. Ingestion is the bottleneck (3,633 documents × multiple chunks each). Queries are fast (local SQLite).

## Example Output

```
══════════════════════════════════════════════════════
  NFCorpus Benchmark — d8um Core (Hybrid Search)
══════════════════════════════════════════════════════

  Corpus:        3,633 documents ingested
  Queries:       323 (full BEIR test set)
  Mode:          hybrid (vector + BM25, RRF fusion)

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

## Customization

| Parameter | Default | Notes |
|-----------|---------|-------|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Any model available through Vercel AI Gateway |
| `EMBEDDING_DIMS` | `1536` | Must match the model's output dimensions |
| `CHUNK_SIZE` | `512` | Tokens per chunk |
| `CHUNK_OVERLAP` | `64` | Overlapping tokens between adjacent chunks |
| `K` | `10` | Number of results to retrieve per query |

## Comparing with Neural Mode

Run the neural variant (`run-neural.ts`) to see how knowledge graph augmentation affects retrieval quality on entity-rich medical queries. See [guide-neural.md](./guide-neural.md).

## Troubleshooting

**Rate limits:** If you hit embedding API rate limits during ingestion, the script will fail. Consider requesting higher limits or adding retry logic.

**Memory:** SQLite keeps the database on disk, so memory usage is bounded. The main memory consumer is the embedding API response buffer.

**Missing API key:** Set `AI_GATEWAY_API_KEY` in your environment. The Vercel AI Gateway routes to the appropriate provider (OpenAI for embeddings).
