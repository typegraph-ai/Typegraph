# d8um vs Mem0: Comparative SDK Analysis

## Executive Summary

**d8um** and **Mem0** are both memory-layer SDKs for AI agents, but they occupy different design points. Mem0 is a Python-first "universal memory layer" that later shipped a Node.js/TypeScript SDK (`mem0ai` on npm). d8um is a TypeScript-native SDK that unifies retrieval (RAG) and cognitive memory in a single package. This report compares both TypeScript SDKs head-to-head across architecture, features, infrastructure requirements, and use-case fit.

---

## 1. Origins and Ecosystem

| Dimension | d8um | Mem0 (TypeScript SDK) |
|---|---|---|
| **Primary language** | TypeScript-native | Python-first; TS SDK is a port |
| **npm package** | `@d8um/core` + composable packages | `mem0ai` (single package) |
| **GitHub stars** | Early-stage (alpha) | ~51.2K |
| **Funding** | N/A | $24M (October 2025) |
| **License** | MIT | Apache 2.0 |
| **Managed cloud** | d8um Cloud (API key) | Mem0 Platform (Free / Standard $19/mo / Pro $249/mo) |
| **Notable adopters** | Early-stage | Netflix, Lemonade, Rocket Money |
| **Self-hosted** | Yes (Postgres/SQLite) | Yes (bring your own infra) |

**Key takeaway:** Mem0 has a far larger community and ecosystem. d8um is newer but was built from the ground up in TypeScript rather than ported, which shows in API ergonomics and type safety.

---

## 2. Architecture Comparison

### d8um: Unified RAG + Memory

d8um treats retrieval and memory as a single continuum. The same `d8um` instance handles document ingestion, hybrid search, knowledge graph traversal, and cognitive memory operations. A shared adapter layer, embedding infrastructure, and job system underlies everything.

```
d8um instance
├── Retrieval Engine (indexed / live / cached sources)
├── Cognitive Memory (episodic / semantic / procedural / working)
├── Knowledge Graph (entity-relation triples, PPR traversal)
├── Job System (consolidation, decay, sync, crawl)
└── Context Assembly (XML / markdown / plain / custom)
```

### Mem0: Memory-Focused Layer

Mem0 is a dedicated memory layer. It does not include document retrieval / RAG capabilities. You use Mem0 alongside a separate RAG tool (LangChain, LlamaIndex, etc.).

```
Mem0 Memory instance
├── Memory CRUD (add / search / update / delete)
├── Vector Store (semantic search)
├── Graph Memory (entity extraction + graph backend) [optional]
├── Memory Compression
└── History Tracking (SQLite / Supabase)
```

**Key takeaway:** d8um is a "retrieval + memory" all-in-one. Mem0 is memory-only and expects you to bring your own RAG pipeline.

---

## 3. Feature-by-Feature Comparison

### 3.1 Memory Types

| Memory Type | d8um | Mem0 TS SDK |
|---|---|---|
| **Working memory** | Yes - bounded buffer with priority eviction, configurable capacity (maxItems, maxTokens) | No built-in equivalent |
| **Episodic memory** | Yes - timestamped events with session/sequence tracking, participants, event types | Partially - memories are timestamped but lack structured episode modeling |
| **Semantic memory** | Yes - S-P-O triples with confidence scores, entity resolution, alias tracking | Yes - extracted facts, but less structured (no explicit S-P-O triples in TS SDK) |
| **Procedural memory** | Yes - trigger-steps pairs with success/failure counters | No |
| **Memory categories** | Explicit `MemoryCategory` enum with specialized data structures per type | Flat - all memories are stored uniformly |

**Winner: d8um.** The cognitive memory taxonomy (working, episodic, semantic, procedural) is significantly richer than Mem0's flat memory model.

### 3.2 Memory Lifecycle

| Capability | d8um | Mem0 TS SDK |
|---|---|---|
| **Status state machine** | Yes - pending -> active -> consolidated -> archived -> expired; also invalidated path | No explicit lifecycle states |
| **Consolidation** | Yes - episodic memories promoted to semantic facts via scheduled jobs | Memory compression (reduces token usage ~80%) |
| **Decay** | Yes - access-frequency/age/importance-based decay, configurable via jobs | No |
| **Forgetting** | Yes - archived below threshold, still queryable with flag | Manual delete only |
| **Bi-temporal model** | Yes - world time (validAt/invalidAt) + system time (createdAt/expiredAt) | No - single timestamp only |
| **Contradiction handling** | LLM-driven invalidation engine (direct/temporal/superseded classification) | LLM updates existing memories, but no explicit invalidation audit trail |

