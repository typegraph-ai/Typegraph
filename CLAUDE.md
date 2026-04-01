# CLAUDE.md — d8um Project Guide

d8um is a TypeScript SDK for retrieval + memory for AI agents, built on Postgres + pgvector.

## Architecture

- **Monorepo**: pnpm workspaces + turborepo
- **Benchmarks dir**: Uses npm (not pnpm) with `file:` protocol deps pointing to the SDK
- **Database**: Neon serverless Postgres with pgvector
- **Embeddings**: AI Gateway (Vercel) → openai/text-embedding-3-small
- **LLM**: AI Gateway → openai/gpt-5.4-mini (triple extraction + answer gen)
- **Blob storage**: Vercel Blob (for benchmark datasets)

## Sandbox Access

Claude Code's sandbox has outbound access to **all required services**:
- GitHub (github.com, api.github.com)
- Neon DB (neon.tech domains)
- AI Gateway / Vercel services (embeddings, LLM, Blob storage)

**All credentials are in `benchmarks/.env`.** You can run benchmarks and DB queries directly from the sandbox without CI.

**Prerequisite:** Always run `pnpm run build` from the repo root before running benchmarks. The benchmark runners import from the SDK's `dist/` output (not source), so an outdated build causes silent errors or incorrect behavior.

## Running Benchmarks

Benchmarks can be run **locally** (preferred) or via **GitHub Actions CI** (for PR comment history and concurrent runs).

### Running Locally

```bash
# From repo root — always build first
pnpm run build

# From benchmarks/ directory:
npx tsx --env-file=.env {dataset}/{variant}/run.ts               # query-only
npx tsx --env-file=.env {dataset}/{variant}/run.ts --seed         # re-index corpus
npx tsx --env-file=.env {dataset}/{variant}/run.ts --validate     # smoke test (5 docs, 5 queries)
npx tsx --env-file=.env {dataset}/{variant}/run.ts --record       # save results to history file
```

Examples:
```bash
npx tsx --env-file=.env license-tldr-retrieval/core/run.ts
npx tsx --env-file=.env multihop-rag/neural/run.ts --eval-answers-only
npx tsx --env-file=.env multihop-rag/neural/run.ts --seed --record
```

**CLI flags:**
- `--validate` — **MANDATORY before any --seed on new/cleared data.** Runs 5 docs + 5 queries to verify pipeline works. Takes <30s.
- `--seed` — Re-indexes the corpus. Requires DB clearing first if changing chunk size/embedding model (see Clearing section). **Requires explicit user approval.**
- `--record` — Appends results to `history-{mode}.json` locally (same format CI uses).
- `--eval-answers` / `--eval-answers-only` / `--eval-answers-limit=N` / `--eval-model=MODEL` — Answer-gen eval (multihop-rag only).

**Notes:**
- Run from the `benchmarks/` directory so relative imports resolve correctly
- `--env-file=.env` (relative path) requires being in `benchmarks/` when running
- Results are printed to stdout as JSON after `---BENCH_RESULT_JSON---`

### Benchmark Architecture

All 14 runners use a shared library (`benchmarks/lib/`):
- **`config.ts`** — Registry of all benchmark configs (dataset, bucket, table prefix, modes, scorer)
- **`runner.ts`** — Composable helpers: `initCore`, `initNeural`, `loadDataset`, `runIngestion`, `runQueries`, `computeMetrics`, `buildResult`, `emitResults`
- **`history.ts`** — Local history recording (`--record` flag)
- **`validate.ts`** — Smoke test (`--validate` flag)
- **`adapter.ts`** / **`datasets.ts`** / **`metrics.ts`** / **`report.ts`** — Shared utilities

### Adding a New Benchmark

1. Upload dataset to Vercel Blob via a seed script in `benchmarks/scripts/`
2. Add config entries in `benchmarks/lib/config.ts` (one per variant)
3. Create `benchmarks/{dataset}/baselines.json` with external comparison scores
4. Create runner files using shared helpers: `benchmarks/{dataset}/core/run.ts` and `/neural/run.ts`
5. Run `--validate` to verify the pipeline end-to-end
6. Get user approval, then run `--seed --record`
7. Add to CI DATASETS list in `benchmarks.yml`

### Running via CI

CI is still useful for: recording results to history files automatically, running on PR branches, concurrent multi-benchmark runs, and the timeout handling for very large jobs.

#### Prerequisites

1. You must be on a **non-main branch** with an **open PR**
2. Push a commit with a benchmark tag in the commit message

### Commit Message Tags

Format: `[bench:DATASET/VARIANT]`, `[bench:DATASET/VARIANT:seed]`, or `[bench:DATASET/VARIANT:answers[:MODEL]]`

- **DATASET**: `nfcorpus`, `australian-tax-guidance-retrieval`, `contractual-clause-retrieval`, `license-tldr-retrieval`, `mleb-scalr`, `legal-rag-bench`, `multihop-rag`, or `all`
- **VARIANT**: `core` (hybrid search), `neural` (hybrid + memory + PPR graph), or `all`
- **:seed** (optional): Seeds the database with benchmark corpus first. Required on first run or when testing ingestion changes.
- **:answers** (optional, multihop-rag only): Runs answer-generation eval only — queries just the gold-answer subset, skips full IR metrics, reports ACC/EM/F1. Much faster (~30min timeout vs 90-180min).
- **:answers:MODEL** (optional): Same as `:answers` but overrides the LLM used for answer generation (e.g., `:answers:openai/gpt-5.4`).

**IMPORTANT: Tag parsing gotchas:**
- `:seed` and `:answers` are **mutually exclusive** in the tag syntax. The regex is `(:seed|:answers[:MODEL])?` — you cannot combine them.
- `[bench:dataset/variant:answers:seed]` does NOT mean "seed + answers". It parses as answers-only with `eval_model="seed"` (invalid model). This produces 0 queries answered.
- To seed AND get answer metrics, use `[bench:dataset/variant:seed]` which runs `--seed --eval-answers` (full benchmark with seeding + answer gen on all queries). This takes much longer (~3-4 hours for neural multihop-rag) but is the only way.
- To run a quick answer-only eval (no seed), use `[bench:dataset/variant:answers]`.

**IMPORTANT: Reseed requires DB clearing first:**
- `--seed` does NOT drop tables — it re-ingests via upsert with hash store deduplication.
- If you change the **triple extraction pipeline** (e.g., adding new fields to edge properties), re-seeding alone won't help — the hash store matches on content+embedding model (unchanged) and skips the doc before `extractFromChunk` fires.
- You MUST clear the hash store entries AND the graph tables first (see "Clearing Benchmark Data for Reseed" section), then reseed.
- The `concurrency: cancel-in-progress: true` setting means pushing a new commit with the same dataset/variant tag will **cancel the in-progress benchmark job**. Never push while a benchmark is running unless you intend to cancel it.

