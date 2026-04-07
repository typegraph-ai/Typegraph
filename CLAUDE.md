# CLAUDE.md — d8um Project Guide

d8um is a TypeScript SDK for retrieval + memory for AI agents, built on Postgres + pgvector.

## Architecture

- **Monorepo**: pnpm workspaces + turborepo
- **Benchmarks dir**: Uses npm (not pnpm) with `file:` protocol deps pointing to the SDK
- **Database**: Neon serverless Postgres with pgvector
- **Embeddings**: AI Gateway (Vercel) → openai/text-embedding-3-small
- **LLM**: AI Gateway → openai/gpt-5.4-mini (answer gen + default extraction)
- **Extraction LLM**: Configurable per `EXTRACTION_MODEL` in `benchmarks/lib/config.ts` (default: same as LLM_MODEL). Supports reasoning models like `xai/grok-4.20-reasoning` for higher-quality triple extraction.
- **Blob storage**: Vercel Blob (for benchmark datasets)

## Identity Model & Visibility

All user-facing tables use a standardized 5-field identity model with explicit B-tree indexed columns:

| Field | Column | Description |
|-------|--------|-------------|
| `tenantId` | `tenant_id TEXT` | Organization-level isolation |
| `groupId` | `group_id TEXT` | Team, channel, or project |
| `userId` | `user_id TEXT` | Individual user |
| `agentId` | `agent_id TEXT` | Specific agent instance |
| `conversationId` | `conversation_id TEXT` | Conversation session |

**Visibility** controls access level: `'tenant' | 'group' | 'user' | 'agent' | 'conversation'`. Stored as a `TEXT` column with CHECK constraint. Replaces the old `DocumentScope` type (which only had `'tenant' | 'group' | 'user'`).

**Indexes per identity-bearing table (9 B-tree indexes):**
- 4 composite: `(tenant_id, user_id)`, `(tenant_id, group_id)`, `(tenant_id, agent_id)`, `(tenant_id, conversation_id)`
- 4 individual: `(user_id)`, `(group_id)`, `(agent_id)`, `(conversation_id)`
- 1 visibility: `(visibility)`

**Tables with full identity columns:**
- Core: `d8um_chunks`, `d8um_documents`, `d8um_hashes`, `d8um_buckets`, `d8um_jobs`
- Graph/Memory: `d8um_memories`, `d8um_semantic_entities`, `d8um_semantic_edges`

**Postgres schema isolation:** Both `PgVectorAdapter` and `PgMemoryStoreAdapter` accept an optional `schema` config. When set, `CREATE SCHEMA IF NOT EXISTS` runs at deploy/initialize, and all table names are schema-qualified (e.g., `cust_abc.d8um_memories`). Index names use underscores instead of dots (e.g., `cust_abc_d8um_memories_tenant_user_idx`) because Postgres does not allow schema-qualified names in `CREATE INDEX` index name positions.

**`d8um.deploy()` wiring:** When `config.graph` is configured, `deploy()` also calls `config.graph.deploy()` to create memory/entity/edge tables.

**Memory tables keep a `scope JSONB` column alongside explicit identity columns** for backward compatibility during the transition period. New code reads/writes explicit columns; the JSONB scope is maintained in parallel.

## Sandbox Access

Claude Code's sandbox has outbound access to **all required services**:
- GitHub (github.com, api.github.com)
- Neon DB (neon.tech domains)
- AI Gateway / Vercel services (embeddings, LLM, Blob storage)

**All credentials are in `benchmarks/.env`.**

**Prerequisite:** Always run `pnpm run build` from the repo root before running benchmarks. The benchmark runners import from the SDK's `dist/` output (not source), so an outdated build causes silent errors or incorrect behavior.

## Running Benchmarks

All benchmarks are run locally from the `benchmarks/` directory.

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
- `--record` — Appends results to `history-{signals}.json` locally (e.g., `history-vector.json`, `history-vector+keyword.json`).
- `--eval-answers` / `--eval-answers-only` / `--eval-answers-limit=N` / `--eval-model=MODEL` — Answer-gen eval (multihop-rag and graphrag-bench).
- `--run-id=UUID` — Resume a previous eval run. Loads cached per-query scores from the JSONL cache file and skips already-scored queries. If omitted, a fresh run ID is auto-generated. (GraphRAG-Bench runners only.)

**Notes:**
- Run from the `benchmarks/` directory so relative imports resolve correctly
- `--env-file=.env` (relative path) requires being in `benchmarks/` when running
- Results are printed to stdout as JSON after `---BENCH_RESULT_JSON---`

### Benchmark Architecture

All 18 runners use a shared library (`benchmarks/lib/`):
- **`config.ts`** — Registry of all benchmark configs (dataset, bucket, table prefix, signals, scorer)
- **`runner.ts`** — Composable helpers: `initCore`, `initNeural`, `loadDataset`, `runIngestion`, `runQueries`, `computeMetrics`, `buildResult`, `emitResults`
- **`history.ts`** — Local history recording (`--record` flag)
- **`validate.ts`** — Smoke test (`--validate` flag)
- **`eval-cache.ts`** — Resumable eval run persistence (`--run-id` flag). Writes per-query scores to JSONL files in `{dataset}/{variant}/runs/`. On resume, skips already-scored queries.
- **`adapter.ts`** / **`datasets.ts`** / **`metrics.ts`** / **`report.ts`** — Shared utilities