**Winner: d8um.** The lifecycle management is substantially more sophisticated - bi-temporal tracking, scheduled consolidation/decay, and contradiction handling with full audit trails.

### 3.3 Retrieval & Search

| Capability | d8um | Mem0 TS SDK |
|---|---|---|
| **Document RAG** | Yes - full indexing, chunking, hybrid search | No - memory search only |
| **Vector search** | Yes (pgvector HNSW / sqlite-vec KNN) | Yes (25+ vector DB providers) |
| **Keyword search (BM25)** | Yes - PostgreSQL tsvector integration | No |
| **Hybrid search (RRF)** | Yes - vector + keyword fusion via Reciprocal Rank Fusion | No |
| **Graph traversal** | Personalized PageRank (PPR) on built-in knowledge graph | Graph search via Neo4j/Memgraph/Neptune/Kuzu/AGE (Pro tier on cloud) |
| **Query modes** | 5 modes: fast, hybrid, memory, neural, auto | Single mode: semantic similarity |
| **Per-source embedding models** | Yes - different models per source, merged via RRF | No - single embedding model |
| **Neighbor expansion** | Yes - surrounding chunks stitched with truncation markers | No |
| **Temporal queries** | Yes - point-in-time via `temporalAt` | No |
| **Source types** | indexed / live / cached with TTL | N/A (no document sources) |

**Winner: d8um** for retrieval breadth. **Mem0** wins on vector store diversity (25+ backends vs 2 adapters).

### 3.4 Knowledge Graph

| Capability | d8um | Mem0 TS SDK |
|---|---|---|
| **Graph storage** | Built into vector store (pgvector/SQLite) - no separate graph DB | Requires external graph DB (Neo4j, Memgraph, Neptune, Kuzu, Apache AGE) |
| **Entity extraction** | LLM-driven S-P-O triple extraction | LLM-driven entity + relationship extraction |
| **Entity resolution** | Two-tier: alias matching (cheap) + vector similarity (expensive, threshold 0.85) | Basic entity merging |
| **Edge invalidation** | Graphiti-inspired contradiction detection (direct/temporal/superseded) | No explicit edge invalidation |
| **Graph traversal** | Personalized PageRank integrated into neural query mode | Parallel graph search alongside vector results |
| **Infrastructure** | No separate graph DB needed | Requires Neo4j or similar |
| **TS SDK maturity** | First-class | Known bug: `MemoryGraph.structuredLlm` hardcoded to OpenAI, breaks non-OpenAI providers |

**Winner: d8um** for infrastructure simplicity and deeper graph features. **Mem0** for graph backend diversity (if you already run Neo4j).

### 3.5 Infrastructure & Storage

| Dimension | d8um | Mem0 TS SDK |
|---|---|---|
| **Production DB** | PostgreSQL + pgvector | 25+ vector DBs (Qdrant, Pinecone, Milvus, pgvector, Chroma, etc.) |
| **Local/dev DB** | SQLite + sqlite-vec (zero-infra) | In-memory vector store or local config |
| **Graph DB required** | No (graph stored in vector adapter) | Yes (for graph memory) |
| **Redis/cache required** | No | No |
| **Local embeddings** | Built-in: bge-small-en-v1.5, ONNX, ~32MB, MIT license, no API key | No built-in local embeddings |
| **Embedding providers** | 40+ via Vercel AI SDK structural typing | OpenAI, Ollama, Gemini, HuggingFace |
| **LLM providers** | Any (structural typing) | OpenAI, Anthropic, Groq, Gemini, Ollama |

**Winner: Mem0** for vector store breadth (25+ backends). **d8um** for minimal infrastructure requirements and local-first development.

### 3.6 Agent Framework Integration

| Integration | d8um | Mem0 TS SDK |
|---|---|---|
| **MCP server** | Yes (`@d8um/mcp-server`) - 6 tools: remember, recall, recall_facts, forget, correct, add_conversation | OpenMemory MCP Server (local-first, dashboard UI, works with Cursor/VS Code/Claude Desktop) |
| **Vercel AI SDK** | Yes (`@d8um/vercel-ai-provider`) - memory tools + auto-context middleware | Yes (`@mem0/vercel-ai-provider`) |
| **LangChain** | No built-in integration | Yes (Python; limited TS) |
| **CrewAI** | No | Yes (Python) |
| **OpenAI Agents SDK** | No | Yes (Python) |

**Winner: Tie.** d8um has better TypeScript-native integrations (MCP, Vercel AI). Mem0 has broader Python ecosystem integrations.

### 3.7 Data Source Integrations