### Examples

```
feat: improve hybrid search scoring [bench:nfcorpus/core]
```

```
refactor: update embedding pipeline [bench:nfcorpus/core:seed] [bench:nfcorpus/neural:seed]
```

```
test: run all benchmarks [bench:all/all:seed]
```

```
eval: test answer gen with gpt-5.4 [bench:multihop-rag/neural:answers:openai/gpt-5.4]
```

### Reading Results

After pushing, the workflow runs and posts results as PR comments. Use the GitHub MCP tools to read them:

1. List PR comments to find benchmark results
2. Results include: nDCG@10, MAP@10, Recall@10, Precision@10, timing data
3. A consolidated summary table is posted when multiple benchmarks run together
4. If a benchmark fails, a failure comment with a link to the workflow logs is posted

### Timeouts

| Variant | Without seed | With seed | Answers only |
|---------|-------------|-----------|-------------|
| core    | 15 min      | 60 min    | 15 min      |
| neural  | 30 min      | 360 min   | 15 min      |
| core (multihop-rag) | 90 min | 120 min | 15 min |
| neural (multihop-rag) | 180 min | 360 min | 15 min |

### Workflow File

`.github/workflows/benchmarks.yml` — Locked to actors `fIa5h` and `claude` only.

## Database Queries

Query Neon directly from the sandbox using `@neondatabase/serverless`. Run queries from the `benchmarks/` directory (where the package is installed and `.env` has the connection string).

### How to Query

```bash
# From benchmarks/ directory (has @neondatabase/serverless installed)
node -e "
const { neon } = require('@neondatabase/serverless');
require('dotenv').config(); // optional — or just hardcode/export NEON_DATABASE_URL
const sql = neon(process.env.NEON_DATABASE_URL);
sql\`SELECT ...\`.then(r => console.log(JSON.stringify(r, null, 2))).catch(e => console.error(e.message));
"
```

