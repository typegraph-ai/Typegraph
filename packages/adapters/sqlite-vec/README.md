# @d8um/adapter-sqlite-vec

SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec) adapter for d8um. Zero-infra local development with a single-file database, WAL mode, and KNN search via sqlite-vec virtual tables.

Ideal for prototyping, local agents, and environments where you don't want to run a separate database.

## Install

```bash
npm install @d8um/adapter-sqlite-vec @d8um/core
```

## Usage

```ts
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'
import { d8um } from '@d8um/core'

const adapter = new SqliteVecAdapter({ dbPath: './my-agent.db' })

const agent = await d8um.initialize({
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
| `SqliteVecAdapterConfig` | Constructor options (`dbPath`, `tablePrefix`, `hashesTable`) |

## Related

- [d8um main repo](../..)
- [Local Dev Guide](../../guides/Local%20Dev/getting-started.md)
