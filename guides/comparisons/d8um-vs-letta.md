# d8um vs Letta: Comparative SDK Analysis

## Executive Summary

**d8um** and **Letta** (formerly MemGPT) represent fundamentally different philosophies for giving AI agents memory. d8um is a composable TypeScript library that provides retrieval and cognitive memory as importable modules. Letta is a full agent runtime where agents manage their own memory through self-editing operations. This report compares both across architecture, memory capabilities, infrastructure, and use-case fit.

---

## 1. Origins and Ecosystem

| Dimension | d8um | Letta |
|---|---|---|
| **What it is** | TypeScript library (composable SDK) | Full agent runtime / framework |
| **Primary language** | TypeScript-native | Python-first (99.4%); TS SDK auto-generated via Fern |
| **Origin** | TypeScript-native design | MemGPT research paper (arXiv:2310.08560, UC Berkeley) |
| **npm package** | `@d8um/core` + composable packages | `@letta-ai/letta-client` (auto-generated client) |
| **GitHub stars** | Early-stage (alpha) | ~21.8K |
| **Funding** | N/A | $10M seed (Felicis); $70M post-money valuation |
| **License** | MIT | Apache-2.0 |
| **Managed cloud** | d8um Cloud (API key) | Letta Cloud (Free / Pro / Max / API pay-as-you-go) |
| **Self-hosted** | Yes (import as library) | Yes (Docker container running a server) |
| **Notable investors** | N/A | Jeff Dean, Clem Delangue (HuggingFace), Cristobal Valenzuela (Runway) |

**Key takeaway:** d8um is a library you import. Letta is a server you deploy. This architectural difference shapes everything else.

---

## 2. Architecture Comparison

### d8um: Composable Library

d8um runs in-process as an imported TypeScript module. No separate server, no Docker container, no REST API between your app and the memory layer. You call functions directly.

```
Your Node.js App
└── import { d8um } from '@d8um/core'
    ├── Retrieval Engine (indexed / live / cached sources)
    ├── Cognitive Memory (episodic / semantic / procedural / working)
    ├── Knowledge Graph (entity-relation triples, PPR traversal)
    ├── Job System (consolidation, decay, sync, crawl)
    └── Context Assembly (XML / markdown / plain / custom)
```

### Letta: Agent Runtime (LLM-as-OS)

Letta runs as a separate server process. Your app communicates with it over REST/gRPC. The core idea comes from the MemGPT paper: just as an OS provides virtual memory by paging between RAM and disk, Letta provides "virtual context" by paging between the LLM's context window and external storage. The agent itself controls this paging.

```
Your App ──REST──> Letta Server (Docker / Cloud)
                   └── Agent Runtime
                       ├── Agent Loop (exclusively tool-calling)
                       ├── Core Memory (in-context, agent-editable blocks)
                       ├── Archival Memory (vector-indexed, out-of-context)
                       ├── Recall Memory (searchable conversation history)
                       └── Tool System (memory ops are tool calls)
```

**Critical difference:** In d8um, your application code decides when to store/retrieve/consolidate memory. In Letta, the LLM agent decides -- memory management is delegated to the AI itself via tool calls.

---

## 3. Feature-by-Feature Comparison

### 3.1 Memory Types

| Memory Type | d8um | Letta |
|---|---|---|
| **Working memory** | Bounded buffer with priority eviction (maxItems, maxTokens) | Core Memory -- always in context, 2K char limit per block, agent-editable |
| **Episodic memory** | Timestamped events with session/sequence, participants, event types | Recall Memory -- full conversation history, searchable by date/text |
| **Semantic memory** | S-P-O triples with confidence, entity resolution, alias tracking | No structured semantic memory -- facts stored as free text in core/archival |
| **Procedural memory** | Trigger-steps pairs with success/failure counters | No explicit procedural memory |
| **Long-term storage** | Persistent via pgvector/SQLite with lifecycle management | Archival Memory -- vector-indexed, agent-managed read/write |
| **Memory structure** | Typed categories with specialized data structures | Free-form text blocks (core) + unstructured embeddings (archival) |

**Winner: d8um** for structured memory. **Letta** for the self-editing paradigm (agent controls its own memory). The approaches solve different problems: d8um provides deterministic, typed memory with lifecycle management; Letta provides flexible, agent-driven memory that adapts autonomously.

### 3.2 Memory Management Philosophy