| Capability | d8um | Mem0 TS SDK |
|---|---|---|
| **Built-in connectors** | 11: Slack, Gmail, Google Calendar, Google Drive, HubSpot, Salesforce, Attio, Linear, Gong, Fathom, + integration-core | None - memory-only, no data ingestion connectors |
| **Web crawling** | Built-in: URL scrape job, domain BFS crawl, HTML-to-markdown | No |
| **Sync modes** | Full sync + incremental sync per integration | N/A |
| **Job system** | Yes - schedulable jobs for sync, consolidation, decay, crawl | No job system |

**Winner: d8um.** This is not a close comparison - Mem0 has no data ingestion pipeline at all.

### 3.8 API Ergonomics (TypeScript)

**d8um:**
```ts
import { d8umCreate } from '@d8um/core'
import { createGraphBridge } from '@d8um/graph'

const d = await d8umCreate({ vectorStore, embedding, llm, graph })

// Memory
await d.remember('Alice prefers PostgreSQL', { userId: 'alice' })
await d.correct('Alice switched to MySQL', { userId: 'alice' })
const facts = await d.recallFacts('database preference', { userId: 'alice' })

// Retrieval
const { results } = await d.query('SSO configuration', { mode: 'hybrid' })
const context = d.assemble(results, { format: 'xml' })

// Jobs
d.jobs.create({ type: 'memory_consolidation', schedule: '0 3 * * *' })
```

**Mem0:**
```ts
import { Memory } from 'mem0ai/oss'

const memory = new Memory({
  llm: { provider: 'openai', config: { apiKey, model: 'gpt-4-turbo' } },
  vectorStore: { provider: 'memory', config: { collectionName: 'test', dimension: 1536 } },
  embedder: { provider: 'openai', config: { apiKey, model: 'text-embedding-3-small' } },
})

await memory.add([{ role: 'user', content: 'I prefer PostgreSQL' }], { userId: 'alice' })
const results = await memory.search('database preference', { userId: 'alice' })
await memory.update('memory-id', 'Updated content')
await memory.delete('memory-id')
```

**d8um advantages:** Richer API surface (remember, correct, recallFacts, recallEpisodes, recallProcedures, assembleContext). Composable package design. Full TypeScript generics.

**Mem0 advantages:** Simpler API (add/search/update/delete). Lower learning curve. Single package install.

### 3.9 Multi-Tenancy & Scoping

| Dimension | d8um | Mem0 TS SDK |
|---|---|---|
| **Scope levels** | 5: tenantId, groupId, userId, agentId, sessionId | 3: userId, agentId, runId (+ metadata filters) |
| **Scope model** | Per-call identity (Segment-style), subset filtering | Per-call identity |
| **Organization isolation** | tenantId + groupId for team-level sharing | organizationId + projectId (platform mode) |

**Winner: d8um.** More granular scoping with 5 hierarchical levels vs 3.

---

## 4. What d8um Does That Mem0 Doesn't

1. **Unified RAG + Memory** - Document ingestion, chunking, hybrid search, and context assembly alongside memory. Mem0 is memory-only.
2. **Working memory** - Bounded in-memory buffer with priority eviction for conversation context.
3. **Procedural memory** - Learned trigger-steps patterns with success/failure tracking.
4. **Bi-temporal data model** - World time + system time on every record. Point-in-time queries.
5. **5 query modes** - fast, hybrid, memory, neural, auto with explicit latency/depth tradeoffs.
6. **Hybrid search (BM25 + vector)** - Keyword + semantic search fused via RRF.
7. **Personalized PageRank** - Graph traversal integrated into retrieval, not just parallel lookup.
8. **Per-source embedding models** - Different embedding models per data source, merged at query time.
9. **Job system** - Schedulable consolidation, decay, sync, and crawl jobs.
10. **11 data source integrations** - Slack, Gmail, Google Drive, CRM tools, call recording, etc.
11. **Built-in local embeddings** - MIT-licensed ONNX model, no API keys needed.
12. **Graph without graph DB** - Knowledge graph on top of pgvector/SQLite, no Neo4j required.
13. **Neighbor chunk expansion** - Surrounding chunks from same document stitched into results.
14. **Context assembly** - Format results into XML/markdown/plain for LLM consumption.
15. **Memory lifecycle state machine** - pending/active/consolidated/archived/expired/invalidated.
16. **MCP server** - Native Model Context Protocol tools for agent frameworks.

## 5. What Mem0 Does That d8um Doesn't

