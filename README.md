<p align="center">
  <img src="logo-dark.png" alt="d8um" width="150" />
</p>

<p align="center">
  <strong>A context and memory SDK for your LLM agent.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#cognitive-memory">Cognitive Memory</a> &nbsp;&bull;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&bull;&nbsp;
  <a href="#packages">Packages</a> &nbsp;&bull;&nbsp;
  <a href="#guides">Guides</a> &nbsp;&bull;&nbsp;
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-first-blue?logo=typescript&logoColor=white" alt="TypeScript first" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Alpha" />
</p>

**d8um** (pronounced "datum") is a TypeScript SDK that gives AI agents both **retrieval and memory** in a single composable package. Ingest any data source, search with hybrid retrieval, and give your agent cognitive memory - episodic recall, semantic knowledge, procedural learning - without Python, without a graph database, and without stitching together a gaggle of different tools.

## Why d8um?

Building a memory-capable agent in TypeScript today means cobbling together a vector DB, a graph DB, an embedding API, a caching layer, consolidation logic, and a conversation manager. The leading frameworks (Graphiti, Mem0, MemOS) are Python-first. **TypeScript has nothing equivalent.**

d8um closes that gap:

- **Retrieval + memory in one SDK** - not two separate tools bolted together
- **TypeScript-native** - no Python runtime, no managed service, no vendor lock-in
- **Lightweight infrastructure** - runs on pgvector or SQLite. No Neo4j, no Redis, no Qdrant
- **Composable** - works alongside your stack, not inside a framework
- **Per-source embedding models** - different models for different content, merged at query time via RRF
- **Job system** - schedule memory consolidation, decay, and extraction as recurring tasks

## Quick Start

```bash
npm install @d8um/core @d8um/adapter-sqlite-vec @d8um/embedding-local
```

```ts
import { d8um } from '@d8um/core'
import { LocalEmbeddingProvider } from '@d8um/embedding-local'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'

d8um.initialize({
  embedding: new LocalEmbeddingProvider(),
  vectorStore: new SqliteVecAdapter({ dbPath: './my-app.db' }),
})

// Create a source
const faq = d8um.sources.create({ name: 'faq' })

// Ingest a document
await d8um.ingest(faq.id, {
  title: 'How do I set up SSO?',
  content: 'Navigate to Settings > Authentication and select your identity provider.',
  updatedAt: new Date(),
})

// Query - hybrid search, score merging, ranked results
const { results } = await d8um.query('how do I configure SSO?')

// Assemble into LLM-ready context
const context = d8um.assemble(results, { format: 'xml' })
```

> **More setup options:** [Local Dev](guides/Local%20Dev/getting-started.md) | [Self-Hosted (pgvector)](guides/Self%20Hosted/setup.md) | [d8um Cloud](guides/d8um%20Cloud/quickstart.md)

## Cognitive Memory

d8um is also the **first TypeScript-native cognitive memory substrate** for AI agents. Inspired by human memory systems, it adds working memory, episodic recall, semantic knowledge graphs, and procedural learning.

```ts
import { d8umMemory } from '@d8um/memory'

const memory = new d8umMemory({ memoryStore, embedding, llm, scope: { userId: 'alice' } })

await memory.addConversationTurn([
  { role: 'user', content: 'I just switched from MySQL to PostgreSQL' }
])

const facts = await memory.recallFacts('database preference')
// [{ content: 'alice uses PostgreSQL', subject: 'alice', predicate: 'uses', object: 'PostgreSQL' }]

await memory.correct('Actually, I use MariaDB now')
```

Memory operations are also schedulable jobs:

```ts
import { registerConsolidationJobs } from '@d8um/consolidation'
registerConsolidationJobs()

d8um.jobs.create({ type: 'memory_consolidation', schedule: '0 3 * * *' })
d8um.jobs.create({ type: 'memory_decay', schedule: '0 * * * *' })
```

> **Deep dive:** [Agentic Memory Guide](guides/Agentic%20Memory/overview.md) - memory types, lifecycle, extraction pipeline, landscape analysis

## How It Works

d8um queries across all sources in parallel, normalizes scores, merges via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf), and returns a unified ranked result set.