### Adding a New Benchmark

1. Upload dataset to Vercel Blob via a seed script in `benchmarks/scripts/`
2. Add config entries in `benchmarks/lib/config.ts` (one per variant)
3. Create `benchmarks/{dataset}/baselines.json` with external comparison scores
4. Create runner files using shared helpers: `benchmarks/{dataset}/core/run.ts` and `/neural/run.ts`
5. Run `--validate` to verify the pipeline end-to-end
6. Get user approval, then run `--seed --record`

**IMPORTANT: Reseed requires DB clearing first:**
- `--seed` does NOT drop tables — it re-ingests via upsert with hash store deduplication.
- If you change the **triple extraction pipeline** (e.g., adding new fields to edge properties), re-seeding alone won't help — the hash store matches on content+embedding model (unchanged) and skips the doc before `extractFromChunk` fires.
- You MUST clear the hash store entries AND the graph tables first (see "Clearing Benchmark Data for Reseed" section), then reseed.

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

## Secrets (in `benchmarks/.env`)

- `NEON_DATABASE_URL` — Neon Postgres connection string
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway key (embeddings + LLM)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob storage token
- `NEON_API_KEY` — Neon management API key (used by scripts, not runners)
- `HF_TOKEN` — Hugging Face token (used by seed scripts)

## Operational Knowledge

Hard-won learnings from debugging the benchmark pipeline. Read this before running benchmarks or DB queries.

### Unified Eval Loop Architecture

All benchmark runners that support answer eval use a **single unified loop**. There is NO separate "answer-only" code path — just one loop with conditional behavior based on flags.