| Aspect | d8um | Letta |
|---|---|---|
| **Who manages memory** | Application code + scheduled jobs | The LLM agent itself (via tool calls) |
| **Fact extraction** | LLM-driven pipeline with conflict resolution (ADD/UPDATE/DELETE/NOOP) | Agent decides what to store; no automated extraction pipeline |
| **Contradiction handling** | Invalidation engine: direct/temporal/superseded classification, audit trail | Agent overwrites core memory blocks; no structured contradiction tracking |
| **Consolidation** | Scheduled jobs: episodic -> semantic promotion | Context window overflow triggers automatic summary compression |
| **Decay / forgetting** | Access-frequency/age/importance decay via scheduled jobs | No automatic decay; agent can manually delete archival entries |
| **Determinism** | High -- extraction rules are explicit, lifecycle is state-machine-driven | Low -- agent behavior is unpredictable; may discard important info or fail to store critical details |

**Winner: d8um** for reliability and auditability. **Letta** for flexibility and autonomy. This is the core philosophical tradeoff.

### 3.3 Knowledge Graph

| Capability | d8um | Letta |
|---|---|---|
| **Native graph support** | Yes -- entity-relation triples stored in vector adapter | No native graph support |
| **Graph DB required** | No (graph on pgvector/SQLite) | N/A |
| **Entity extraction** | Automatic LLM-driven S-P-O extraction on ingest | None -- agent stores free text |
| **Entity resolution** | Two-tier: alias matching + vector similarity (threshold 0.85) | None |
| **Edge invalidation** | Graphiti-inspired contradiction detection | None |
| **Graph traversal** | Personalized PageRank in neural query mode | None |
| **External graph integration** | N/A (built-in) | Possible via custom tools (Graphiti, etc.) |

**Winner: d8um.** Letta has no native graph capabilities. Teams needing knowledge graphs with Letta must integrate external tools like Graphiti.

### 3.4 Retrieval & Search

| Capability | d8um | Letta |
|---|---|---|
| **Document RAG** | Yes -- full indexing, chunking, hybrid search | No built-in RAG; file attachments with basic search |
| **Vector search** | pgvector HNSW / sqlite-vec KNN | pgvector / sqlite-vec (archival memory) |
| **Keyword search (BM25)** | Yes -- PostgreSQL tsvector | No |
| **Hybrid search (RRF)** | Yes -- vector + keyword fusion | No |
| **Query modes** | 5: fast, hybrid, memory, neural, auto | 1: vector similarity (archival_memory_search) |
| **Per-source embedding models** | Yes -- different models per source, merged via RRF | No -- single embedding model |
| **Neighbor expansion** | Yes -- surrounding chunks stitched together | No |
| **Temporal queries** | Yes -- point-in-time via bi-temporal model | Recall memory searchable by date range |
| **Context assembly** | XML / markdown / plain / custom formatting | Automatic -- managed by agent loop |
| **File search** | Via integrations | Built-in: semantic search + grep over attached files |

**Winner: d8um** for retrieval depth and flexibility. Letta's retrieval is basic vector similarity; d8um offers five query modes with hybrid search, graph traversal, and multi-model fan-out.

### 3.5 Bi-Temporal Data Model

| Capability | d8um | Letta |
|---|---|---|
| **World time tracking** | Yes (validAt / invalidAt) | No |
| **System time tracking** | Yes (createdAt / expiredAt) | Timestamps on messages/memories |
| **Point-in-time queries** | Yes | No |
| **Invalidation audit trail** | Yes -- old facts preserved with invalidAt set | No -- core memory blocks are overwritten |
| **Knowledge evolution history** | Full history preserved | Conversation history preserved; memory changes are not tracked |

**Winner: d8um.** Letta does not model temporal evolution of knowledge.

### 3.6 Infrastructure & Deployment

| Dimension | d8um | Letta |
|---|---|---|
| **Deployment model** | In-process library (import and use) | Separate server (Docker container or cloud) |
| **Production DB** | PostgreSQL + pgvector | PostgreSQL + pgvector |
| **Local/dev DB** | SQLite + sqlite-vec | SQLite + sqlite-vec |
| **Graph DB required** | No | No (but no graph features either) |
| **Local embeddings** | Built-in: bge-small-en-v1.5, ONNX, MIT, no API key | No built-in local embeddings |
| **LLM requirement** | Optional (only for memory extraction + graph) | Required (core to the architecture -- the agent IS the LLM) |
| **Serverless compatible** | Yes (lightweight init, no DDL on cold start) | No (requires persistent server process) |
| **Operational overhead** | Low (library, no extra services) | Medium-High (Docker/server management, API routing) |

**Winner: d8um** for operational simplicity. d8um is a library call; Letta requires deploying and maintaining a separate server.

### 3.7 Agent Framework Integration

| Integration | d8um | Letta |
|---|---|---|
| **MCP server** | Yes (`@d8um/mcp-server`) -- 6 memory tools | Yes (MCP support for tool communication) |
| **Vercel AI SDK** | Yes (`@d8um/vercel-ai-provider`) -- tools + middleware | Yes (`@letta-ai/vercel-ai-sdk-provider`) |
| **LangChain** | No built-in | Yes (tool import support) |
| **CrewAI** | No | Yes (tool import support) |
| **Composio** | No | Yes (500+ external tool integrations) |
| **Agent Development Environment** | No | Yes (ADE -- visual building, monitoring, debugging) |
| **Multi-agent** | Not built-in (composable per-agent instances) | Yes (agents can create/invoke other agents) |

