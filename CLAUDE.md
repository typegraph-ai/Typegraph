# CLAUDE.md — d8um Project Guide

d8um is a TypeScript SDK for retrieval + memory for AI agents, built on Postgres + pgvector.

## Architecture

- **Monorepo**: pnpm workspaces + turborepo
- **Benchmarks dir**: Uses npm (not pnpm) with `file:` protocol deps pointing to the SDK
- **Database**: Neon serverless Postgres with pgvector
- **Embeddings**: AI Gateway (Vercel) → openai/text-embedding-3-small
- **LLM**: AI Gateway → google/gemini-3.1-flash-lite-preview
- **Blob storage**: Vercel Blob (for benchmark datasets)

## Sandbox Limitations

Claude Code's sandbox has outbound access to GitHub (github.com, api.github.com) and **Neon DB** (neon.tech domains allowlisted). Other external services (AI Gateway, Vercel Blob, npm registry for installs) are still unreachable.

**You can query the database directly** using `@neondatabase/serverless` from the `benchmarks/` directory (which has the package installed). The connection string is in `benchmarks/.env`. **You cannot run benchmarks directly** — those still require CI (they need AI Gateway for embeddings/LLM).

## Running Benchmarks

Benchmarks are triggered via GitHub Actions using commit message tags. Results are posted as PR comments.

### Prerequisites

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
cd /path/to/d8um/benchmarks
node -e "
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:REDACTED@ep-young-lake-an4yj1r0-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require');
sql\`SELECT ...\`.then(r => console.log(JSON.stringify(r, null, 2))).catch(e => console.error(e.message));
"
```

Or for longer queries, write a `.js` script that `require`s `@neondatabase/serverless` and run it with `node`.

### Notes

- The CI-based `db-inspect` workflow (`db-queries/` commit pattern) is no longer needed for ad-hoc queries — use direct access instead.
- The `db-inspect` workflow still exists but is only needed if you want query results stored in the repo for historical reference.
- Tagged template literals in `@neondatabase/serverless` parameterize automatically — avoid string concatenation for values.

## Benchmark Datasets (7 datasets × 2 variants = 14 benchmarks)

| Dataset | Description |
|---------|-------------|
| nfcorpus | Biomedical information retrieval (BEIR) |
| australian-tax-guidance-retrieval | Australian tax law documents |
| contractual-clause-retrieval | Legal contract clauses |
| license-tldr-retrieval | Software license summaries |
| mleb-scalr | Multi-language evaluation benchmark |
| legal-rag-bench | Legal RAG evaluation |
| multihop-rag | Multi-hop QA over news articles (COLM 2024) |

## Metrics

### Retrieval Metrics (all benchmarks)

All benchmarks report BEIR-standard metrics at cutoff 10:
- **nDCG@10**: Normalized Discounted Cumulative Gain
- **MAP@10**: Mean Average Precision
- **Recall@10**: Recall
- **Precision@10**: Precision
- **MRR@10**: Mean Reciprocal Rank (multihop-rag only)
- **Hit@10**: Hit rate at 10 (multihop-rag only)

### Answer-Generation Metrics (multihop-rag only)

When `--eval-answers` or `--eval-answers-only` is passed, multihop-rag runners also report:
- **ACC**: Substring accuracy — `normalize(gold) in normalize(predicted)`. This is the paper-comparable metric (MultiHop-RAG paper uses substring match, not exact match).
- **EM**: Exact match — `normalize(predicted) === normalize(gold)`. Stricter than ACC.
- **F1**: Token-level F1 — precision/recall over whitespace-tokenized normalized text.

**Critical methodology note:** The MultiHop-RAG paper (Tang & Yang, COLM 2024) uses substring match (ACC), NOT exact match. They pass top-6 retrieved chunks (max ~2048 tokens) as context to GPT-4. Our runners now match this methodology: top-6 chunks from `response.results[].content`, not full articles.

### Runner Flags (multihop-rag)

