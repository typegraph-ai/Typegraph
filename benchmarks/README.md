# d8um Benchmarks

Reproducible evaluation of d8um's retrieval and graph-RAG capabilities against published academic benchmarks. Each benchmark uses the **exact methodology** (chunk sizes, scoring functions, context windows) from its source paper to ensure results are directly comparable to published baselines.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running Benchmarks](#running-benchmarks)
- [CLI Flags](#cli-flags)
- [Datasets](#datasets)
- [Benchmark Variants](#benchmark-variants)
- [Step-by-Step Walkthrough](#step-by-step-walkthrough)
- [Resuming Failed Runs](#resuming-failed-runs)
- [Idempotency and Deduplication](#idempotency-and-deduplication)
- [Clearing Data for Reseed](#clearing-data-for-reseed)
- [Answer-Generation Evaluation](#answer-generation-evaluation)
- [Recording Results](#recording-results)
- [Architecture](#architecture)
- [Metrics](#metrics)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Node.js 18+
- The d8um SDK built from source (`pnpm run build` from the repo root)
- A `.env` file in this directory with the required credentials (see `.env.example`)

### Required Services

| Service | What it's used for | Env var |
|---------|-------------------|---------|
| [Neon Postgres](https://neon.tech) | pgvector storage for chunks, entities, and graph data | `NEON_DATABASE_URL` |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | Embeddings (text-embedding-3-small) and LLM calls (gpt-5.4-mini, grok-4.20-reasoning) | `AI_GATEWAY_API_KEY` |
| [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) | Dataset storage (corpus, queries, qrels, gold answers) | `BLOB_READ_WRITE_TOKEN` |

## Setup

```bash
# 1. Build the SDK (REQUIRED — benchmark runners import from dist/)
cd /path/to/d8um
pnpm run build

# 2. Install benchmark dependencies
cd benchmarks
npm install

# 3. Create your .env from the example
cp .env.example .env
# Then fill in your credentials
```

**Always rebuild the SDK before running benchmarks.** The runners import d8um packages via their compiled `dist/` output (package.json `exports` field). Running against a stale build causes silent failures or incorrect behavior.

## Running Benchmarks

All commands are run from the `benchmarks/` directory:

```bash
# Basic query-only run (no seeding, uses existing indexed data)
npx tsx --env-file=.env {dataset}/{variant}/run.ts

# Validate pipeline before seeding (5 docs, 5 queries — takes <30s)
npx tsx --env-file=.env {dataset}/{variant}/run.ts --validate

# Seed the database with the full corpus, then run queries
npx tsx --env-file=.env {dataset}/{variant}/run.ts --seed

# Run and save results to history file
npx tsx --env-file=.env {dataset}/{variant}/run.ts --record
```

### Examples

```bash
# Run license-tldr core benchmark (hybrid + fast modes)
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts

# Validate, seed, and record multihop-rag neural benchmark
npx tsx --env-file=.env multihop-rag/neural/run.ts --validate
npx tsx --env-file=.env multihop-rag/neural/run.ts --seed --record

# Run graphrag-bench-novel with answer evaluation (100 queries)
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --eval-answers-limit=100

# Resume an interrupted answer eval
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --run-id=37e85e19-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## CLI Flags

| Flag | Description | When to use |
|------|-------------|-------------|
| `--validate` | Smoke test: ingest 5 docs, run 5 queries in a temporary bucket, then clean up. | **Mandatory** before first `--seed` on new or cleared data. |
| `--seed` | Re-index the full corpus into the database. Does NOT drop tables — uses upsert with hash-based deduplication. | When you need to populate or re-populate the database. |
| `--record` | Append results to `history-{mode}.json` in the benchmark directory. | When you want to persist results for trend tracking. |
| `--eval-answers` | Run answer-generation evaluation alongside retrieval metrics in the same query loop. | For multihop-rag (required flag) and graphrag-bench (on by default). |
| `--eval-answers-only` | Query only the gold-answer subset, skip full IR metrics. Much faster. | Quick iteration on answer-gen quality without re-running all queries. |
| `--eval-answers-limit=N` | Limit answer evaluation to N queries (default: 100). | Control eval cost/time. Use `--eval-answers-limit=20` for quick tests. |
| `--eval-model=MODEL` | Override the LLM for answer generation (default: `openai/gpt-5.4-mini`). | Test different models: `--eval-model=openai/gpt-4o` |
| `--run-id=UUID` | Resume a previous eval run. Loads cached per-query scores from the JSONL cache and skips already-scored queries. | Resuming after a timeout, crash, or rate limit error. |

## Datasets

| Dataset | Corpus Size | Queries | Chunk Size | Scoring | Source |
|---------|-------------|---------|------------|---------|--------|
| `nfcorpus` | 3,633 docs | 323 | 2048 | BEIR IR | [BEIR](https://github.com/beir-cellar/beir) |
| `australian-tax-guidance-retrieval` | ~105 docs | ~112 | 2048 | BEIR IR | [MLEB](https://huggingface.co/spaces/isaacus/MLEB) |
| `contractual-clause-retrieval` | ~90 docs | ~90 | 2048 | BEIR IR | MLEB |
| `license-tldr-retrieval` | 65 docs | 65 | 2048 | BEIR IR | MLEB |
| `mleb-scalr` | 523 docs | 120 | 2048 | BEIR IR | MLEB |
| `legal-rag-bench` | 4,876 docs | 100 | 2048 | BEIR IR | MLEB |
| `multihop-rag` | 609 docs | ~2,556 | **256** | IR + word-intersection ACC | [COLM 2024](https://arxiv.org/abs/2401.15391) |
| `graphrag-bench-novel` | 1,147 docs | 2,010 | **1200** | LLM-as-judge ACC | [arXiv:2506.05690](https://arxiv.org/abs/2506.05690) |
| `graphrag-bench-medical` | ~1,000 docs | 2,062 | **1200** | LLM-as-judge ACC | arXiv:2506.05690 |

**Chunk sizes are per-benchmark, not global.** Each benchmark's chunk size matches the methodology used by published baselines for that dataset. Using the wrong chunk size makes results incomparable.

### Estimated Seed Times

Embedding throughput is ~3 docs/s for core, much slower for neural due to LLM extraction calls.

| Dataset | Core Seed | Neural Seed (concurrency=5) |
|---------|-----------|----------------------------|
| license-tldr-retrieval | ~30s | ~96s |
| contractual-clause-retrieval | ~30s | ~2min |
| australian-tax-guidance-retrieval | ~35s | ~2min |
| mleb-scalr | ~3min | ~10min |
| multihop-rag | ~3min | ~33min |
| legal-rag-bench | ~27min | ~2h (est.) |
| nfcorpus | ~20min | ~3-4h (est.) |
| graphrag-bench-novel | ~10min | ~139min (grok-4.20-reasoning) |

## Benchmark Variants

Each dataset has two variants with fully isolated database tables — no cleanup needed between them.

### Core (`{dataset}/core/run.ts`)

Runs hybrid search (vector + BM25 with RRF fusion) and pure vector (fast) search in a single run. Reports metrics for both modes.

- Table prefix: `bench_{name}_core_`
- Runs both `hybrid` and `fast` modes
- No LLM calls during query (only embeddings)
- Typical query latency: 30-700ms

### Neural (`{dataset}/neural/run.ts`)

Runs hybrid search + cognitive memory + Personalized PageRank graph traversal, fused via RRF. Requires LLM for triple extraction during seeding and graph traversal during queries.

- Table prefix: `bench_{name}_neural_`
- Additional graph tables: `*_memories`, `*_entities`, `*_edges`
- Uses `EXTRACTION_MODEL` (default: `xai/grok-4.20-reasoning`) for entity/relationship extraction
- Typical query latency: 2,000-8,000ms

## Step-by-Step Walkthrough

Here's the recommended workflow for running a benchmark from scratch:

### 1. Build the SDK

```bash
cd /path/to/d8um
pnpm run build
```

### 2. Validate the pipeline

Always validate before seeding. This catches configuration errors, missing credentials, and SDK regressions in <30 seconds:

```bash
cd benchmarks
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts --validate
```

You'll see step-by-step output:

```
[1/4] Creating validation bucket __validate_license-tldr_1711900000...
[2/4] Ingesting 5 documents...
[3/4] Running 5 queries...
[4/4] Cleaning up...
Validation PASSED: 5 docs ingested, 47 results returned
```

If validation fails, fix the issue before proceeding. Common causes: missing `.env` values, stale SDK build, database connectivity.

### 3. Seed the database

```bash
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts --seed
```

The runner will:
1. Fetch the corpus from Vercel Blob
2. Chunk documents according to the benchmark's chunk size
3. Generate embeddings via AI Gateway
4. Store chunks in pgvector with hash-based deduplication
5. Run all test queries and report metrics

### 4. Run queries (subsequent runs)

Once seeded, you can run queries without `--seed` — it's much faster:

```bash
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts
```

### 5. Record results

```bash
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts --record
```

Results are appended to `license-tldr-retrieval/core/history-hybrid.json` and `history-fast.json`.

## Resuming Failed Runs

### Seeding

**Seeding is safe to resume.** If a seed is interrupted (timeout, crash, rate limit), just run `--seed` again. The hash store tracks which documents have been ingested:

- Documents with unchanged content are skipped (hash match)
- The upsert query (`ON CONFLICT ... DO UPDATE`) prevents duplicate rows
- Completed documents are never re-processed

```bash
# Interrupted — just run again
npx tsx --env-file=.env nfcorpus/neural/run.ts --seed
```

### Answer evaluation

For long-running answer evaluations (GraphRAG-Bench can take 6-10 hours), use `--run-id` to resume:

```bash
# First run — note the run ID printed at startup
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts
# Output: "Run ID: 37e85e19-1234-5678-9abc-def012345678"

# If interrupted, resume with the same run ID
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --run-id=37e85e19-1234-5678-9abc-def012345678
```

The eval cache writes each scored query to a JSONL file immediately (`{dataset}/{variant}/runs/{runId}.jsonl`). On resume, already-scored queries are skipped automatically.

## Idempotency and Deduplication

The benchmark pipeline is designed to be safely re-run:

- **Hash store deduplication**: Each document's content is SHA256-hashed on ingest. The hash is stored in `d8um_hashes` keyed by content + embedding model. On re-seed, documents with matching hashes are skipped entirely — no embedding calls, no database writes.

- **Upsert at the chunk level**: Even if a document passes the hash check, the chunk INSERT uses `ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE`, preventing row duplication at the database level.

- **Eval cache**: Answer evaluation scores are persisted per-query in JSONL files. The `--run-id` flag resumes from where the previous run left off.

**What this means in practice:**
- Running `--seed` twice on the same data is a no-op (all docs skipped)
- Interrupted seeds resume correctly — only un-ingested docs are processed
- You can safely re-run any benchmark command without worrying about duplicate data

### When idempotency does NOT help

The hash store matches on **content + embedding model**. If you change any of these, re-seeding won't help because the hash still matches and the document is skipped:

- Triple extraction pipeline changes (new edge properties, new entity types)
- Chunk size changes
- Ingestion config changes (e.g., `propagateMetadata`)

In these cases, you must **clear the data first** (see next section), then reseed.

## Clearing Data for Reseed

When you need to reseed with changed configuration, you must clear the existing data first. `--seed` does NOT drop tables.

### Core variant

```sql
-- Replace {prefix} with the table prefix (e.g., bench_license_core_)
-- Replace {bucket_name} with the bucket name (e.g., license-tldr)

TRUNCATE TABLE {prefix}_gateway_openai_text_embedding_3_small;
TRUNCATE TABLE {prefix}_registry;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
```

### Neural variant (core tables + graph tables)

```sql
TRUNCATE TABLE {prefix}_gateway_openai_text_embedding_3_small;
TRUNCATE TABLE {prefix}_registry;
TRUNCATE TABLE {prefix}memories;
TRUNCATE TABLE {prefix}entities;
TRUNCATE TABLE {prefix}edges;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
```

Note: Neural graph tables use `{prefix}memories` (no extra underscore), e.g., `bench_license_neural_memories`.

### Running the clear query

From the `benchmarks/` directory:

```bash
node -e "
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();
const sql = neon(process.env.NEON_DATABASE_URL);
sql\`TRUNCATE TABLE bench_license_core__gateway_openai_text_embedding_3_small\`
  .then(r => console.log('Done'))
  .catch(e => console.error(e.message));
"
```

**Always verify the DELETE count is > 0** for hashes and documents. If the count is 0, the hash store was not cleared and the subsequent seed will skip all documents.

### Table prefix / bucket reference

| Dataset | Variant | Table Prefix | Bucket Name |
|---------|---------|-------------|-------------|
| nfcorpus | core | `bench_nfcorpus_core_` | `nfcorpus` |
| nfcorpus | neural | `bench_nfcorpus_neural_` | `nfcorpus-neural` |
| australian-tax | core | `bench_au_tax_core_` | `au-tax-guidance` |
| australian-tax | neural | `bench_au_tax_neural_` | `au-tax-guidance-neural` |
| license-tldr | core | `bench_license_core_` | `license-tldr` |
| license-tldr | neural | `bench_license_neural_` | `license-tldr-neural` |
| contractual-clause | core | `bench_contract_core_` | `contractual-clause` |
| contractual-clause | neural | `bench_contract_neural_` | `contractual-clause-neural` |
| mleb-scalr | core | `bench_mleb_core_` | `mleb-scalr` |
| mleb-scalr | neural | `bench_mleb_neural_` | `mleb-scalr-neural` |
| legal-rag-bench | core | `bench_legalrag_core_` | `legal-rag-bench` |
| legal-rag-bench | neural | `bench_legalrag_neural_` | `legal-rag-bench-neural` |
| multihop-rag | core | `bench_multihop_core_` | `multihop-rag` |
| multihop-rag | neural | `bench_multihop_neural_` | `multihop-rag-neural` |
| graphrag-bench-novel | core | `bench_grbnovel_core_` | `graphrag-bench-novel` |
| graphrag-bench-novel | neural | `bench_grbnovel_neural_` | `graphrag-bench-novel-neural` |
| graphrag-bench-medical | core | `bench_grbmed_core_` | `graphrag-bench-medical` |
| graphrag-bench-medical | neural | `bench_grbmed_neural_` | `graphrag-bench-medical-neural` |

## Answer-Generation Evaluation

Two datasets support answer-generation evaluation with different scoring methods:

### MultiHop-RAG (COLM 2024)

Uses **word-intersection accuracy (ACC)** — true if ANY word in the predicted answer overlaps with ANY word in the gold answer (case-insensitive). This matches `has_intersection()` in the paper's `qa_evaluate.py`.

```bash
# Run answer eval alongside retrieval metrics
npx tsx --env-file=.env multihop-rag/neural/run.ts --eval-answers

# Answer-only mode (queries gold-answer subset only, skips full IR)
npx tsx --env-file=.env multihop-rag/neural/run.ts --eval-answers-only

# Quick test with 20 queries
npx tsx --env-file=.env multihop-rag/core/run.ts --eval-answers --eval-answers-limit=20
```

### GraphRAG-Bench (arXiv:2506.05690)

Uses **LLM-as-judge answer correctness** = 0.75 x factuality_fbeta + 0.25 x semantic_similarity. Returns a continuous 0.0-1.0 score. Runs answer eval by default (no `--eval-answers` flag needed).

```bash
# Default: runs answer eval on 100 queries
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts

# Full eval (all 2,010 queries — takes 6-10 hours)
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --eval-answers-limit=2010

# Resume interrupted eval
npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --run-id=UUID
```

**Do NOT mix scoring methods across benchmarks.** MultiHop-RAG ACC (word-intersection, binary) and GraphRAG-Bench ACC (LLM-as-judge, continuous) are completely different metrics that happen to share the name "ACC".

## Recording Results

Use `--record` to persist results in history files for trend tracking:

```bash
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts --record
```

### History file format

Results are saved to `{dataset}/{variant}/history-{mode}.json` (e.g., `history-hybrid.json`, `history-fast.json`, `history-neural.json`):

```json
[
  {
    "commit": "6e18f34",
    "date": "2026-03-28",
    "metrics": { "nDCG@10": 0.6485, "MAP@10": 0.5912, "Recall@10": 0.7234, "Precision@10": 0.4615 },
    "avgQueryMs": 306,
    "timing": { "ingestionSeconds": 28, "avgQueryMs": 306, "totalSeconds": 45 },
    "mode": "hybrid",
    "config": { "embedding": "openai/text-embedding-3-small", "chunkSize": 2048 }
  }
]
```

Core runners append two entries per run (one for `hybrid`, one for `fast`). Neural runners append one entry (`neural`).

## Architecture

### Shared Library (`lib/`)

All 18 runners use composable helpers from the shared library:

| Module | Purpose |
|--------|---------|
| `config.ts` | Registry of all benchmark configs (dataset, bucket, table prefix, modes, scorer) |
| `runner.ts` | `initCore()`, `initNeural()`, `parseCliArgs()`, dataset loading, ingestion, query orchestration |
| `adapter.ts` | Creates pgvector adapter with benchmark-specific table prefix |
| `datasets.ts` | Loaders for BEIR, Legal-RAG, and GraphRAG-Bench corpus formats from Vercel Blob |
| `metrics.ts` | IR scoring (nDCG, MAP, Recall, Precision, MRR, Hit), answer-gen scoring (word-intersection ACC, LLM-as-judge ACC), document-level deduplication |
| `report.ts` | Result formatting and JSON output (delimited by `---BENCH_RESULT_JSON---`) |
| `history.ts` | Local history file recording (`--record` flag) |
| `validate.ts` | Smoke test pipeline (`--validate` flag) |
| `eval-cache.ts` | JSONL-based crash-safe persistence for answer eval runs (`--run-id` flag) |

### Runner Structure

Each runner is a thin `main()` function that composes shared helpers:

```
1. Parse CLI args (--seed, --validate, --record, etc.)
2. Initialize d8um (initCore or initNeural)
3. Load dataset from Vercel Blob (corpus, queries, qrels)
4. If --validate: run smoke test and exit
5. If --seed: ingest full corpus
6. Run queries in configured modes (hybrid/fast for core, neural for neural)
7. Compute metrics (IR + optional answer-gen)
8. Emit results as JSON
9. If --record: append to history file
```

### Database Table Naming

Chunk tables encode the full embedding model path:

```
{prefix}_gateway_openai_text_embedding_3_small
```

Shared tables across all benchmarks:
- `d8um_documents` — document records
- `d8um_hashes` — content hashes for deduplication
- `d8um_buckets` — bucket registry

## Metrics

### Retrieval Metrics (all benchmarks)

BEIR-standard metrics at cutoff 10:

| Metric | Description |
|--------|-------------|
| **nDCG@10** | Normalized Discounted Cumulative Gain |
| **MAP@10** | Mean Average Precision |
| **Recall@10** | Recall |
| **Precision@10** | Precision |
| **MRR@10** | Mean Reciprocal Rank (multihop-rag only) |
| **Hit@10** | Hit rate at 10 (multihop-rag only) |

### Answer-Generation Metrics

| Benchmark | Metric | Type | Description |
|-----------|--------|------|-------------|
| MultiHop-RAG | ACC | Binary (0 or 1) | Word-intersection: true if ANY word overlaps between predicted and gold |
| MultiHop-RAG | EM | Binary | Exact match after normalization |
| MultiHop-RAG | F1 | Continuous | Token-level F1 score |
| GraphRAG-Bench | ACC | Continuous (0.0-1.0) | 0.75 x factuality_fbeta + 0.25 x semantic_similarity (LLM-as-judge) |

## Troubleshooting

### "All documents skipped" during seed

The hash store matches on content + embedding model. If both are unchanged, documents are skipped even if you changed the extraction pipeline or chunk size. **Solution:** Clear the hash store entries for the benchmark's bucket (see [Clearing Data for Reseed](#clearing-data-for-reseed)).

### Stale SDK build

If you see unexpected errors or metrics that don't match expectations, rebuild:

```bash
cd /path/to/d8um
pnpm run build
```

The benchmark runners import from `dist/`, not source. A stale build is the most common cause of confusing behavior.

### Out of memory (neural seed on large datasets)

Neural ingestion on 600+ doc datasets can exceed Node.js default heap (~1.7GB). Set:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npx tsx --env-file=.env nfcorpus/neural/run.ts --seed
```

### Rate limits during answer evaluation

GraphRAG-Bench answer eval makes 2-3 LLM calls per query (answer generation + judge scoring). At 2,000 queries, that's 4,000-6,000 LLM calls. If you hit rate limits:

1. Note the run ID from the console output
2. Wait for the rate limit window to reset
3. Resume: `npx tsx --env-file=.env graphrag-bench-novel/neural/run.ts --run-id=YOUR_RUN_ID`

Already-scored queries are skipped automatically.

### Validation fails

Common causes:
- Missing or invalid `.env` values
- Database not reachable (check `NEON_DATABASE_URL`)
- SDK not built (`pnpm run build` from repo root)
- pgvector extension not enabled on the database