```
for each query:
  results = d.query(queryText, { signals, count: 50 })
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

### Corpus Sizes

For estimating seed times (~3 docs/s embedding throughput for core):

| Dataset | Corpus | Queries | Chunk Size | Est. Core Seed Time |
|---------|--------|---------|------------|---------------------|
| license-tldr-retrieval | 65 | 65 | 2048 | ~30s |
| contractual-clause-retrieval | ~90 | ~90 | 2048 | ~30s |
| australian-tax-guidance-retrieval | ~105 | ~112 | 2048 | ~35s |
| mleb-scalr | 523 | 120 | 2048 | ~3min |
| multihop-rag | 609 | ~2,556 | 256 | ~3min |
| graphrag-bench-novel | 1,147 | 2,010 | 1200 | ~10min |
| graphrag-bench-medical | ~1,000 | 2,062 | 1200 | ~10min (est.) |
| nfcorpus | ~3,633 | ~323 | 2048 | ~20min |
| legal-rag-bench | 4,876 | 100 | 2048 | ~27min |

### Baselines & History Files

**Baselines** (`benchmarks/{dataset}/baselines.json`):
- Each entry has: `system`, `metrics`, `source`, `year`, `metric_note`
- Sources: MLEB Leaderboard (isaacus) for legal/tax datasets, MTEB/BEIR for nfcorpus, paper tables for multihop-rag
- `metric_note` clarifies what's being compared (e.g., "Hit@10 not nDCG@10")

**History files** (`benchmarks/{dataset}/{variant}/history-{signals}.json`):
- Signal-specific: `history-vector.json`, `history-vector+keyword.json`, `history-vector+keyword+graph+memory.json`
- Legacy files: `history-hybrid.json`, `history-fast.json`, `history-neural.json` (pre-signals refactor, 2026-04-06)
- All entries now have `timing` objects (older entries backfilled with `ingestionSeconds: null`)
- `--record` flag appends locally
- Entry format: `{ commit, date, metrics, avgQueryMs, timing, signals, config }`

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

#### Current DB State (as of 2026-04-02)

**NOTE:** All existing tables in the live database pre-date the identity model standardization (2026-04-02). They are missing the `group_id`, `user_id`, `agent_id`, `conversation_id` columns on chunks/hashes/buckets/jobs, and the `visibility` column on documents (still has `scope`). Memory tables are missing explicit identity columns. Any reseed will need fresh table creation (DROP + deploy) or ALTER TABLE migrations. The `schema` isolation feature only applies to new deployments.


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
| graphrag-bench-novel | neural | 1410 | 1147 | 1147 | 3,798 / 8,819 | Seeded ✓ (grok-4.20-reasoning extraction, 2026-04-01) |

**legal-rag-bench anomaly:** `d8um_documents` and `d8um_hashes` have 4859 entries, but `bench_legalrag_core__gateway_openai_text_embedding_3_small` is empty. The chunk table was truncated without clearing hashes/documents. Before reseeding: clear hashes and documents for `legal-rag-bench` bucket, then the seed will re-ingest.

#### Reseed Procedure (MUST follow in order)

**CRITICAL: DB wipes and reseeds require explicit user approval. NEVER auto-clear. ALWAYS validate on small data before full runs.**

1. **Get explicit user approval** for which dataset/variant to clear and reseed
2. **Run clear SQL** directly against Neon (see "Database Queries" section)
3. **VERIFY immediately**: `DELETE` row counts must be >0 for hashes/documents. If 0 → hash store NOT cleared → seed will skip everything → **DO NOT PROCEED**
4. **Run `--validate` first** to confirm the pipeline works on 5 docs/queries
5. **Only then run `--seed`** for the full dataset

**Common mistakes that waste compute:**
- Running `--seed` without clearing the DB first — hash store skips all docs, triple extraction never runs, edge properties unchanged.
- Not verifying `DELETE N > 0` in the clear result — hash entries remain, seed skips everything.

### Benchmark Results Readout

When asked for a readout on benchmark results, pull data from the **history files in the repo**.

#### Where results live

- **History files**: `benchmarks/{dataset}/{variant}/history-{signals}.json` (e.g., `history-vector.json`, `history-vector+keyword.json`, `history-vector+keyword+graph+memory.json`)
- **Legacy history**: `benchmarks/{dataset}/{variant}/history-{mode}.json` (pre-signals refactor: `history-hybrid.json`, `history-fast.json`, `history-neural.json`) and `history.json` (pre-dual-mode runs)
- **Baselines**: `benchmarks/{dataset}/baselines.json`

#### How to produce a readout

1. Read all `history-*.json` files for each dataset/variant that has been run
2. Read each dataset's `baselines.json` for the external comparison targets
3. Present a table per dataset showing: commit, signals, chunk size, nDCG@10, MAP@10, Recall@10, Precision@10, avg query ms, ingest time (if available), delta vs text-embedding-3-small baseline
4. Timing data is available in entries from 2026-03-29 onward (the `timing` object); older entries only have root-level `avgQueryMs`
5. Highlight the best result per dataset and whether it beats baseline
6. Call out notable patterns (e.g., vector > vector+keyword, neural ≈ core, chunk ratio issues)

The history JSON files are the source of truth for all benchmark results.

### Neural Ingestion Performance

Neural ingestion is much slower than core due to LLM calls per chunk (entity + relationship extraction) plus embedding calls for entity resolution. "Neural" refers to using all signals (`{ vector: true, keyword: true, graph: true, memory: true }`) which requires graph indexing at ingest time.

**Concurrency:** The `concurrency` option in `IndexOpts` controls parallel document processing during ingest. Neural runners use `concurrency: 5` (default: 1 sequential). Higher values give proportional speedup but increase API rate limit risk and memory pressure.

**Extraction timeout:** All `extractFromChunk` calls are wrapped with a 120-second timeout (`withTimeout` in engine.ts). If an LLM call hangs, the extraction is abandoned and the document continues without triples.

**Memory:** Neural seed on large datasets (600+ docs) requires `NODE_OPTIONS="--max-old-space-size=4096"`. Default Node.js heap (~1.7GB) causes silent OOM kills.

**Estimated neural seed times** (with concurrency=5):

| Dataset | Corpus | Est. Neural Seed Time |
|---------|--------|-----------------------|
| license-tldr-retrieval | 65 | ~96s |
| multihop-rag | 609 | ~33min |
| graphrag-bench-novel | 1,147 | ~139min (grok-4.20-reasoning) |
| graphrag-bench-medical | ~1,000 | ~120min (est., grok-4.20-reasoning) |
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

**Key milestones:**
- **2026-03-28** — Beat text-embedding-3-small baseline on 3/4 BEIR benchmarks (PR #7)
- **2026-04-01** — 🏆 **#1 on GraphRAG-Bench Novel** (58.4% ACC, statistically significant over HippoRAG2 at 56.5%) — first published benchmark where d8um outperforms all known graph-RAG systems (PR #15)
- **2026-04-06** — Replaced monolithic `QueryMode` with composable `QuerySignals` — users now specify which retrieval systems to activate instead of choosing from arbitrary presets

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

4. **Dual-signal benchmark runners** (all 6 core runners)
   - Core benchmarks run both `vector+keyword` and `vector` (pure vector) side by side
   - Emit JSON array of results; signal-specific history files (`history-vector+keyword.json`, `history-vector.json`)

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

8. **4GB heap for large datasets**
   - `NODE_OPTIONS="--max-old-space-size=4096"` prevents OOM kills
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
- **OOM is silent.** Node.js default heap (~1.7GB) is insufficient for neural ingestion of 600+ docs. The process is killed with SIGKILL — no error handlers fire, no stack trace. Always set `--max-old-space-size=4096`.
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

3. **Answer-only benchmark mode** (both runners)
   - `--eval-answers-only`: queries only the gold-answer subset, skips full IR metrics
   - `--eval-model=MODEL`: override LLM for answer generation

4. **Gold answers pipeline**
   - `benchmarks/scripts/seed-multihop-answers.ts`: extracts answers from HuggingFace MultiHopRAG parquet
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

### 2026-04-01 — 🏆 MILESTONE: #1 on GraphRAG-Bench Novel — extraction pipeline overhaul + reasoning model + full eval (PR #15)

**Result: d8um achieves state-of-the-art on GraphRAG-Bench Novel (58.4% ACC), ranking #1 overall with statistical significance over HippoRAG2 (56.5%).** This is the first published graph-RAG benchmark where d8um outperforms all known systems including HippoRAG2, Microsoft GraphRAG, LightRAG, and Fast-GraphRAG.

**Goal:** Implement a comprehensive extraction pipeline overhaul (9 phases) to improve graph signal quality, then reseed graphrag-bench-novel/neural with a reasoning model (xai/grok-4.20-reasoning) and measure impact.

#### Pipeline changes (all 9 phases implemented)

1. **Single-pass extraction** (`packages/core/src/index-engine/triple-extractor.ts`)
   - Combined entity + relationship extraction into one LLM call (was two sequential calls)
   - Added self-review instruction: "Review your extraction — did you miss any entities or relationships?"
   - Tightened alias instructions to prevent garbage aliases
   - `twoPass: true` config preserves the old two-call behavior

2. **ExtractionConfig SDK type** (`packages/core/src/types/extraction-config.ts`, `packages/core/src/d8um.ts`)
   - New `ExtractionConfig` interface: `{ twoPass?, entityLlm?, relationshipLlm? }`
   - Surfaced as `d8umConfig.extraction` — allows different LLMs for extraction vs main pipeline
   - Wired through `createIndexEngine` → `TripleExtractor`

3. **Entity descriptions persisted** (`triple-extractor.ts`, `graph-bridge.ts`, `entity-resolver.ts`)
   - LLM-extracted descriptions stored in `entity.properties.description`
   - Merged across chunks in `EntityResolver.merge()` — concatenates non-duplicate descriptions
   - **Known issue:** Descriptions accumulate unboundedly for hub entities (e.g., Laurence Sterne: 15,628 chars, 88 entities over 1,000 chars). Cap at 500 chars recommended but deferred since descriptions are unused in retrieval currently.

4. **Expanded entity types** — 6 → 10 types (added work_of_art, technology, law_regulation, time_period)

5. **Trigram Jaccard fuzzy matching** (`packages/graph/src/extraction/entity-resolver.ts`)
   - New matching tier between normalized string and vector similarity
   - Catches "NY Times" / "New York Times" style variations
   - Threshold: 0.7, zero dependencies

6. **Entity type guard** — prevents merging entities with conflicting specific types (person ≠ location)

7. **Predicate ontology** (`packages/core/src/index-engine/ontology.ts`)
   - ~150 predicates organized by entity-type pair (person→person, person→org, etc.)
   - Replaces inline vocabulary in extraction prompt

8. **Expanded predicate normalizer** (`packages/graph/src/extraction/predicate-normalizer.ts`)
   - ~40 → ~80 synonym groups covering the new ontology predicates
   - MENTIONED and ASSOCIATED_WITH aligned with GENERIC_PREDICATES filter

9. **Cross-chunk entity context** (`packages/core/src/index-engine/engine.ts`, `triple-extractor.ts`)
   - Triple extraction now sequential per document (was parallel)
   - Accumulated entity context (name + type) passed to subsequent chunks
   - Cap at 20 entities in context window to prevent prompt bloat
   - Documents still process concurrently via semaphore

#### Benchmark infrastructure changes

1. **EXTRACTION_MODEL** (`benchmarks/lib/config.ts`) — configurable extraction LLM, currently set to `xai/grok-4.20-reasoning`
2. **initNeural wiring** (`benchmarks/lib/runner.ts`) — passes `ExtractionConfig` through when EXTRACTION_MODEL differs from LLM_MODEL
3. **Per-type ACC breakdown** — runners now track `question_type` from queries.json and report ACC per type (Fact Retrieval, Complex Reasoning, Contextual Summarize, Creative Generation)
4. **Resumable eval cache** (`benchmarks/lib/eval-cache.ts`) — JSONL-based crash-safe persistence for eval runs. `--run-id=UUID` resumes a previous run, skipping already-scored queries. Files stored at `{dataset}/{variant}/runs/{runId}.jsonl`.
5. **queries.json updated** — re-uploaded with `question_type` field for both novel (2,010 queries) and medical (2,062 queries) via `benchmarks/scripts/reseed-queries.ts`

#### Results — graphrag-bench-novel/neural reseed with grok-4.20-reasoning

Graph health comparison (previous gpt-5.4-mini extraction → new grok-4.20-reasoning extraction):

| Metric | Previous (gpt-5.4-mini) | New (grok-4.20-reasoning) | Delta |
|--------|--------------------------|---------------------------|-------|
| Entities | 6,264 | 3,798 | **-39%** (better merging) |
| Edges | 15,117 | 8,819 | -42% |
| Edges/entity | 2.41 (1.31 after noise filter) | **2.32** (all informative) | +77% informative density |
| Distinct predicates | 125 | **247** | +98% vocabulary richness |
| Noise predicates (MENTIONED/ASSOCIATED_WITH) | 46.3% of edges | **0%** | eliminated |
| Entity duplicates | 30 pairs (0.48%) | ~18 pairs (0.47%) | maintained |
| Embedding coverage | 100% | 100% | maintained |
| Ingest time | 3,516s (~58min) | ~8,316s (~139min) | ~2.4x slower (reasoning model) |

**Key insight:** The reasoning model produces far fewer but higher-quality extractions. 39% fewer entities (better entity resolution + less hallucinated entities), 100% informative predicates (zero noise), and nearly 2x the predicate vocabulary richness. The graph is smaller but every edge carries semantic meaning.

#### ACC results — full eval (2,009 queries, LLM-as-judge, run 37e85e19)

**Overall ACC: 58.4%** [95% CI: 57.2%, 59.5%] — 6.6 hours, 11.9s/query avg, 1 error.

| Category | d8um neural | HippoRAG2 | Delta | Significant? | Rank |
|----------|-------------|-----------|-------|--------------|------|
| Fact Retrieval (n=970) | **61.7%** [59.7, 63.7] | 60.1% | +1.5 | No (CI overlaps) | **#1** |
| Complex Reasoning (n=610) | 53.1% [51.4, 54.8] | **53.4%** | -0.3 | No (CI overlaps) | **#2** |
| Contextual Summarize (n=362) | 60.4% [58.6, 62.2] | **64.1%** | -3.7 | **Yes (HippoRAG2 wins)** | **#3** |
| Creative Generation (n=67) | 47.7% [44.3, 51.0] | **48.3%** | -0.6 | No (CI overlaps) | **#2** |
| **Overall (n=2009)** | **58.4%** [57.2, 59.5] | 56.5% | **+1.9** | **Yes (d8um wins)** | **#1** |

Earlier 100-query sample showed 56.6% — the full eval converged to 58.4%, demonstrating importance of full-dataset evaluation. Convergence stabilized from n=700 onward (CI width narrowed from 10.7% at n=100 to 2.3% at n=2009).

#### Competitive positioning — GraphRAG-Bench Novel ACC (full results)

| Rank | System | Fact Retr | Complex R | Ctx Summ | Creative | Overall | Source |
|------|--------|-----------|-----------|----------|----------|---------|--------|
| **#1** | **d8um neural** | **61.7** | 53.1 | 60.4 | 47.7 | **58.4** | Full eval (2,009 queries) |
| #2 | HippoRAG2 | 60.1 | **53.4** | 64.1 | **48.3** | 56.5 | arXiv:2506.05690 Table 3 |
| #3 | Fast-GraphRAG | 57.0 | 48.5 | 56.4 | 46.2 | 52.0 | arXiv:2506.05690 Table 3 |
| #4 | GraphRAG local | 49.3 | 50.9 | **64.4** | 39.1 | 50.9 | arXiv:2506.05690 Table 3 |
| #5 | RAG w/ rerank | 60.9 | 42.9 | 51.3 | 38.3 | 48.4 | arXiv:2506.05690 Table 3 |
| #6 | LightRAG | 58.6 | 49.1 | 48.9 | 23.8 | 45.1 | arXiv:2506.05690 Table 3 |

**d8um neural is #1 overall with statistical significance** (CI lower bound 57.2 > HippoRAG2's 56.5). Wins Fact Retrieval (#1), ties Complex Reasoning and Creative Generation (#2), loses Contextual Summarize (#3).

**Defensible claim:** "d8um achieves state-of-the-art results on GraphRAG-Bench Novel, ranking #1 overall (58.4%) with statistical significance over HippoRAG2 (56.5%)."

**Caveats for honest reporting:**
1. **Generation model confounder**: d8um used GPT-5.4-mini, baselines used GPT-4o-mini. The generation model difference could partially explain the Fact Retrieval edge. A validation run with GPT-4o-mini would control for this.
2. **Marginal significance**: CI lower bound 57.2 vs HippoRAG2 56.5 is only 0.7pp above. Different judge temperature or random seed could flip this.
3. **No paired test**: We don't have HippoRAG2's per-query scores or CIs. Unpaired comparison is fundamentally limited.
4. **Extraction cost asymmetry**: grok-4.20-reasoning ingestion (~139 min) is much more expensive than GPT-4.1 (HippoRAG2). Not normalized for compute budget.
5. **Contextual Summarize weakness is real and significant**: -3.7pp, statistically confirmed. This is where global/community-based context aggregation approaches have a structural advantage that PPR chunk re-ranking cannot match.

#### Key learnings

- **Reasoning models produce dramatically better extractions but at ~10x the cost.** grok-4.20-reasoning averaged ~7.2s/chunk vs ~0.7s/chunk for gpt-5.4-mini. The quality difference is substantial (zero noise predicates, 39% fewer entities, 2x vocabulary) but ingestion becomes the bottleneck.
- **Graph quality ≠ retrieval quality (yet).** A perfect graph with zero noise still produces the same ACC because the PPR re-ranking architecture can only shuffle existing chunks. The architectural fix needed: allow graph results to *supplement* indexed search results, not just re-rank them.
- **Entity descriptions accumulate unboundedly.** The merge logic in `EntityResolver.merge()` concatenates descriptions across chunks with an `includes()` dedup check. Hub entities that appear in many chunks accumulate multi-KB descriptions. A simple 500-char cap in the merge function would fix this. Deferred since descriptions aren't used in retrieval yet.
- **Eval run persistence is essential for long-running benchmarks.** A 2,010-query GraphRAG-Bench eval takes 6-10 hours. Without crash-safe persistence, a single timeout/error loses all progress. The JSONL eval cache writes each scored query immediately and resumes via `--run-id=UUID`.
- **Per-type ACC reveals where graph helps most.** Different question types (Fact Retrieval, Complex Reasoning, Contextual Summarize, Creative Generation) respond differently to retrieval strategies. Breaking out ACC by type is essential for understanding where neural mode adds value vs core.
- **Sequential per-document extraction enables cross-chunk context** but removes intra-document parallelism. For neural ingestion, the bottleneck is LLM latency per chunk, so the parallelism loss is minimal (LLM calls are sequential anyway). Inter-document parallelism (concurrency semaphore) still provides the main speedup.
- **Full-dataset eval is essential — small samples are misleading.** The 100-query sample gave ACC=0.566, the full 2,009-query eval converged to 0.584. Early samples (n=300) peaked at 0.609 before regressing to the mean. CI width went from 10.7% (n=100) to 2.3% (n=2009). Never draw conclusions from <500 queries on this benchmark.
- **Convergence takes ~700 queries on GraphRAG-Bench Novel.** ACC stabilized at ~58% from n=700 onward and the CI width plateaued below 4%. For quick iteration, ~500 queries gives directionally useful results; for publishable claims, run the full dataset.
- **Fact Retrieval is d8um's strongest category** (#1 at 61.7%) — hybrid search excels at specific passage lookup. This is also the largest category (48% of queries), which drives the overall lead.
- **Contextual Summarize is a confirmed architectural weakness** (#3 at 60.4%, -3.7pp vs HippoRAG2, statistically significant). PPR chunk re-ranking cannot synthesize broad context the way community-based approaches (GraphRAG local, HippoRAG2) can. Fixing this requires either a global summary mechanism or allowing graph traversal to aggregate across document boundaries.
- **Generation model is the main confounder for cross-system comparison.** d8um used GPT-5.4-mini for answer generation; baselines used GPT-4o-mini. A validation run with GPT-4o-mini generation would control for this and is the single most valuable next step for defensible claims.
- **Score distribution is bimodal** (20% score 0.9-1.0, 12% score 0.1-0.2). The LLM-as-judge either strongly agrees or strongly disagrees with the gold answer. This makes the mean sensitive to tail queries — a few flips can move it 1-2 points. The median (58.75%) tracking close to the mean (58.38%) is reassuring.

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

### 2026-04-02 — Identity model standardization + Postgres schema isolation

**Goal:** Standardize the 5-field identity model (`tenantId`, `groupId`, `userId`, `agentId`, `conversationId`) across every table, type, and query path in the SDK. Add `Visibility` type. Add Postgres schema isolation support.

#### Changes made (23 files modified, 1 created)

**Type layer (`packages/core/src/types/`):**
- Renamed `DocumentScope` → `Visibility`, expanded from `'tenant' | 'group' | 'user'` to include `'agent' | 'conversation'`
- Added `groupId`, `userId`, `agentId`, `conversationId` to: `IndexOpts`, `ChunkFilter`, `EmbeddedChunk`, `Bucket`, `CreateBucketInput`, `Job`, `CreateJobInput`
- Added `agentId`, `conversationId`, `visibility` to: `d8umDocument`, `DocumentFilter`, `UpsertDocumentInput`
- Added `deploy?(): Promise<void>` to `GraphBridge` interface
- Updated `d8umResult.bucket` to carry all 5 identity fields + `visibility` (was `scope`)

**DDL / Schema (`packages/adapters/pgvector/src/migrations.ts`):**
- Added `group_id`, `user_id`, `agent_id`, `conversation_id` columns to chunks, documents, hashes, buckets, jobs tables
- Replaced `scope TEXT` with `visibility TEXT` (with expanded CHECK constraint) on documents
- Changed documents `group_id`/`user_id` from UUID to TEXT (consistent with all other identity columns)
- Added 8 B-tree indexes per table (4 composite tenant+sub, 4 individual) + visibility index on documents
- Removed standalone `tenant_idx` on chunks (redundant — covered by composite `tenant_user_idx`)

**Memory DDL (`packages/graph/src/adapters/pgvector.ts`):**
- Added 5 explicit identity columns + `visibility` column (with CHECK constraint) to memories, entities, edges tables
- Added 9 B-tree indexes per table (same pattern as core tables)
- Renamed episodic `session_id` → `episodic_session_id` to avoid collision with identity `conversation_id`
- Added `schema` config + `CREATE SCHEMA IF NOT EXISTS` in `initialize()`
- Index naming: `idxPrefix(t)` replaces dots with underscores for schema-qualified table names (Postgres cannot schema-qualify index names in `CREATE INDEX`)
- HNSW index creation (`ensureHnswIndex`) uses same `idxPrefix` pattern
- All CRUD methods (`upsert`, `upsertEntity`, `upsertEdge`, `list`, `findEntities`, `searchEntities`) write/read explicit identity columns
- New helpers: `buildIdentityWhere()` (builds WHERE from d8umIdentity), `rowToIdentity()` (extracts identity from DB row)

**Core adapter (`packages/adapters/pgvector/src/adapter.ts`):**
- Added `schema` config + `CREATE SCHEMA IF NOT EXISTS` in `deploy()`
- `upsertChunks`: writes all 5 identity columns (was only `tenant_id`), now 15 params via unnest
- `upsertBucket`: 9 params with all identity fields
- `upsertJob`: 17 params with all identity fields
- `buildWhere()`: filters on all 5 identity fields
- All `mapRow*` functions: read all identity columns

**Document store (`packages/adapters/pgvector/src/document-store.ts`):**
- `upsert`: 15 params with all identity fields, `scope` → `visibility`
- `buildDocWhere()`: filters on `agentId`, `conversationId`, `visibility` (was `scope`)

**Query pipeline:**
- `IndexedRunner.run()`: accepts full `d8umIdentity` (was `tenantId?: string`), passes all 5 fields to chunk filter
- `QueryPlanner`: passes full identity to IndexedRunner (was only `tenantId`)
- `merger.ts`: `NormalizedResult` carries `documentVisibility`, `agentId`, `conversationId` (was `documentScope`)
- `context-search.ts`: passes identity object, maps `visibility` (was `scope`)
- `planner.ts`: maps `visibility`, `agentId`, `conversationId` to result bucket

**Ingest pipeline (`packages/core/src/index-engine/engine.ts`):**
- All 3 ingest methods (`indexWithConnector`, `ingestWithChunks`, `ingestBatch`): destructure full identity from `IndexOpts`, propagate to documents and embedded chunks
- `scope: indexConfig.scope` → `visibility: visibility ?? indexConfig.visibility`

**Deploy wiring:**
- `d8um.deploy()`: calls `config.graph.deploy()` when graph is configured
- `graph-bridge.ts`: implements `deploy()` → `memoryStore.initialize()`

**Integration test (`benchmarks/scripts/test-memory.ts`):**
- 34 assertions across 11 test sections: deploy, store, user isolation, tenant isolation, cross-tenant isolation, group scoping, visibility filtering, forget/invalidate, entity+edge creation, entity scope filtering, cleanup
- Uses isolated Postgres schema (`test_mem_{timestamp}`) with `DROP SCHEMA CASCADE` cleanup
- 4 test identities across 2 tenants

#### Migration notes

- No backward-compat shims — `DocumentScope` export replaced with `Visibility`
- Memory tables keep `scope JSONB` alongside explicit columns (parallel writes)
- Existing deployed tables will need `ALTER TABLE ADD COLUMN` for new identity columns — not handled by this commit (deploy creates fresh tables)
- Documents table `group_id`/`user_id` changed from UUID to TEXT — existing data will need migration

### 2026-04-06 — QuerySignals: composable query routing replaces monolithic QueryMode

**Problem:** d8um had 5 monolithic query modes (`fast | hybrid | memory | neural | auto`) that locked users into arbitrary presets. Users could not combine retrieval systems freely — e.g., vector+graph without keyword, or vector+memory without graph were impossible. The mode system had 10 identified gaps blocking end-user functionality.

**Solution:** Replaced `QueryMode` entirely with `QuerySignals` — a composable interface where users specify which retrieval systems to activate:

```typescript
export interface QuerySignals {
  vector?: boolean    // default: true — ANN vector search
  keyword?: boolean   // default: false — BM25 keyword search
  graph?: boolean     // default: false — PPR graph traversal
  memory?: boolean    // default: false — cognitive memory recall
}
```

Default: `{ vector: true }` (fast vector-only search). Any combination works.

#### Changes made (25+ files across SDK + benchmarks)

**SDK Core:**

1. **Type definitions** (`packages/core/src/types/query.ts`)
   - Removed `QueryMode` type, `mode` field on `QueryOpts`, `mergeStrategy`, `mergeWeights`
   - Added `QuerySignals`, `signals` field on `QueryOpts`
   - Added `scoreWeights?: Partial<Record<'rrf' | 'semantic' | 'keyword' | 'graph' | 'memory', number>>` — user-configurable composite score weights
   - Added `graphReinforcement?: 'only' | 'prefer' | 'off'` — controls how graph results interact with indexed results

2. **Query planner** (`packages/core/src/query/planner.ts`) — complete rewrite
   - `resolveSignals(opts)`: resolves user input to `Required<QuerySignals>` with defaults
   - `signalLabel(signals)`: human-readable label (e.g., `"vector+keyword"`, `"vector+keyword+graph+memory"`)
   - `computeCompositeScore(scores, signals, userWeights?)`: shared scoring function that auto-derives default weights from active signals or accepts user overrides
   - Signal-based routing replaces mode-string branching: `signals.graph && this.graph` → GraphRunner, etc.
   - New paths: graph-only (`{ graph: true }`), memory-only (`{ memory: true }`), vector+graph, vector+memory — all previously impossible
   - `graphReinforcement` option: `'only'` (default, existing behavior — filter graph to indexed matches), `'prefer'` (boost matching, keep novel), `'off'` (all graph results as-is)

3. **Classifier** (`packages/core/src/query/classifier.ts`) — returns `QuerySignals` instead of `QueryMode`

4. **Merger** (`packages/core/src/query/merger.ts`) — uses shared `computeCompositeScore()`, accepts `scoreWeights` overrides

5. **Context search** (`packages/core/src/query/context-search.ts`) — respects `signals.keyword` instead of hardcoded hybrid

6. **Exports** (`packages/core/src/index.ts`) — `QueryMode` removed, `QuerySignals` + `resolveSignals` + `signalLabel` + `computeCompositeScore` + `classifyQuery` added

**Benchmarks:**

7. **Config** (`benchmarks/lib/config.ts`) — `BenchSignals` interface, `SIGNALS` presets (`SIGNALS.vector`, `SIGNALS.vectorKeyword`, `SIGNALS.neural`), `signalLabel()` function. `BenchmarkConfig.modes` → `BenchmarkConfig.signals`

8. **Runner** (`benchmarks/lib/runner.ts`) — `runQueries()` accepts `BenchSignals`, passes `signals` to `d.query()`

9. **Report** (`benchmarks/lib/report.ts`) — `BenchmarkResult.mode` → `BenchmarkResult.signals` (string label)

10. **History** (`benchmarks/lib/history.ts`) — file naming: `history-${result.signals}.json`, entry: `signals` field

11. **Validate** (`benchmarks/lib/validate.ts`) — default: `config.signals[0] ?? { vector: true }`

12. **Eval cache** (`benchmarks/lib/eval-cache.ts`) — `EvalRunMeta.mode` → `EvalRunMeta.signals`

13. **All 18 benchmark runners** — `mode: 'neural'` → `signals: SIGNALS.neural`, mode loops → signal loops

14. **Diagnose script** (`benchmarks/scripts/diagnose-acc.ts`) — `mode: 'hybrid'` → `signals: { vector: true, keyword: true }`

#### Signal ↔ old mode equivalence

| Old Mode | Equivalent Signals | Notes |
|----------|-------------------|-------|
| fast | `{ vector: true }` | **New default** when no signals specified |
| hybrid | `{ vector: true, keyword: true }` | |
| graph | `{ graph: true }` | **New** — was impossible before |
| memory | `{ memory: true }` | |
| neural | `{ vector: true, keyword: true, graph: true, memory: true }` | |
| auto | Removed — classifier is internal only | |

#### New combinations unlocked

- `{ vector: true, graph: true }` — vector + graph without keyword noise
- `{ vector: true, memory: true }` — vector + memory without graph overhead
- `{ vector: true, keyword: true, memory: true }` — hybrid + memory without graph
- `{ graph: true, memory: true }` — graph + memory without indexed search
- Custom `scoreWeights` — tune composite scoring per query
- `graphReinforcement: 'off'` — allow graph to surface novel results not in indexed search

#### Verification

- Build: 7 packages compiled clean
- Tests: 293 tests passed (no regressions)
- Behavioral equivalence: signal defaults produce identical routing to old modes

#### Key learnings

- **Composable primitives > named presets.** Named modes (`fast`, `hybrid`, `neural`) hide what's actually happening and create artificial barriers. Users wanted `vector+graph` but couldn't get it because no mode offered that combination. Exposing the underlying signals directly is simpler and more powerful.
- **Mode removal was cleaner than backward compat.** The initial plan kept `QueryMode` as convenience aliases. Removing it entirely was less code, fewer edge cases, and a clearer API. No backward-compat shims needed because the SDK is pre-1.0.
- **Score weight auto-derivation makes composability practical.** With 15 possible signal combinations, hardcoding weights per combo is unmaintainable. `computeCompositeScore()` auto-derives equal weights from active signals, and users can override via `scoreWeights` for fine-tuning.
- **Benchmark infrastructure is the long pole.** The SDK changes were straightforward (planner rewrite + type changes). Updating 18 benchmark runners, config, history, report, validate, and eval-cache was the bulk of the work. A shared `BenchSignals` type + `SIGNALS` presets kept it manageable.
- **History file naming changed.** Old: `history-hybrid.json`, `history-fast.json`. New: `history-vector+keyword.json`, `history-vector.json`. Legacy files remain in the repo but new `--record` runs write to signal-named files.
