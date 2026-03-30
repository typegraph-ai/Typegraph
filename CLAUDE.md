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

Claude Code runs in a sandboxed environment with **no outbound network access** except to GitHub (github.com, api.github.com). All external services (Neon DB, AI Gateway, Vercel Blob, npm registry for installs) are unreachable from the sandbox.

**You cannot run benchmarks or database queries directly.** Use the CI workflows described below.

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
| core    | 15 min      | 60 min    | 30 min      |
| neural  | 30 min      | 360 min   | 30 min      |
| core (multihop-rag) | 90 min | 120 min | 30 min |
| neural (multihop-rag) | 180 min | 360 min | 30 min |

### Workflow File

`.github/workflows/benchmarks.yml` — Locked to actors `fIa5h` and `claude` only.

## Database Queries

Database queries are executed via a GitHub Actions proxy workflow. You push a SQL file, the workflow runs it against Neon, and commits the result back.

### How to Query

1. Create a folder under `db-queries/` with a descriptive name (e.g., `db-queries/check-tables/`)
2. Write a `query.sql` file in that folder
3. Commit and push — the `db-inspect` workflow triggers automatically
4. Wait for the workflow to complete, then pull or read `db-queries/<folder>/result.json` from the repo

### Example

```sql
-- db-queries/list-tables/query.sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
```

The workflow will commit `db-queries/list-tables/result.json` with the query output in CSV format.

### Reading Results

After pushing, pull the branch to get the result file, or use GitHub MCP tools to read the file contents directly from the repo.

### Workflow File

`.github/workflows/db-inspect.yml` — Locked to actors `fIa5h` and `claude` only. Has `contents: write` permission to push results back.

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
- `--eval-answers-only`: Run ONLY the answer eval subset — queries just the gold-answer subset, skips IR metrics. Much faster.
- `--eval-answers-limit=N`: Limit answer evaluation to N queries
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

### DB Query Workflow Gotchas

- **`[skip ci]` prevents ALL workflows** including db-inspect — never use it on query pushes
- **Empty commits won't trigger** — the `query.sql` file must appear in the commit diff (HEAD~1 vs HEAD)
- Results are committed back as `db-queries/{name}/result.json`
- The workflow may push results while you're working — pull before pushing to avoid rejected pushes

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

**When to clear:** Before reseeding a benchmark with changed chunk size, embedding model, or ingestion config. The hash store will skip unchanged content, so just running `--seed` again won't re-chunk with new settings.

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

#### Procedure

1. Write SQL to `db-queries/clear-{name}/query.sql` using the templates above
2. Use `SELECT id FROM d8um_buckets WHERE name = '{bucket_name}'` in the WHERE clause (avoids hardcoding UUIDs)
3. Commit and push (do NOT use `[skip ci]`) — wait for `result.json`
4. Verify all statements show `TRUNCATE TABLE` or `DELETE N`
5. Then push a commit with `[bench:{dataset}/{variant}:seed]` to reseed

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
- **Answer-only mode is essential for iteration.** Running all 2255 retrieval queries (90-180min) just to test a different answer-gen model is wasteful. `--eval-answers-only` queries just the answer subset in ~30min.
- **Gold answers require a separate seeding pipeline.** MultiHopRAG HuggingFace data has answers in the queries parquet, but they need separate extraction and upload to Vercel Blob as `answers.json`.