**Winner: Letta** for agent framework features. It is a full runtime with multi-agent support, visual tooling, and broad framework integrations.

### 3.8 Data Source Integrations

| Capability | d8um | Letta |
|---|---|---|
| **Built-in connectors** | 11: Slack, Gmail, Google Calendar, Google Drive, HubSpot, Salesforce, Attio, Linear, Gong, Fathom | None (file attachments only) |
| **Web crawling** | Built-in: URL scrape, domain BFS crawl | No |
| **Sync modes** | Full + incremental per integration | N/A |
| **Job system** | Schedulable sync, consolidation, decay, crawl | Scheduled messages to agents (not data sync jobs) |

**Winner: d8um.** Letta has no data ingestion pipeline.

### 3.9 TypeScript Experience

| Dimension | d8um | Letta |
|---|---|---|
| **SDK origin** | Built natively in TypeScript | Auto-generated from OpenAPI spec via Fern |
| **Type safety** | Full generics, structural typing, composable interfaces | Generated types (correct but not idiomatic) |
| **API style** | Direct function calls (in-process) | HTTP client wrapping REST API calls |
| **Package design** | Modular monorepo (@d8um/core, @d8um/graph, etc.) | Single client package (@letta-ai/letta-client) |
| **Async patterns** | Native async/await, no network overhead | Async/await over HTTP (latency per call) |
| **Local development** | Zero external dependencies possible (SQLite + local embeddings) | Requires running Letta server (Docker) |

**Winner: d8um.** Native TypeScript with in-process calls vs auto-generated HTTP client wrappers.

### 3.10 Multi-Tenancy & Scoping

| Dimension | d8um | Letta |
|---|---|---|
| **Scope levels** | 5: tenantId, groupId, userId, agentId, sessionId | Per-agent isolation (each agent has its own memory) |
| **Shared memory** | Subset filtering across scope levels | Sleep-time agents can share memory blocks with primary agents |
| **Organization isolation** | tenantId for org-level | Managed at server/cloud level |

**Winner: d8um** for multi-tenant flexibility. Letta's memory is per-agent; sharing requires explicit architectural patterns.

---

## 4. What d8um Does That Letta Doesn't

1. **Unified RAG + memory** -- Document ingestion, chunking, hybrid search alongside cognitive memory. Letta has no RAG pipeline.
2. **Structured semantic memory** -- S-P-O triples with confidence scores, entity resolution, alias tracking. Letta stores free text only.
3. **Procedural memory** -- Trigger-steps pairs with success/failure tracking. Letta has no equivalent.
4. **Native knowledge graph** -- Entity-relation graph with PPR traversal, no external graph DB. Letta has no graph support.
5. **Bi-temporal data model** -- World time + system time, point-in-time queries, invalidation audit trails.
6. **5 query modes** -- fast, hybrid, memory, neural, auto with explicit cost/depth tradeoffs.
7. **Hybrid search (BM25 + vector + RRF)** -- Keyword and semantic search fused together.
8. **Per-source embedding models** -- Different models per data source merged at query time.
9. **Memory lifecycle state machine** -- pending/active/consolidated/archived/expired/invalidated.
10. **Scheduled consolidation and decay** -- Automated episodic-to-semantic promotion and importance decay.
11. **11 data source integrations** -- Slack, Gmail, Google Drive, CRM, call recording tools.
12. **Built-in local embeddings** -- MIT-licensed ONNX model, zero API keys.
13. **In-process library** -- No server to deploy, serverless-compatible.
14. **Contradiction detection** -- LLM-driven invalidation engine classifying conflicts as direct/temporal/superseded.
15. **Deterministic memory operations** -- Application-controlled, auditable, predictable.

## 5. What Letta Does That d8um Doesn't

1. **Agent self-editing memory** -- The LLM autonomously decides what to remember, forget, and update. This is Letta's core innovation from the MemGPT paper.
2. **Full agent runtime** -- Complete agent loop with tool calling, reasoning, and persistent state. d8um is a library, not a runtime.
3. **Virtual context management** -- OS-inspired paging between context window and storage, with automatic conversation summarization on overflow.
4. **Multi-agent orchestration** -- Agents can create, invoke, and coordinate with other agents natively.
5. **Agent Development Environment (ADE)** -- Visual UI for building, monitoring, and debugging agents.
6. **500+ tool integrations via Composio** -- Pre-built connections to external services.
7. **Agent portability** -- `.af` (Agent File) format for importing/exporting agents between environments.
8. **Sleep-time agents** -- Background agents that process and enrich memory while the primary agent is idle.
9. **Agent scheduling** -- Schedule messages to agents for future execution.
10. **Conversation-as-tool paradigm** -- Even `send_message` is a tool call, giving agents full control over their interaction patterns.
11. **LangChain/CrewAI tool compatibility** -- Import tools from other frameworks directly.
12. **Model leaderboard** -- Published benchmarks for which LLMs work best with Letta's agent loop.
13. **Academic foundation** -- MemGPT paper (arXiv:2310.08560) is widely cited and established the virtual context paradigm.

