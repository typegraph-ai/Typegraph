# @typegraph-ai/adapter-sqlite-vec

SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec) adapter for TypeGraph. Zero-infra local development with a single-file database, WAL mode, and KNN search via sqlite-vec virtual tables.

Ideal for prototyping, local agents, CI, and environments where you don't want to run a separate database.

## Status — dev / test only

This adapter is intentionally scoped for development and testing. It implements the same identity isolation model as the pgvector adapter (so it is safe to build against), but it does **not** implement the full production feature surface.

**Supported:**
- Vector KNN search via `sqlite-vec` (brute-force; no HNSW)
- Full 5-field identity isolation: `tenantId`, `groupId`, `userId`, `agentId`, `conversationId`
- Chunk upsert / delete / count / search
- Bucket persistence with identity filters + cascading delete
- Hash store (including `getMany` batch lookup)

**Not supported (use `@typegraph-ai/adapter-pgvector` for production):**
- `hybridSearch` — no BM25 keyword search (SQLite FTS5 is not wired in)
- Source CRUD — `upsertSourceRecord`, `getSource`, `listSources`, `deleteSources`, `updateSource`, `searchWithSources`, `getChunksByRange`
- Graph / memory storage — `QuerySignals.graph` and `QuerySignals.memory` require the pgvector memory adapter
- Audit events and policy/governance tables
- Schema isolation (SQLite has no schemas)

If you call `d.query(..., { signals: { keyword: true } })` or any of the source-level APIs against this adapter, the call will either throw or silently return empty results depending on the feature. Use pgvector for anything beyond local dev.

## Install

```bash
npm install @typegraph-ai/adapter-sqlite-vec @typegraph-ai/core
```

## Usage

```ts
import { SqliteVecAdapter } from '@typegraph-ai/adapter-sqlite-vec'
import { typegraph } from '@typegraph-ai/core'

const adapter = new SqliteVecAdapter({ dbPath: './my-agent.db' })

const agent = await typegraph.initialize({
  adapter,
  // ... embedding provider, etc.
})
```

Omit `dbPath` for an in-memory database (useful for tests).

## Exports

| Export | Description |
|--------|-------------|
| `SqliteVecAdapter` | Main adapter class, implements `VectorStoreAdapter` |
| `SqliteHashStore` | Content-hash deduplication store |

## Types

| Type | Description |
|------|-------------|
| `SqliteVecAdapterConfig` | Constructor options (`dbPath`, `tablePrefix`, `hashesTable`, `bucketsTable`) |

## Related

- [TypeGraph main repo](../..)
- [Local Dev Guide](../../guides/Local%20Dev/getting-started.md)
- [`@typegraph-ai/adapter-pgvector`](../pgvector) — production adapter with full feature parity