1. **25+ vector store backends** - Qdrant, Pinecone, Milvus, Chroma, Weaviate, Redis, Elasticsearch, MongoDB, Faiss, etc. d8um supports only pgvector and SQLite.
2. **5+ graph DB backends** - Neo4j, Memgraph, Neptune, Kuzu, Apache AGE. d8um uses its own graph-on-vector approach.
3. **Managed cloud with tiered pricing** - Free, Standard ($19/mo), Pro ($249/mo) with usage-based scaling. d8um Cloud exists but is less mature.
4. **Batch operations** - `batchUpdate()`, `batchDelete()` for bulk memory management.
5. **User management API** - `users()`, `deleteUsers()` for platform-level user management.
6. **Memory compression** - Automatic chat history compression (~80% token reduction).
7. **Broader Python ecosystem integrations** - LangChain, CrewAI, OpenAI Agents SDK, AutoGen (all Python-first but available).
8. **Custom prompts** - `customPrompt` config option to override the system prompt used for memory extraction.
9. **Larger community** - ~48K GitHub stars, more tutorials, more third-party integrations, more battle-tested.
10. **History store flexibility** - Supabase, SQLite, or custom providers for memory audit logs.
11. **OpenMemory Chrome Extension** - Cross-tool memory sharing across ChatGPT, Claude, Perplexity, Grok, Gemini directly in the browser.
12. **OpenMemory MCP Server** - Local-first memory layer with built-in dashboard UI (localhost:3000), compatible with Cursor, VS Code, Claude Desktop, Cline, Windsurf.
13. **Enterprise features** - SOC 2 & HIPAA compliant, BYOK encryption on managed platform.
14. **Published research** - arxiv paper (2504.19413) backing the approach with benchmark results.

---

## 6. Use-Case Recommendations

### Choose d8um when:

| Use Case | Why d8um |
|---|---|
| **TypeScript/Node.js agent stack** | Native TS with full type safety, not a Python port |
| **RAG + memory in one SDK** | Don't want to stitch together LangChain + Mem0 |
| **Minimal infrastructure** | Postgres+pgvector or SQLite only - no Neo4j, no Redis, no Qdrant |
| **Local/offline development** | Built-in local embeddings + SQLite, zero API keys needed |
| **Complex memory modeling** | Need working/episodic/semantic/procedural memory with lifecycle management |
| **Temporal reasoning** | Bi-temporal queries, contradiction tracking, point-in-time recall |
| **Data source ingestion** | Need to pull from Slack, Gmail, CRM, call tools into the same memory layer |
| **Multi-hop retrieval** | Neural mode with PPR graph traversal for associative reasoning |
| **MCP-based agents** | First-class MCP server with 6 memory tools |

### Choose Mem0 when:

| Use Case | Why Mem0 |
|---|---|
| **Quick prototyping** | Simpler API, single `npm install`, lower learning curve |
| **Existing vector DB** | Already running Qdrant/Pinecone/Weaviate/etc. and want to use it |
| **Managed service preferred** | Mem0 Platform with tiered pricing, no infrastructure to manage |
| **Python-heavy stack** | Primary codebase is Python with some Node.js microservices |
| **Large community / support** | More tutorials, more StackOverflow answers, larger Discord |
| **Existing Neo4j deployment** | Can plug graph memory directly into your graph DB |
| **Simple memory needs** | Just need add/search/update/delete without complex lifecycle |
| **Batch operations** | Need bulk update/delete across many memories |

---

## 7. Maturity & Risk Assessment

| Dimension | d8um | Mem0 TS SDK |
|---|---|---|
| **Maturity** | Alpha | Production (v2.2+) |
| **Breaking changes risk** | High (alpha) | Low-medium |
| **Community size** | Small | Large (~48K stars) |
| **Documentation** | Comprehensive guides | Comprehensive docs site |
| **Known TS SDK bugs** | Early-stage, fewer reported | Graph memory hardcoded to OpenAI; static Ollama require breaks non-Ollama apps |
| **Benchmark scores** | Not independently benchmarked yet | 49% on LongMemEval (vs OMEGA 95.4%, Letta 83.2%) |
| **Published research** | No | arxiv 2504.19413 |

---

## 8. Summary Verdict

**d8um is the more capable and architecturally ambitious SDK.** It offers unified RAG + memory, richer cognitive memory types, sophisticated lifecycle management, and lighter infrastructure requirements. It is the better choice for TypeScript-native projects that need a comprehensive agent memory and retrieval system.

**Mem0 is the safer and more proven choice.** It has a massive community, more storage backends, a mature managed platform, and a simpler API. It is the better choice for teams that want a straightforward memory layer they can integrate into an existing RAG stack.

If you are building in TypeScript and want one SDK for both retrieval and memory with deep cognitive capabilities: **d8um**.
If you want a battle-tested memory layer with maximum backend flexibility and managed hosting: **Mem0**.

---

*Analysis generated March 2026. Mem0 TS SDK version ~2.2.x. d8um at alpha stage.*