---

## 6. Use-Case Recommendations

### Choose d8um when:

| Use Case | Why d8um |
|---|---|
| **TypeScript/Node.js stack** | Native TS, not auto-generated wrappers over HTTP |
| **RAG + memory in one SDK** | Don't want separate systems for retrieval and memory |
| **Serverless / edge deployment** | In-process library, no server dependency |
| **Deterministic memory behavior** | Need predictable, auditable memory operations |
| **Knowledge graph without Neo4j** | Built-in graph on pgvector/SQLite |
| **Temporal reasoning** | Bi-temporal model with point-in-time queries |
| **Data source ingestion** | Pull from Slack, Gmail, CRM into the same memory layer |
| **Multi-tenant applications** | 5-level scoping (tenant/group/user/agent/session) |
| **Minimal infrastructure** | Library import + Postgres or SQLite, nothing else |
| **Structured memory types** | Need episodic/semantic/procedural with lifecycle management |

### Choose Letta when:

| Use Case | Why Letta |
|---|---|
| **Autonomous agents** | Want the agent to manage its own memory without application logic |
| **Full agent framework needed** | Need runtime, tool calling, reasoning, and memory in one platform |
| **Multi-agent systems** | Agents creating and coordinating with other agents |
| **Visual agent development** | ADE provides UI for building and debugging agents |
| **Python-primary stack** | Python SDK is first-class; extensive Python ecosystem |
| **Agent portability** | Export/import agents between environments via .af files |
| **Existing tool ecosystem** | Need Composio, LangChain, or CrewAI tool integrations |
| **Sleep-time processing** | Background agents enriching memory between interactions |
| **Research/experimentation** | Well-studied architecture with published papers and benchmarks |
| **Long-running conversational agents** | Virtual context management handles unbounded conversations |

---

## 7. Maturity & Risk Assessment

| Dimension | d8um | Letta |
|---|---|---|
| **Maturity** | Alpha | Production (v0.16.6, 175 releases) |
| **Breaking changes risk** | High (alpha) | Medium (rapid versioning with occasional breaking changes) |
| **Community size** | Small | Medium (~21.8K stars, 158 contributors) |
| **Documentation** | Comprehensive guides | Comprehensive docs site + ADE |
| **Known issues** | Early-stage | Local/open LLM support is buggy; Desktop app hangs; Ollama regressions |
| **Benchmark scores** | Not independently benchmarked | ~83.2% LongMemEval (third-party); 74.0% LoCoMo |
| **Published research** | No | MemGPT paper (arXiv:2310.08560), widely cited |
| **Lock-in risk** | Low (composable library) | High (full runtime -- switching means rewriting agent infrastructure) |
| **LLM dependency** | Optional (only for extraction/graph) | Fundamental (agent IS the LLM, memory management requires strong instruction-following) |

---

## 8. Summary Verdict

**d8um and Letta are not interchangeable -- they solve different problems.**

**d8um is a composable memory and retrieval library.** You import it, call functions, and get deterministic, structured memory with lifecycle management. It fits into your existing architecture without requiring a runtime change. Best for teams that want full control over memory behavior, need retrieval + memory unified, and are building in TypeScript.

**Letta is a complete agent runtime built on the virtual context paradigm.** The agent manages its own memory, which enables powerful autonomous behavior but sacrifices predictability. It requires deploying a server and adopting its agent model. Best for teams building autonomous, long-running agents that need to manage unbounded context and coordinate across multi-agent systems.

| If you need... | Choose |
|---|---|
| A memory library to add to your existing app | **d8um** |
| A full agent runtime from scratch | **Letta** |
| Deterministic, auditable memory operations | **d8um** |
| Agent-driven autonomous memory management | **Letta** |
| TypeScript-native with minimal infrastructure | **d8um** |
| Multi-agent orchestration with visual tooling | **Letta** |
| RAG + memory unified | **d8um** |
| Knowledge graph without extra infrastructure | **d8um** |
| Long-running conversational agents with virtual context | **Letta** |
| Serverless / edge deployment | **d8um** |

---

*Analysis generated March 2026. Letta v0.16.6 (TS SDK v1.7.12+). d8um at alpha stage.*