```
d8um.query("how do I configure SSO?")
        │
   ┌────┼────┐
   ▼    ▼    ▼
indexed live cached    ← per-source embedding models
   │    │    │
   └────┼────┘
        ▼
  Score Merger (RRF)
        ▼
   assemble()
        ▼
  Prompt-ready context
```

> **Deep dive:** [Agentic RAG Guide](guides/Agentic%20RAG/overview.md) - hybrid search, per-model fan-out, embedding providers, architecture

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| **Core** | | |
| [`@d8um/core`](packages/core) | Query engine, index engine, job registry, built-in jobs | Alpha |
| [`@d8um/adapter-pgvector`](packages/adapters/pgvector) | PostgreSQL + pgvector storage | Alpha |
| [`@d8um/adapter-sqlite-vec`](packages/adapters/sqlite-vec) | SQLite + sqlite-vec - zero-infra local dev | Alpha |
| [`@d8um/embedding-local`](packages/embeddings/local) | Local embeddings (bge-small-en-v1.5, MIT, ONNX) | Alpha |
| [`@d8um/hosted`](packages/hosted) | Hosted client SDK | Alpha |
| **Cognitive Memory** | | |
| [`@d8um/memory`](packages/memory) | Memory types, working memory, extraction, scoping | Alpha |
| [`@d8um/memory-graph`](packages/memory-graph) | Embedded graph - BFS/DFS traversal, no external DB | Alpha |
| [`@d8um/consolidation`](packages/consolidation) | Decay, forgetting, consolidation, correction jobs | Alpha |
| [`@d8um/mcp-server`](packages/mcp-server) | MCP tools + resources for agent frameworks | Alpha |
| [`@d8um/vercel-ai-provider`](packages/vercel-ai-provider) | Vercel AI SDK memory tools + middleware | Alpha |
| **Integrations** | | |
| [`@d8um/integration-core`](packages/integration-core) | Shared integration types (IntegrationDefinition) | Alpha |
| [`@d8um/integration-slack`](packages/integration-slack) | Messages, channels, users | Alpha |
| [`@d8um/integration-google-drive`](packages/integration-google-drive) | Files and folders | Alpha |
| [`@d8um/integration-google-calendar`](packages/integration-google-calendar) | Events | Alpha |
| [`@d8um/integration-gmail`](packages/integration-gmail) | Messages, threads, labels | Alpha |
| [`@d8um/integration-hubspot`](packages/integration-hubspot) | Contacts, companies, deals | Alpha |
| [`@d8um/integration-gong`](packages/integration-gong) | Calls, transcripts, users | Alpha |
| [`@d8um/integration-fathom`](packages/integration-fathom) | Call recordings, transcripts | Alpha |
| [`@d8um/integration-salesforce`](packages/integration-salesforce) | Contacts, accounts, opportunities, leads | Alpha |
| [`@d8um/integration-attio`](packages/integration-attio) | Contacts, companies, tasks | Alpha |
| [`@d8um/integration-linear`](packages/integration-linear) | Issues, projects, teams | Alpha |

## Guides

| Guide | What you'll learn |
|-------|-------------------|
| [Getting Started (Local Dev)](guides/Local%20Dev/getting-started.md) | Zero-infra setup with SQLite + local embeddings |
| [Self-Hosted Setup](guides/Self%20Hosted/setup.md) | pgvector, cloud embeddings, hybrid search internals |
| [d8um Cloud](guides/d8um%20Cloud/quickstart.md) | Hosted API - just an API key |
| [Agentic RAG](guides/Agentic%20RAG/overview.md) | Retrieval architecture, embedding providers, landscape analysis |
| [Agentic Memory](guides/Agentic%20Memory/overview.md) | Cognitive memory system, lifecycle, extraction, landscape analysis |

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages (Turborepo)
pnpm test             # Run tests
pnpm typecheck        # Type checking
```

## Contributing

d8um is open source and contributions are welcome - new integrations, adapters, bug fixes, or documentation.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run `pnpm build && pnpm typecheck` to verify
5. Open a PR

## License

[MIT](LICENSE)