Since `node` doesn't auto-load `.env`, either:
- Use the connection string directly in the script (it's in `benchmarks/.env`)
- Or run `export $(grep -v '^#' .env | xargs) && node -e "..."`

For longer queries, write a `.js` file in `benchmarks/` and run with `node`.

### Notes

- The CI-based `db-inspect` workflow (`db-queries/` commit pattern) is no longer needed for ad-hoc queries — use direct access instead.
- The `db-inspect` workflow still exists but is only needed if you want query results stored in the repo for historical reference.
- Tagged template literals in `@neondatabase/serverless` parameterize automatically — avoid string concatenation for values.

## Benchmark Datasets (9 datasets × 2 variants = 18 benchmarks)

| Dataset | Description | Chunk Size | Scoring |
|---------|-------------|------------|---------|
| nfcorpus | Biomedical information retrieval (BEIR) | 2048 | BEIR IR metrics |
| australian-tax-guidance-retrieval | Australian tax law documents | 2048 | BEIR IR metrics |
| contractual-clause-retrieval | Legal contract clauses | 2048 | BEIR IR metrics |
| license-tldr-retrieval | Software license summaries | 2048 | BEIR IR metrics |
| mleb-scalr | Multi-language evaluation benchmark | 2048 | BEIR IR metrics |
| legal-rag-bench | Legal RAG evaluation | 2048 | BEIR IR metrics |
| multihop-rag | Multi-hop QA over news articles (COLM 2024) | **256** | IR + word-intersection ACC |
| graphrag-bench-novel | 20 Project Gutenberg novels (arXiv:2506.05690) | **1200** | LLM-as-judge ACC |
| graphrag-bench-medical | NCCN medical guidelines (arXiv:2506.05690) | **1200** | LLM-as-judge ACC |

**CRITICAL: Chunk sizes are per-benchmark, not global.** Each benchmark's chunk size matches the methodology used by published baselines for that benchmark. Using the wrong chunk size makes results incomparable.

## Metrics

### Retrieval Metrics (all benchmarks)

All benchmarks report BEIR-standard metrics at cutoff 10:
- **nDCG@10**: Normalized Discounted Cumulative Gain
- **MAP@10**: Mean Average Precision
- **Recall@10**: Recall
- **Precision@10**: Precision
- **MRR@10**: Mean Reciprocal Rank (multihop-rag only)
- **Hit@10**: Hit rate at 10 (multihop-rag only)

### Answer-Generation Metrics

Each benchmark uses the **exact scoring methodology from its source paper**. Using the wrong scoring method makes results incomparable.

**MultiHop-RAG (COLM 2024):**
- **ACC**: Word-intersection accuracy — true if ANY word in predicted overlaps with ANY word in gold (case-insensitive). Matches `has_intersection()` in the paper's `qa_evaluate.py`.
- Top-6 chunks as context, 256-token chunks (matching paper Table 5 setup).
- Paper reports ACC=0.56 with GPT-4. Our runners use `wordIntersectionAccuracy()`.

**GraphRAG-Bench (arXiv:2506.05690):**
- **ACC**: LLM-as-judge answer correctness = 0.75 × factuality_fbeta + 0.25 × semantic_similarity.
- Factuality: LLM decomposes answer + gold into statements, classifies TP/FP/FN, computes F-beta.
- Similarity: Embedding cosine similarity between answer and gold, scaled to [0,1].
- Prompts and scoring logic copied verbatim from `GraphRAG-Bench/Evaluation/metrics/answer_accuracy.py`.
- Returns continuous 0.0-1.0 score (NOT binary). Published baselines report 0.40-0.65.

**CRITICAL: Do NOT mix scoring methods across benchmarks.** MultiHop-RAG ACC (word-intersection, binary) and GraphRAG-Bench ACC (LLM-as-judge, continuous) are completely different metrics that happen to share the name "ACC".

### Runner Flags (answer-eval benchmarks)

- `--eval-answers`: Run answer eval alongside retrieval metrics in the same loop
- `--eval-answers-limit=N`: Limit answer eval to N queries (default: 100). Use `--eval-answers-limit=20` for quick smoke tests.
- `--eval-model=MODEL`: Override the LLM for answer generation (default: `openai/gpt-5.4-mini`)
- GraphRAG-Bench runners run answer-gen eval by default (no flag needed) — it's the primary metric
- MultiHop-RAG runners require `--eval-answers` flag to include answer eval alongside IR metrics

**Architecture:** All answer-eval runners use a single unified loop: retrieve → score IR (if applicable) → generate answer → score answer. No storing results in memory across phases. No second loop.

## Development

```bash
pnpm install          # Install SDK deps
pnpm run build        # Build SDK (REQUIRED before running benchmarks locally)
cd benchmarks && npm install  # Install benchmark deps (separate npm)
```

**Always rebuild before running benchmarks locally.** The benchmark runners import SDK packages via their `dist/` output (package.json `exports` field points to `dist/`). Running against a stale build causes silent failures or wrong behavior — e.g., multi-statement DDL errors on deploy if `execStatements` split wasn't in the build.

## Secrets (configured in GitHub repo settings)

- `NEON_DATABASE_URL` — Neon Postgres connection string
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway key (embeddings + LLM)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob storage token

## Operational Knowledge

Hard-won learnings from debugging the benchmark pipeline. Read this before running benchmarks or DB queries.

### Unified Eval Loop Architecture

All benchmark runners that support answer eval use a **single unified loop**. There is NO separate "answer-only mode" code path — just one loop with conditional behavior based on flags.

```
for each query:
  results = d.query(queryText, { mode, count: 50 })
  if (computeIR)      → accumulate IR metrics (nDCG, MAP, etc.)
  if (computeAnswers) → generate answer from top-6 chunks, score vs gold
```

**Key principles:**
- **One loop, not two.** Never store thousands of query results in memory to iterate over them later.
- **Flags control behavior, not code paths.** `--eval-answers` adds answer scoring to the existing loop. No separate `--eval-answers-only` mode needed.
- **Default limit = 100** for answer eval queries. Override with `--eval-answers-limit=N`.
- **Per-query error handling**: LLM failures caught per-query, loop continues.
- **GraphRAG-Bench runs answer eval by default** (it's an answer-gen benchmark with no meaningful qrels). MultiHop-RAG requires `--eval-answers` flag.

### Database Table Naming

Chunk tables use the full embedding model path, not a numeric ID:
- Chunks: `{prefix}_gateway_openai_text_embedding_3_small`
- Registry: `{prefix}_registry`
- Shared across all benchmarks: `d8um_documents`, `d8um_hashes`, `d8um_buckets`

Example table prefixes per benchmark runner:
- `bench_license_core_` → `bench_license_core__gateway_openai_text_embedding_3_small`
- `bench_legalrag_core_` → `bench_legalrag_core__gateway_openai_text_embedding_3_small`

### Core vs Neural Variant Isolation

Core and neural variants are fully isolated — no DB cleanup needed between them:
- Separate table prefixes: `bench_license_core_*` vs `bench_license_neural_*`
- Separate buckets: `license-tldr` vs `license-tldr-neural`
- Neural adds graph tables: `*_memories`, `*_entities`, `*_edges`

### Seeding Behavior

**`--seed` does NOT drop or recreate tables.** It re-ingests via upsert.

- Hash store (`deduplicateBy: ['content']`) creates entries keyed by SHA256 of content
- On re-seed, hash store check skips docs where content + embedding model haven't changed
- `ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE` prevents row duplication at DB level
- Interrupted seeds resume correctly — completed docs have hash entries and get skipped on retry

**Metadata propagation caveat:** If data was seeded WITHOUT `propagateMetadata: ['metadata.corpusId']`, re-seeding won't fix it — the hash store matches on content+model (unchanged) and skips the doc before the upsert fires. To fix: clear hash entries for that bucket, or force re-ingestion.

### DB Query Notes

- Use direct Neon access (see "Database Queries" section) for all ad-hoc inspection.
- The `db-inspect` CI workflow is obsolete for ad-hoc queries. The `db-queries/` folder may have historical results — ignore them.
- **`[skip ci]`** is still relevant for benchmark commits but no longer affects DB query access.

### Benchmark CI Notes

- Concurrency groups prevent the same dataset/variant from running in parallel
- History commit step uses fetch/reset/re-apply pattern (not rebase) for concurrent push safety
- `contents: write` permission is required for both PR comments and history commits
- Build is scoped: `pnpm turbo run build --filter=@d8um/adapter-pgvector --filter=@d8um/graph` (includes `@d8um/core` as transitive dependency)

### Corpus Sizes

For estimating seed times (~3 docs/s embedding throughput):

| Dataset | Corpus | Queries | Est. Seed Time |
|---------|--------|---------|----------------|
| license-tldr-retrieval | 65 | 65 | ~30s |
| contractual-clause-retrieval | ~90 | ~90 | ~30s |
| australian-tax-guidance-retrieval | ~105 | ~112 | ~35s |
| nfcorpus | ~3,633 | ~323 | ~20min |
| legal-rag-bench | 4,876 | 100 | ~27min |
| mleb-scalr | 523 | 120 | ~3min |
| multihop-rag | 609 | ~2,556 | ~3min |

### Baselines & History Files

**Baselines** (`benchmarks/{dataset}/baselines.json`):
- Each entry has: `system`, `metrics`, `source`, `year`, `metric_note`
- Sources: MLEB Leaderboard (isaacus) for legal/tax datasets, MTEB/BEIR for nfcorpus, paper tables for multihop-rag
- Compared in PR comments; `metric_note` clarifies what's being compared (e.g., "Hit@10 not nDCG@10")

**History files** (`benchmarks/{dataset}/{variant}/history-{mode}.json`):
- Mode-specific: `history-hybrid.json`, `history-fast.json`, `history-neural.json`
- Legacy `history.json` files still exist for backwards compatibility (CI fallback reads them)
- All entries now have `timing` objects (older entries backfilled with `ingestionSeconds: null`)
- `--record` flag appends locally; CI auto-commits on PR benchmark runs
- Entry format: `{ commit, date, metrics, avgQueryMs, timing, mode, config }`

### Clearing Benchmark Data for Reseed

**When to clear:** Before reseeding a benchmark with changed chunk size, embedding model, ingestion config, **or triple extraction pipeline changes** (e.g., adding new fields to edge properties). The hash store matches on content+embedding model — if those haven't changed, the doc is skipped before `extractFromChunk` fires, so new edge property fields won't be populated.

**Important:** `--seed` does NOT drop tables. You must manually clear data via a db-query, then reseed.

#### Tables to clear per variant

**Core variant** (e.g., `bench_license_core_`):
```sql
TRUNCATE TABLE {prefix}_gateway_openai_text_embedding_3_small;
TRUNCATE TABLE {prefix}_registry;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
```

**Neural variant** (e.g., `bench_license_neural_`) — same as core PLUS graph tables:
```sql
TRUNCATE TABLE {prefix}_gateway_openai_text_embedding_3_small;
TRUNCATE TABLE {prefix}_registry;
TRUNCATE TABLE {prefix}memories;
TRUNCATE TABLE {prefix}entities;
TRUNCATE TABLE {prefix}edges;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = '{bucket_name}');
```

Note: neural graph tables use `{prefix}memories` (no extra underscore), e.g. `bench_license_neural_memories`.

#### Complete prefix/bucket reference

| Dataset | Variant | TABLE_PREFIX | BUCKET_NAME |
|---------|---------|--------------|-------------|
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

#### Current DB State (as of 2026-03-31)

| Dataset | Variant | Chunks | Docs | Hashes | Graph (entities/edges) | Status |
|---------|---------|--------|------|--------|------------------------|--------|
| au-tax | core | 0 | 0 | 0 | — | Cleared — needs reseed |
| au-tax | neural | 0 | 0 | 0 | 0 / 0 | Cleared — needs reseed |
| license-tldr | core | 0 | 0 | 0 | — | Cleared — needs reseed |
| license-tldr | neural | 124 | 65 | 65 | 233 / 391 | Seeded ✓ |
| mleb-scalr | core | 523 | 523 | 523 | — | Seeded ✓ |
| mleb-scalr | neural | 523 | 523 | 523 | 1963 / 1492 | Seeded ✓ |
| multihop-rag | core | 1054 | 609 | 609 | — | Seeded ✓ |
| multihop-rag | neural | 0 | 0 | 0 | 0 / 0 | Cleared (bad reseed d251f11) — needs reseed |
| legal-rag-bench | core | 0 | 4859 | 4859 | — | **Docs/hashes present but chunks missing** — chunk table was truncated without clearing hashes; reseed will skip all docs |
| nfcorpus | core | 947 | 823 | 822 | — | Seeded but never benchmarked |

**legal-rag-bench anomaly:** `d8um_documents` and `d8um_hashes` have 4859 entries, but `bench_legalrag_core__gateway_openai_text_embedding_3_small` is empty. The chunk table was truncated without clearing hashes/documents. Before reseeding: clear hashes and documents for `legal-rag-bench` bucket, then the seed will re-ingest.

#### Reseed Procedure (MUST follow in order)

**CRITICAL: DB wipes and reseeds require explicit user approval. NEVER auto-clear. ALWAYS validate on small data before full runs.**

1. **Get explicit user approval** for which dataset/variant to clear and reseed
2. **Run clear SQL** directly against Neon (see "Database Queries" section)
3. **VERIFY immediately**: `DELETE` row counts must be >0 for hashes/documents. If 0 → hash store NOT cleared → seed will skip everything → **DO NOT PROCEED**
4. **Run `--validate` first** to confirm the pipeline works on 5 docs/queries
5. **Only then run `--seed`** for the full dataset (or push `[bench:dataset/variant:seed]` for CI)
6. **Do NOT push other commits while a seed is running** — cancels the job

**Common mistakes that waste compute:**
- Pushing `[bench:dataset/variant:answers:seed]` — this does NOT seed. It runs answer-only with `eval_model="seed"` (invalid).
- Pushing `[bench:dataset/variant:seed]` without clearing the DB first — hash store skips all docs, triple extraction never runs, edge properties unchanged.
- Pushing a new commit while a seed is running — cancels the seed job.
- Not verifying `DELETE N > 0` in the clear result — hash entries remain, seed skips everything.

### Benchmark Results Readout

When asked for a readout on benchmark results, pull data from the **history files in the repo**, not from PR comments or commit messages.

#### Where results live

- **History files**: `benchmarks/{dataset}/{variant}/history-{mode}.json` (e.g., `history-hybrid.json`, `history-fast.json`, `history-neural.json`)
- **Legacy history**: `benchmarks/{dataset}/{variant}/history.json` (pre-dual-mode runs)
- **Baselines**: `benchmarks/{dataset}/baselines.json`

#### How to produce a readout

1. Read all `history-*.json` files for each dataset/variant that has been run
2. Read each dataset's `baselines.json` for the external comparison targets
3. Present a table per dataset showing: commit, mode, chunk size, nDCG@10, MAP@10, Recall@10, Precision@10, avg query ms, ingest time (if available), delta vs text-embedding-3-small baseline
4. Timing data is available in entries from 2026-03-29 onward (the `timing` object); older entries only have root-level `avgQueryMs`
5. Highlight the best result per dataset and whether it beats baseline
6. Call out notable patterns (e.g., fast > hybrid, neural = core, chunk ratio issues)

**Do NOT rely on PR comments** — they may be paginated, unavailable, or stale. The history JSON files are the source of truth for all benchmark results.

### Neural Ingestion Performance

Neural ingestion is much slower than core due to 2 LLM calls per chunk (entity extraction + relationship extraction) plus embedding calls for entity resolution.

**Concurrency:** The `concurrency` option in `IndexOpts` controls parallel document processing during ingest. Neural runners use `concurrency: 5` (default: 1 sequential). Higher values give proportional speedup but increase API rate limit risk and memory pressure.

**Extraction timeout:** All `extractFromChunk` calls are wrapped with a 120-second timeout (`withTimeout` in engine.ts). If an LLM call hangs, the extraction is abandoned and the document continues without triples.

**Memory:** Neural seed on large datasets (600+ docs) requires `NODE_OPTIONS="--max-old-space-size=4096"` — set in the workflow. Default Node.js heap (~1.7GB) causes silent OOM kills on GitHub Actions runners.

**Estimated neural seed times** (with concurrency=5):

| Dataset | Corpus | Est. Neural Seed Time |
|---------|--------|-----------------------|
| license-tldr-retrieval | 65 | ~96s |
| multihop-rag | 609 | ~33min |
| nfcorpus | ~3,633 | ~3-4h (untested) |

### Inspecting Graph Health

After seeding a neural benchmark, run a DB analysis query to verify graph quality. This catches regressions in entity resolution, embedding coverage, and edge quality.

**Standard inspection query template:**
```sql
-- 1. Entity count + embedding coverage (target: 100%)
SELECT COUNT(*) AS total, COUNT(embedding) AS with_embedding,
  ROUND(COUNT(embedding)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS pct
FROM {prefix}entities;

-- 2. Edge distribution (CO_OCCURS should be 0 or near-0)
SELECT relation, COUNT(*) FROM {prefix}edges GROUP BY relation ORDER BY COUNT(*) DESC LIMIT 20;

-- 3. HNSW index (must exist for fast entity search)
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = '{prefix}entities' AND indexname LIKE '%embedding%';

-- 4. Entity duplicates (case-insensitive, target: <10 pairs)
SELECT LOWER(name), COUNT(*) FROM {prefix}entities
GROUP BY LOWER(name) HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 20;

-- 5. Entity type distribution
SELECT entity_type, COUNT(*) FROM {prefix}entities GROUP BY entity_type ORDER BY COUNT(*) DESC;
```

**Healthy graph indicators:**
- Embedding coverage: 100%
- CO_OCCURS edges: 0 (all entities have direct relationship edges)
- HNSW index: present with `vector_cosine_ops`, m=16, ef_construction=200
- Entity duplicates: <10 pairs (minor duplicates from concurrent processing are acceptable)
- Diverse predicates: 15+ distinct relation types, no single predicate >20% of edges
- Edges per entity: 1.0–3.0 (sparse, informative graph)

**Known issues to watch for:**
- CO_OCCURS explosion: If >100 CO_OCCURS edges, the disconnected-entity guard in graph-bridge.ts may have regressed
- Embedding loss: If coverage <100%, check COALESCE in `upsertEntity` ON CONFLICT clause
- HNSW failure: Neon pgvector 0.8.0 requires typed `VECTOR(dims)` columns — check `ensureHnswIndex()` in pgvector adapter
- Entity duplicates: Concurrent processing can race past the in-memory cache — acceptable at <5% rate

### Neon Postgres Compatibility

- Cannot use expressions (e.g. `COALESCE`) in `PRIMARY KEY` constraints — use `DEFAULT ''` instead
- Cannot execute multi-statement prepared statements — split DDL on semicolons and execute individually
- `SET LOCAL` requires explicit transaction wrapping

## Changelog & Milestones

### 2026-03-28 — Beat text-embedding-3-small baseline (PR #7)

**Problem:** d8um scored significantly below the MLEB text-embedding-3-small baseline despite using the same embedding model. Australian-tax nDCG@10 was 0.6723 vs baseline 0.7431 (-0.0708).

**Root cause:** Chunk-level retrieval wasted ranking slots — multiple chunks from the same document consumed top-K positions, while the baseline embedded full documents as single vectors.

#### Changes made

1. **SDK over-fetch + document-level aggregation** (`packages/core/src/query/runners/indexed.ts`)
   - IndexedRunner now fetches `count * 3` chunks from the adapter
   - Deduplicates to best-scoring chunk per `documentId` before returning
   - Eliminates slot waste from multiple chunks of the same document

2. **4x chunk size increase** (all 12 benchmark runners)
   - `CHUNK_SIZE`: 512 → 2048, `CHUNK_OVERLAP`: 64 → 256
   - Fewer chunks per document = less slot waste + better embedding context

3. **Benchmark-level over-fetch + deduplication** (`benchmarks/lib/metrics.ts`)
   - `QUERY_FETCH = K * 5 = 50` chunks requested per query
   - `deduplicateToDocuments()` picks top K=10 unique corpus IDs
   - Combined with SDK 3x: 150 chunks → 50 docs → 10 evaluated

4. **Dual-mode benchmark runners** (all 6 core runners + workflow)
   - Core benchmarks run both `hybrid` and `fast` (pure vector) side by side
   - Emit JSON array of results; mode-specific history files (`history-hybrid.json`, `history-fast.json`)

5. **Neural pipeline fixes** (earlier in PR #7)
   - `await Promise.allSettled()` for triple extraction in `engine.ts` (was fire-and-forget)
   - Neon DDL splitting in `packages/graph/src/adapters/pgvector.ts` for graph table creation
   - Fixed hash cleanup to use correct bucket ID (UUID, not name)

#### Results (nDCG@10)

| Dataset | Mode | Before | After (+ reseed 2048) | Baseline | Delta vs baseline |
|---------|------|--------|----------------------|----------|-------------------|
| australian-tax | hybrid | 0.6723 | **0.7519** | 0.7431 | **+0.0088** |
| australian-tax | fast | 0.6723 | **0.7505** | 0.7431 | **+0.0074** |
| license-tldr | hybrid | 0.5970 | **0.6485** | 0.5985 | **+0.0500** |
| license-tldr | fast | 0.5970 | **0.6485** | 0.5985 | **+0.0500** |
| license-tldr | neural | 0.5970 | **0.6485** | 0.5985 | **+0.0500** |
| legal-rag-bench | hybrid | 0.2933 | **0.3150** | 0.3704 | -0.0554 |
| legal-rag-bench | fast | 0.2893 | **0.3348** | 0.3704 | -0.0356 |

3 of 4 benchmarks reseeded now beat text-embedding-3-small baseline. Legal-rag-bench (4,876 docs) is closing the gap but not yet there — fast mode outperforms hybrid on this dataset.

#### Key learning

The MLEB baselines embed entire documents as single vectors. A chunked retrieval system must compensate by over-fetching and aggregating at the document level, otherwise chunk-level noise destroys ranking quality. The combination of SDK-level dedup (3x over-fetch) + benchmark-level dedup (5x over-fetch) + larger chunks (4x) closed the gap.

For legal-rag-bench specifically, fast (pure vector) outperforms hybrid (vector + BM25 RRF). This suggests BM25 may hurt on long legal documents where keyword matching adds noise. The gap to baseline (0.3348 vs 0.3704) may require further tuning of RRF weights or larger over-fetch multipliers.

### 2026-03-29 — Neural graph pipeline production-ready (PR #10)

**Goal:** Make `neural` mode (hybrid + PPR graph traversal) outperform `core` mode by fixing graph quality issues and making the pipeline fast enough to run on real datasets.

**Root causes found via graph inspection:** After initial neural seeding, DB analysis revealed 4 critical issues destroying graph quality:

1. **CO_OCCURS explosion** (22,021 edges vs 371 explicit): O(N²) combinatorial pairing per chunk
2. **Embedding loss** (45.9% coverage): `mapRowToEntity` returns `embedding: undefined` → merge spreads it → `upsertEntity` overwrites with NULL
3. **HNSW index failure**: Neon pgvector 0.8.0 requires typed `VECTOR(dims)` columns, not untyped `VECTOR`
4. **Entity duplicates** (15 pairs): `findEntities` ILIKE with LIMIT 10 misses exact matches when many partial matches exist

#### Changes made

1. **CO_OCCURS guard** (`packages/graph/src/graph-bridge.ts`)
   - Only creates CO_OCCURS edges for entities with NO direct relationship edges (disconnected)
   - Max 1 CO_OCCURS per entity per chunk
   - Result: 0 CO_OCCURS edges (all entities had direct edges)

2. **Embedding COALESCE** (`packages/graph/src/adapters/pgvector.ts`)
   - `ON CONFLICT SET embedding = COALESCE(EXCLUDED.embedding, table.embedding)`
   - Preserves existing embeddings when merge spreads `undefined` from mapRowToEntity
   - Result: 100% embedding coverage

3. **HNSW index creation** (`packages/graph/src/adapters/pgvector.ts`)
   - `ensureHnswIndex()` first ALTERs column to `vector(dims)` then creates index
   - Catches "already typed" error gracefully
   - Passes `embeddingDimensions` config through adapter → all 7 neural runners updated

4. **In-memory entity cache** (`packages/graph/src/extraction/entity-resolver.ts`)
   - Phase 0: `nameCache` (Map<string, SemanticEntity>) checked before all DB lookups
   - `cacheEntity()` indexes by normalized name + all aliases
   - Result: 15 → 8 duplicate pairs (remaining from concurrent processing races)

5. **Eliminate redundant embedding calls** (`packages/graph/src/extraction/entity-resolver.ts`, `adapters/pgvector.ts`)
   - Entity resolver Phase 3: use pgvector's `_similarity` score from `searchEntities` instead of re-embedding each candidate (saves 2-6 `embed()` calls per entity)
   - Reuse Phase 3 embedding for new entity creation (saves 1 call)
   - `mapRowToEntity` stashes `row.similarity` as `properties._similarity`
   - Predicate normalizer: cache resolved predicates by normalized text

6. **Concurrent document processing** (`packages/core/src/index-engine/engine.ts`, `types/index-types.ts`)
   - New `concurrency` option in `IndexOpts` — semaphore-based parallel doc processing
   - Both `indexWithConnector` and `ingestBatch` paths support concurrency
   - Safe error handling: `.catch()` wrapper prevents unhandled promise rejections from crashing Node.js
   - All 7 neural runners set `concurrency: 5`

7. **Extraction timeout** (`packages/core/src/index-engine/engine.ts`)
   - `withTimeout(extractFromChunk(...), 120_000)` — 2-minute timeout per chunk
   - Prevents hung LLM calls from blocking entire batches
   - On timeout, extraction is abandoned; document still stored with chunks, just without triples

8. **4GB heap for CI** (`.github/workflows/benchmarks.yml`)
   - `NODE_OPTIONS="--max-old-space-size=4096"` prevents OOM kills on GitHub Actions
   - Default ~1.7GB heap insufficient for 600+ doc neural ingestion

#### Results — multihop-rag (609 docs, 2255 queries)

| Mode | nDCG@10 | MAP@10 | Recall@10 | MRR@10 | Hit@10 | Avg Query |
|------|---------|--------|-----------|--------|--------|-----------|
| **neural** | 0.6427 | 0.5143 | 0.7883 | 0.7028 | 0.9805 | 3984ms |
| hybrid (core) | 0.6429 | 0.5146 | 0.7884 | 0.7029 | 0.9805 | 634ms |
| fast (core) | **0.6459** | **0.5180** | **0.7914** | **0.7055** | **0.9814** | 708ms |

Neural matches core quality (delta <0.001) but queries are 6x slower due to PPR graph traversal overhead. The graph does not yet provide retrieval quality lift on this dataset.

#### Performance improvements

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Neural ingest (license-tldr, 65 docs) | 401.4s | 95.6s | **4.2x faster** |
| Neural ingest (multihop-rag, 609 docs) | ~29h est. | 33min | **~53x faster** |
| Neural query (multihop-rag) | 7942ms | 3984ms | **2x faster** |
| Embedding calls per entity | 3-7 | 1 | **3-7x fewer** |

#### Key learnings

- **Graph inspection is essential after seeding.** The standard DB analysis query (entities + edges + HNSW + duplicates) catches quality regressions immediately. Without it, you run benchmarks on a broken graph and waste hours.
- **OOM is silent on GitHub Actions.** Node.js default heap (~1.7GB) is insufficient for neural ingestion of 600+ docs. The process is killed with SIGKILL — no error handlers fire, no stack trace. Always set `--max-old-space-size=4096`.
- **Concurrent processing needs error safety.** `Promise.race` in a semaphore loop leaves orphaned promises on failure. Those must be wrapped with `.catch()` or Node.js crashes on `unhandledRejection`.
- **pgvector similarity scores eliminate re-embedding.** `searchEntities` already computes cosine similarity — stash it on the entity properties instead of re-embedding each candidate name.
- **Neural ≈ core on multihop-rag.** The PPR graph traversal adds latency without improving ranking. This dataset may not benefit from entity-level graph traversal because the queries are answerable from keyword/vector similarity alone. Datasets requiring cross-document entity reasoning (e.g., "which companies were involved in both X and Y?") are more likely to show neural > core.

### 2026-03-30 — Predicate synonym merging + answer-gen evaluation (PR #12)

**Goals:**
1. Reduce graph noise by merging synonym predicates (WORKS_FOR/EMPLOYED_BY) while preserving tense distinctions (PLAYS_FOR vs PLAYED_FOR)
2. Add competitive answer-generation evaluation for MultiHop-RAG to compare against the paper's GPT-4 results
3. Add `--eval-answers-only` mode for fast answer-gen iteration without re-running all 2255 retrieval queries

#### Changes made

1. **Predicate synonym merging** (`packages/graph/src/extraction/predicate-normalizer.ts`)
   - Static synonym groups (O(1) lookup): WORKS_FOR/EMPLOYED_BY/WORKS_AT, LOCATED_IN/BASED_IN/HEADQUARTERED_IN, etc.
   - Tense guard: prevents cross-tense merging (PLAYS_FOR stays separate from PLAYED_FOR)
   - Flow: exact match → static synonym → resolved cache → embedding fallback with tense guard → new canonical
   - Supports custom `extraSynonyms` for domain-specific overrides
   - Tests: `packages/graph/src/__tests__/predicate-normalizer.test.ts` (15 tests)

2. **Answer-generation evaluation** (`benchmarks/lib/metrics.ts`, both multihop-rag runners)
   - `substringAccuracy(predicted, gold)`: paper-comparable metric (gold substring in predicted)
   - `exactMatch(predicted, gold)`: strict equality after normalization
   - `tokenF1(predicted, gold)`: token-level F1 score
   - Context: top-6 chunks from `response.results[].content` (matches paper's methodology)
   - Non-fatal: wrapped in try/catch, benchmark continues if answers.json missing

3. **Answer-only benchmark mode** (both runners + workflow)
   - `--eval-answers-only`: queries only the gold-answer subset, skips full IR metrics
   - `--eval-model=MODEL`: override LLM for answer generation
   - Workflow tag: `[bench:dataset/variant:answers]` or `[bench:dataset/variant:answers:model/name]`
   - 30-minute timeout (vs 90-180min for full benchmarks)

4. **Gold answers pipeline**
   - `benchmarks/scripts/seed-multihop-answers.ts`: extracts answers from HuggingFace MultiHopRAG parquet
   - `.github/workflows/seed-answers.yml`: workflow_dispatch to upload answers.json to Vercel Blob
   - `benchmarks/lib/datasets.ts`: `loadAnswers()` function for loading gold answers

#### Results — multihop-rag (latest runs)

| Mode | nDCG@10 | MAP@10 | Recall@10 | MRR@10 | Hit@10 | EM | F1 | Avg Query |
|------|---------|--------|-----------|--------|--------|------|------|-----------|
| neural (256ca83) | 0.6431 | 0.5148 | 0.7884 | 0.7034 | 0.9805 | 0.19 | 0.27 | 2148ms |
| hybrid (9da3bca) | 0.6429 | 0.5146 | 0.7884 | 0.7030 | 0.9805 | 0.18 | 0.26 | 306ms |
| fast (9da3bca) | **0.6459** | **0.5180** | **0.7914** | **0.7055** | **0.9814** | 0.17 | 0.25 | 375ms |

**Note:** EM/F1 above used old methodology (10 full articles as context, exact match only, Gemini Flash Lite). The `--eval-answers-only` mode with `substringAccuracy` (ACC) and top-6 chunks context is now available but hasn't been run yet with the corrected methodology.

#### Predicate synonym impact on neural

| Metric | Before (01d8689) | After (256ca83) | Delta |
|--------|-------------------|------------------|-------|
| nDCG@10 | 0.6427 | 0.6431 | +0.0004 |
| Ingest time | 1989s | 1636s | **-18%** |
| Avg query | 3984ms | 2148ms | **-46%** |

Predicate merging reduced graph noise (fewer redundant edge types), which improved both ingestion speed and query performance without sacrificing retrieval quality.

#### Key learnings

- **Retrieval metrics alone are insufficient for multi-hop RAG.** The MultiHop-RAG paper (COLM 2024) and HippoRAG (NeurIPS 2024) both evaluate with answer-generation metrics (EM, F1, ACC). High Hit@10 (0.98) doesn't mean the system can answer multi-hop questions.
- **Methodology matters enormously for answer-gen comparison.** The paper uses substring match (ACC), not exact match (EM). It passes top-6 chunks (~2048 tokens), not full articles. Using the wrong metric or context size makes results incomparable. Our EM=0.19 vs paper's GPT-4 ACC=0.56 is apples-to-oranges.
- **Predicate synonym merging is a cheap win.** Static synonym groups + tense guard gave -18% ingest time, -46% query latency, and +0.0004 nDCG with zero risk. The tense guard is important for temporal reasoning datasets.
- **Answer-only mode is essential for iteration.** Running all 2255 retrieval queries (90-180min) just to test a different answer-gen model is wasteful. `--eval-answers-only` uses a single-loop architecture (retrieve → generate → score per query) with a default limit of 100 queries, completing in ~5-15 min.
- **Gold answers require a separate seeding pipeline.** MultiHopRAG HuggingFace data has answers in the queries parquet, but they need separate extraction and upload to Vercel Blob as `answers.json`.

### 2026-03-30 — Neural graph PPR signal is actively harmful (PR #14)

**Finding:** On the MultiHop-RAG answer-generation eval (100 queries, ACC metric), neural mode scores identically to core mode (ACC=0.72). Boosting the graph RRF weight from 0.3 to 0.7 **destroyed** performance: ACC dropped from 0.72 to 0.45, EM from 0.12 to 0.03.

**Root cause:** PPR ranks chunks by entity centrality (hub bias), not query relevance. High-degree hub entities (OpenAI=125 edges, Manchester United=120, Google=111) always get high PPR scores, pulling in popular-but-irrelevant context. The graph stores only 1,050 unique chunks — the same pool indexed search draws from. It cannot surface new content, only re-rank existing chunks, and its ranking signal is worse than vector similarity.

**Graph health is fine** (confirmed via DB diagnostic):
- Entity types: diverse (person=50.6%, org=22.5%, product=17.1%)
- 37% of entities have aliases, HNSW index present, 100% embedding coverage
- 1,589 predicates (normalized), 0 CO_OCCURS, no isolated nodes
- PPR 2-hop reachability: 4.1% of graph from 10 seeds

**The issue is architectural, not data quality:**

| Experiment | ACC | EM | F1 |
|-----------|-----|----|----|
| Core (hybrid, graph=0) | 0.72 | 0.12 | 0.23 |
| Neural (graph=0.3 default) | 0.72 | 0.12 | 0.23 |
| Neural (graph=0.7 boosted) | **0.45** | **0.03** | **0.11** |

**What needs to change for neural to beat core:**
1. **Query-aware chunk re-ranking** — re-score graph chunks by embedding similarity to query, not entity centrality (`graph-bridge.ts:getChunksForEntities`)
2. **Increase graph connectivity** — 1.64 edges/entity is too sparse for meaningful multi-hop traversal; need stronger extraction LLM or more triples per chunk
3. **Keyword-based entity seeding** — seed PPR from entities mentioned by name in the query, not just embedding similarity (which is redundant with indexed search)

### 2026-03-31 — Methodology alignment + GraphRAG-Bench + neural showing promise

**Critical finding:** Our benchmark scoring was completely wrong for both datasets:

1. **GraphRAG-Bench**: We used binary substring match (ACC=0.05-0.08). Paper uses LLM-as-judge (0.75×factuality_fbeta + 0.25×semantic_similarity), producing continuous 0.0-1.0 scores. After fixing: ACC=0.55-0.57, within range of published baselines (0.40-0.65).

2. **MultiHop-RAG**: We used `normalize(gold) in normalize(predicted)`. Paper uses word-intersection (`has_intersection()` in qa_evaluate.py) — true if ANY word overlaps. Our method was stricter, producing lower ACC.

3. **MultiHop-RAG chunk size**: We used 2048 tokens. Paper uses 256 tokens. 53% of documents fit in a single 2048-token chunk, making the graph store 1 chunk per document.

**Lesson: ALWAYS read the paper's actual evaluation code before implementing metrics. Same metric name ≠ same metric.**

#### Changes made

1. **GraphRAG-Bench onboarding** — seed script, 4 configs (novel/medical × core/neural), baselines from paper, 1200-token chunks (matching benchmark standard)
2. **LLM-as-judge scoring** (`benchmarks/lib/metrics.ts`) — `answerCorrectness()` exactly replicating `GraphRAG-Bench/Evaluation/metrics/answer_accuracy.py`
3. **Word-intersection ACC** (`benchmarks/lib/metrics.ts`) — `wordIntersectionAccuracy()` matching MultiHop-RAG `qa_evaluate.py`
4. **Controlled predicate vocabulary** — extraction prompt constrains predicates to ~50 canonical types, eliminating compound junk (1,605 → 112 predicates, 41x denser)
5. **Predicate normalizer expanded** — ~20 → ~120 synonym entries
6. **LLM upgrade** — Gemini Flash Lite → openai/gpt-5.4-mini for extraction + answer gen
7. **providerOptions support** — LLMProvider interface accepts provider-specific options (e.g., reasoningEffort)
8. **Single-loop eval architecture** — all answer-eval runners use one loop (retrieve → IR → answer → score), no storing results in memory
9. **SDK perf fixes** — pgvector `SELECT *` → explicit columns (-31% fast mode), skip `SET LOCAL` without transaction (-20%), latency profiling in all runners
10. **MultiHop-RAG chunk size** — config set to 256 tokens (requires reseed to take effect)

#### Results — GraphRAG-Bench Novel (100 queries, LLM-as-judge ACC)

| Mode | ACC | Avg Query | Delta vs Core |
|------|-----|-----------|---------------|
| **neural** | **0.570** | 7,663ms | **+2.3%** |
| hybrid | 0.557 | 5,433ms | baseline |
| fast | 0.549 | 5,289ms | -1.4% |

**First time neural outperforms core.** The graph provides a measurable quality lift with proper evaluation methodology. The reinforcement-only filter is still active (discarding novel graph results), so the true potential is higher.

#### Graph health (novel corpus, post-fix)

| Metric | Before fix | After fix |
|--------|-----------|-----------|
| Distinct predicates | 1,605 | 112 |
| Edges/predicate | 2.2 | 89.7 |
| Entities | 2,086 | 5,680 |
| Edges | 3,586 | 10,042 |
| Embedding coverage | 100% | 100% |
| CO_OCCURS | 0 | 0 |

### 2026-03-31 — Graph density experiments: more edges ≠ better signal (graphrag-bench-novel)

**Problem:** Graph had 1.77 edges/entity (5,680 entities, 10,042 edges across 1,147 chunks). Published graph-RAG systems report 5+. Sparse graph limits PPR traversal — most entities appear in 1-2 chunks with 1-2 relationships.

**Experiment 1: Increase extraction yield + lower entity threshold + unblock predicates**

Changes applied:
1. **Few-shot example** in relationship extraction prompt (11 relationships from 7 entities in a literary passage) — calibrates LLM to extract more relationships per chunk
2. **Softened extraction threshold** — "explicitly stated or strongly implied" → "stated, implied, or reasonably inferable"
3. **Lowered entity similarity threshold** (0.78 → 0.72) — more aggressive entity merging to reduce entity count
4. **Unblocked ASSOCIATED_WITH, CONTAINS, INCLUDES** from GENERIC_PREDICATES filter

Results after full reseed (1,147 docs, 3,516s):

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Entities | 5,680 | 6,264 | +10% (worse — more entities) |
| Edges | 10,042 | 15,117 | +51% |
| Edges/entity | 1.77 | 2.41 | +36% |
| Distinct predicates | 112 | 125 | +12% |
| MENTIONED edges | — | 4,497 (30%) | dominant noisy predicate |
| ASSOCIATED_WITH edges | 0 (filtered) | 2,496 (16%) | second-noisiest |
| ACC (100 queries) | 0.570 | 0.575 | +0.005 (marginal) |

**Key finding: More edges without better signal quality produces marginal gains.** MENTIONED (30%) and ASSOCIATED_WITH (16%) together accounted for 46% of all edges — these are low-information predicates that dilute the graph's ranking signal. The few-shot example successfully increased extraction yield (~6.7 → ~10+ rels/chunk) but the softened threshold caused the LLM to fall back on vague predicates for uncertain relationships.

Entity count *increased* despite lowering the similarity threshold (0.78 → 0.72). The few-shot example extracts more entities per chunk, which outweighs more aggressive merging.

**Experiment 2: Filter noise + tighten extraction + lower threshold further (pending reseed)**

Changes applied on top of Experiment 1:
1. **Added MENTIONED and ASSOCIATED_WITH to GENERIC_PREDICATES filter** — these are high-volume but low-signal
2. **Removed MENTIONED and ASSOCIATED_WITH from controlled vocabulary** — prevents LLM from extracting predicates that will be filtered
3. **Tightened extraction language back** — "stated, implied, or reasonably inferable" → "explicitly stated or strongly implied" (restoring original strictness)
4. **Lowered entity threshold further** (0.72 → 0.68)
5. **Kept few-shot example** — still useful for calibrating extraction count, just with tighter quality bar

Rationale: The few-shot example sets the *quantity* anchor (10+ rels/chunk) while the tightened rules and filtered predicates control *quality*. This should produce a similar edge count but with higher-signal predicates.

**Status:** Code changes applied and built. Requires DB clear + reseed to measure impact.

#### Key learnings

- **Graph density (edges/entity) is necessary but not sufficient.** Going from 1.77 → 2.41 edges/entity produced only +0.005 ACC because the new edges were dominated by MENTIONED (30%) and ASSOCIATED_WITH (16%) — vague predicates that don't carry relationship semantics.
- **Few-shot examples are powerful but need guardrails.** The example successfully increased extraction yield ~50%, but with a softened extraction threshold, the LLM used vague predicates as a "catch-all" for uncertain relationships. Keep the few-shot for quantity calibration, but pair it with strict rules.
- **Entity similarity threshold direction:** Lower threshold = more merging (easier to match). The code does `if (similarity >= threshold)`, so lowering from 0.78 → 0.72 means entities with lower cosine similarity get merged. However, if extraction simultaneously produces more entities per chunk, the net entity count can still increase.
- **Predicate vocabulary must match the filter.** Having MENTIONED/ASSOCIATED_WITH in the extraction vocabulary but filtered in graph-bridge.ts wastes LLM extraction effort and creates a confusing inconsistency. Keep vocabulary and filter aligned.
- **GENERIC_PREDICATES filter is critical for graph signal quality.** The original filter (IS, IS_A, HAS, RELATED_TO) was too permissive — MENTIONED and ASSOCIATED_WITH should have been included from the start. These predicates tell you entities co-occur in text but not *how* they relate, which is exactly what CO_OCCURS edges already capture.

#### Current entity resolver threshold

Default similarity threshold is **0.68** (lowered from original 0.78). This affects all consumers of EntityResolver unless overridden via `similarityThreshold` config. Monitor for over-merging on datasets with ambiguous entity names (e.g., "Paris" city vs "Paris" person).

### Benchmark Methodology Alignment (CRITICAL)

**Each benchmark MUST use the exact scientific methodology from its source paper.** This includes:

| Parameter | Per-benchmark, NOT global |
|-----------|--------------------------|
| Chunk size | 256 (MultiHop-RAG), 1200 (GraphRAG-Bench), 2048 (BEIR/MLEB) |
| Scoring method | Word-intersection (MultiHop-RAG), LLM-as-judge (GraphRAG-Bench), BEIR IR (others) |
| Context for answer gen | Top-6 chunks (both MultiHop-RAG and GraphRAG-Bench) |
| Null query handling | Excluded in seed script (MultiHop-RAG) |

**Mistakes that waste time and produce garbage results:**
- Using 2048-token chunks on MultiHop-RAG (paper uses 256) — 53% of docs become single chunks
- Using substring match for GraphRAG-Bench (paper uses LLM-as-judge) — produces ACC=0.07 vs real ACC=0.57
- Using LLM-as-judge for MultiHop-RAG (paper uses word-intersection) — different scale entirely
- Running 2,000 retrieval-only queries on GraphRAG-Bench (no qrels) — produces NaN metrics, wastes 45 min