- `--eval-answers`: Run answer eval after full retrieval benchmark (all 2255 queries + answer gen)
- `--eval-answers-only`: Single-loop answer eval — for each query: retrieve → generate → score. Default limit: 100 queries. Skips IR metrics. Finishes in ~5-15 min.
- `--eval-answers-limit=N`: Override the default limit of 100 queries (e.g., `--eval-answers-limit=2255` for full eval, `--eval-answers-limit=20` for quick smoke test)
- `--eval-model=MODEL`: Override the LLM for answer generation (default: `google/gemini-3.1-flash-lite-preview`)

## Development

```bash
pnpm install          # Install SDK deps
pnpm run build        # Build SDK
cd benchmarks && npm install  # Install benchmark deps (separate npm)
```

## Secrets (configured in GitHub repo settings)

- `NEON_DATABASE_URL` — Neon Postgres connection string
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway key (embeddings + LLM)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob storage token

## Operational Knowledge

Hard-won learnings from debugging the benchmark pipeline. Read this before running benchmarks or DB queries.

### Answer-Only Mode Architecture

`--eval-answers-only` uses a **single-loop** architecture: for each query up to the limit (default 100), it retrieves chunks, generates an answer via LLM, and scores it (ACC/EM/F1) immediately — all in one pass. This replaces the old two-phase approach (retrieve all queries first, then generate answers in a separate loop).

**Key design decisions:**
- **Default limit = 100**: Not `Infinity`. All 2255 multihop-rag queries have gold answers, so filtering by "has gold answer" is a no-op. The limit is what makes this fast.
- **Single loop with early return**: The `evalAnswersOnly` code path returns before the normal retrieval/scoring phases. No intermediate `allResults`/`allChunkResults` maps.
- **Per-query error handling**: `generateText` failures are caught per-query and logged, not fatal. The loop continues.
- **15-minute timeout**: With 100 queries at ~3s each (retrieval + LLM), completes in ~5 min. Override with `--eval-answers-limit=N` for larger runs (increase workflow timeout manually if N >> 100).
- **Core runner runs hybrid only** in answer-only mode (no fast mode), since the goal is answer quality iteration, not retrieval comparison.

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

- External baselines: `benchmarks/{dataset}/baselines.json` — compared in PR comments
- Run history: `benchmarks/{dataset}/{variant}/history.json` — auto-committed by CI
- PR comments show comparison table (d8um vs top-3 baselines) + delta from previous run
- Only nDCG@10 has cross-system baselines; MAP/Recall/Precision are d8um-internal tracking only
- History entries include a `timing` object with `ingestionSeconds` (if seeded), `avgQueryMs`, and `totalSeconds` — added 2026-03-29; older entries only have root-level `avgQueryMs`

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

#### Procedure

**CRITICAL: Follow these steps IN ORDER. Do NOT skip steps. Do NOT push a seed benchmark until you have VERIFIED the DB is clear. Skipping verification wastes hours of LLM/DB compute.**

1. Run the clear SQL directly against Neon (see "Database Queries" section) — no need to commit a query file
2. Use `SELECT id FROM d8um_buckets WHERE name = '{bucket_name}'` in the WHERE clause (avoids hardcoding UUIDs)
3. **VERIFY the result immediately.** Check:
   - All `TRUNCATE TABLE` statements succeeded (no errors)
   - `DELETE` row counts > 0 for hashes/documents. **If 0, the hash store was NOT cleared** — investigate (wrong bucket name? bucket doesn't exist?)
   - If DELETE shows 0 rows, **DO NOT proceed to seeding.** The seed will skip all docs because hash entries still exist. Run a diagnostic query against `d8um_hashes` to check.
4. **Only after verification passes**, push a commit with `[bench:{dataset}/{variant}:seed]` to reseed
5. **Do NOT push any other commits while the seed is running.** The `concurrency: cancel-in-progress: true` setting means any push that triggers a benchmark workflow run will cancel the in-progress seed job.

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
