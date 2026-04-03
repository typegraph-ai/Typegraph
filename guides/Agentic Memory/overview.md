# Cognitive Memory with d8um

## Why Agents Need Memory

Retrieval gives an agent access to external knowledge. Memory gives it the ability to _learn from experience_.

Without memory, every conversation starts from zero. The agent cannot remember that a user prefers PostgreSQL over MySQL, that a previous debugging session revealed a specific root cause, or that a particular API call pattern reliably fails. It cannot build relationships between facts over time, consolidate repeated observations into stable knowledge, or forget information that is no longer true.

Human cognition solves this with multiple, specialized memory systems working in concert. AI agents need the same architecture -- not a single key-value store, but a structured system that can capture episodes, extract facts, learn procedures, resolve contradictions, and manage the lifecycle of knowledge over time.

## The Cognitive Science Foundation

d8um's memory system draws on established models from cognitive science and neuroscience:

**Atkinson-Shiffrin model (1968)** introduced the multi-store framework: sensory memory, short-term (working) memory, and long-term memory. Working memory has limited capacity and acts as a processing buffer; long-term memory is vast but requires encoding and retrieval. d8um implements this with a bounded `WorkingMemory` buffer and persistent long-term storage.

**Tulving's taxonomy (1972)** distinguished episodic memory (autobiographical events with temporal context) from semantic memory (general knowledge and facts). Later work added procedural memory (learned skills and patterns). d8um implements all three as distinct `MemoryCategory` types with specialized data structures for each.

**Complementary Learning Systems theory (CLS)** (McClelland et al., 1995) explains how the hippocampus rapidly encodes episodic experiences while the neocortex slowly consolidates them into stable semantic knowledge. d8um mirrors this with its extraction pipeline (fast episodic capture) and consolidation system (gradual promotion to semantic facts).

## How d8um Implements Each Memory Type

### Working Memory

A bounded in-memory buffer inspired by cognitive science's capacity limits. Items are stored with a priority score and evicted by lowest priority first, then oldest first, when capacity is exceeded.

```ts
const memory = new d8umMemory({ memoryStore, embedding, llm })

// Add items to working memory with priority
memory.working.add('User is debugging a PostgreSQL connection issue', 'system', 5)
memory.working.add('Error log shows timeout at connection pool', 'tool', 3)

// Working memory is included in context assembly by default
const context = await memory.assembleContext('database connection')
```

Working memory supports configurable capacity (`maxItems`, `maxTokens`) and a custom tokenizer. It serializes directly to LLM-ready context strings.

### Episodic Memory

Timestamped records of events with full conversational context. Each episode captures who was involved, which session it belongs to, and its ordering within that session.

```ts
// Ingest a conversation turn -- creates episodic memory automatically
await memory.addConversationTurn([
  { role: 'user', content: 'I just switched from MySQL to PostgreSQL at work' },
  { role: 'assistant', content: 'PostgreSQL is a great choice. Do you need help with migration?' }
])

// Recall episodes by semantic similarity
const episodes = await memory.recallEpisodes('database migration')
```

Episodic memories include `eventType` (conversation, observation, action, tool trace), `participants`, `sessionId`, and `sequence` for temporal ordering. They can be consolidated into semantic facts over time.

### Semantic Memory

Extracted knowledge represented as subject-predicate-object triples (facts), entities with typed properties and aliases, and edges representing relationships between entities.

```ts
// Facts are extracted automatically from conversations
const facts = await memory.recallFacts('database preference')
// [{ content: 'Alice uses PostgreSQL', subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' }]

// Direct storage is also supported
await memory.remember('The API rate limit is 1000 requests per minute', 'semantic')
```

Semantic facts track `confidence` (LLM-judged), `sourceMemoryIds` (linking back to the episodes they were extracted from), and full bi-temporal timestamps.

### Procedural Memory

Learned procedures captured as trigger-steps pairs with success/failure tracking:

```ts
const procedures = await memory.recallProcedures('deploy to production')
// [{
//   trigger: 'production deployment requested',
//   steps: ['Run test suite', 'Build Docker image', 'Push to registry', 'Update k8s manifests'],
//   successCount: 12,
//   failureCount: 1,
//   lastOutcome: 'success'
// }]
```

## The Bi-Temporal Data Model

Inspired by Graphiti's temporal knowledge graph (arXiv:2501.13956) and Snodgrass's temporal database theory (1999), every memory record in d8um carries two independent timelines:

| Timeline | Fields | Meaning |
|----------|--------|---------|
| **World time** | `validAt`, `invalidAt` | When the fact became true / stopped being true in the real world |
| **System time** | `createdAt`, `expiredAt` | When the record was ingested / superseded in the system |

This separation enables point-in-time queries ("what did we know as of January 1st?") and preserves the full history of knowledge evolution. When a fact is contradicted, the old record is invalidated (not deleted) -- `invalidAt` is set, preserving the audit trail.

```ts
// Point-in-time query
const results = await memory.recall('database preference', {
  asOf: new Date('2025-06-01'),
})
```

## MemoryStatus Lifecycle

Every memory record follows a state machine governing its lifecycle:

```
pending --> active --> consolidated --> archived --> expired
                  \-> invalidated --> expired
                  \-> archived --> active (reactivation)
```

| Status | Meaning |
|--------|---------|
| `pending` | Created but not yet embedded/processed |
| `active` | Processed and available for retrieval |
| `consolidated` | Episodic memory promoted to semantic (still queryable, lower priority) |
| `invalidated` | Contradicted by newer fact (preserved for history, excluded from default queries) |
| `archived` | Decayed below threshold (queryable with `includeArchived` flag) |
| `expired` | End of lifecycle (audit trail only) |

Status transitions are validated -- the system enforces that only legal transitions occur (e.g., you cannot go from `expired` back to `active`).

## LLM-Driven Extraction Pipeline

Inspired by Mem0's memory extraction model (arXiv:2504.19413), d8um uses a two-phase LLM pipeline:

**Phase 1: Fact Extraction.** Given a conversation turn, the LLM extracts candidate facts as subject-predicate-object triples with importance and confidence scores.

**Phase 2: Conflict Resolution.** Each candidate fact is compared against existing memories. The LLM decides one of four operations:

| Operation | Meaning |
|-----------|---------|
| `ADD` | New fact, no conflict with existing knowledge |
| `UPDATE` | Replaces or refines an existing fact |
| `DELETE` | Existing fact should be invalidated |
| `NOOP` | Fact already captured, no action needed |

This model prevents memory bloat (duplicate facts) while preserving contradictions as explicit invalidation events rather than silent overwrites.

## Entity Resolution and Edge Invalidation

The `EntityResolver` deduplicates entities using a multi-tier approach:

1. **Alias matching** (cheap) -- checks if the candidate name or any alias matches an existing entity's canonical name or aliases
2. **Trigram Jaccard fuzzy matching** -- catches variations like "NY Times" / "New York Times" (threshold: 0.7)
3. **Vector similarity** (more expensive) -- embeds the entity name and compares against existing entity embeddings using a configurable cosine similarity threshold (default: 0.68), with entity type guards to prevent cross-type merging

When entities are merged, aliases are unioned and the more specific entity type is preserved.

Edge invalidation follows Graphiti's approach: when a new fact contradicts an existing one, the `InvalidationEngine` uses LLM-driven contradiction detection to classify conflicts as `direct` (mutually exclusive facts), `temporal` (fact changed over time), or `superseded` (updated information). Old facts are preserved with `invalidAt` set -- never deleted.

## Consolidation, Decay, and Forgetting

The `@d8um-ai/graph` package provides lifecycle management:

- **Consolidation** promotes episodic memories to semantic facts when patterns emerge from repeated observations
- **Decay** reduces the effective priority of memories based on access frequency, age, and importance
- **Forgetting** archives memories that have decayed below a threshold, keeping them available for explicit historical queries but excluded from default retrieval

These operations run as schedulable jobs via d8um's job system.

## Dual-Mode Execution

d8um memory supports two execution modes that share the same underlying engines:

### Imperative API

Direct method calls for immediate results:

```ts
const memory = new d8umMemory({ memoryStore, embedding, llm })

await memory.remember('Prefers dark mode interfaces')
const facts = await memory.recallFacts('UI preferences')
await memory.correct('Actually, prefers light mode now')
const context = await memory.assembleContext('user preferences')
```

### Job System

Schedulable, automated memory operations:

```ts
import { registerConsolidationJobs } from '@d8um-ai/graph'
registerConsolidationJobs()

// Schedule nightly consolidation
d8um.jobs.create({ type: 'memory_consolidation', schedule: '0 3 * * *' })

// Schedule hourly decay
d8um.jobs.create({ type: 'memory_decay', schedule: '0 * * * *' })

// Ingest conversations as a job
d8um.jobs.create({ type: 'memory_conversation_ingest', config: { messages, sessionId } })
```

The job system uses the same `JobTypeDefinition` interface as d8um's retrieval jobs, providing scheduling, status tracking, and run history.

## Multi-Level Scoping

Memory is scoped across five levels for isolation and sharing:

```ts
const identity: d8umIdentity = {
  tenantId: 'acme-corp',      // organization-level isolation
  groupId: 'team-alpha',      // shared team/channel/project memory
  userId: 'alice',            // individual memory owner
  agentId: 'support-bot',     // specific agent's memory
  sessionId: 'conv-123',      // conversation session
}
```

Scoping uses subset filtering: a query for `{ groupId: 'team-alpha' }` matches records that have `groupId: 'team-alpha'` regardless of what other scope fields they carry.

## MCP Server and Vercel AI SDK Integration

`@d8um-ai/mcp-server` exposes memory operations as MCP tools (`d8um_remember`, `d8um_recall`, `d8um_correct`), making d8um memory accessible to any MCP-compatible agent.

`@d8um-ai/vercel-ai-provider` provides memory tools and middleware for the Vercel AI SDK, enabling seamless integration with `generateText()`, `streamText()`, and the AI SDK's tool system.

## Context Assembly

`assembleContext()` builds LLM-ready context from all memory types in a single call:

```ts
const context = await memory.assembleContext('database setup', {
  includeWorking: true,       // working memory buffer
  includeFacts: true,         // semantic facts
  includeEpisodes: true,      // recent episodes
  includeProcedures: true,    // relevant procedures
  format: 'xml',              // 'xml', 'markdown', or 'plain'
})

// <memory>
//   <working_memory>
//     [system] User is debugging a PostgreSQL connection issue
//   </working_memory>
//   <semantic_memory>
//     - Alice uses PostgreSQL
//     - The API rate limit is 1000 requests per minute
//   </semantic_memory>
//   <episodic_memory>
//     - user: I just switched from MySQL to PostgreSQL at work
//   </episodic_memory>
//   <procedural_memory>
//     - When: database setup requested
//       Steps: Check driver version -> Configure connection pool -> Run migrations
//   </procedural_memory>
// </memory>
```

## Landscape: Where d8um Fits

Agent memory is an active and rapidly evolving area of research. Several excellent projects have advanced the field, each contributing important ideas that benefit the broader ecosystem.

### Graphiti (Zep)

[Graphiti](https://github.com/getzep/graphiti) (22.8k GitHub stars) is a temporal knowledge graph framework for building agent memory, backed by Neo4j. Its foundational paper (arXiv:2501.13956) introduced the bi-temporal data model that tracks both world time and system time for every fact and relationship. Graphiti organizes knowledge into a three-layer hierarchy (episodes, entities, edges) and supports hybrid retrieval across semantic, full-text, and graph traversal. Its strengths are deep temporal reasoning and the expressiveness of a full graph database. The tradeoff is infrastructure: Graphiti requires a running Neo4j instance.

### Mem0

[Mem0](https://github.com/mem0ai/mem0) (47.8k GitHub stars) is a universal memory layer for AI applications, offering both a managed platform and an open-source core. Its paper (arXiv:2504.19413) describes the ADD/UPDATE/DELETE/NOOP extraction model that elegantly handles memory lifecycle through LLM-driven conflict resolution. Mem0's strength is radical API simplicity -- a single `add()` call handles extraction, deduplication, and conflict resolution. It also provides a Vercel AI SDK provider for TypeScript integration. Mem0 is Python-first with a TypeScript client library, and is backed by Y Combinator.

### MemOS (MemTensor)

[MemOS](https://github.com/MemTensor/MemOS) (6.1k GitHub stars) takes an operating systems approach to agent memory, treating memory management as a first-class OS-level concern. Its paper (arXiv:2507.03724) introduces MemCube containers (isolated memory units), a MemLifecycle state machine for memory records, and the concept of tool memory (remembering how tools were used). MemOS's strengths are its systematic approach to memory lifecycle management and natural language correction of stored memories.

### Letta/MemGPT

[Letta](https://github.com/letta-ai/letta) (formerly MemGPT) pioneered virtual context management for LLM agents. Its core insight is that agents can manage their own memory through self-editing operations -- reading from and writing to a structured memory hierarchy as part of their reasoning process. Letta's strengths are its hierarchical context model (core memory, archival memory, recall memory) and its approach to treating memory management as an agent capability rather than an external system.

### Academic Research

Several papers provide important theoretical grounding for agent memory systems:

- **"Memory in the Age of AI Agents"** (arXiv:2512.13564) surveys the landscape of memory architectures for AI agents, proposing taxonomies and identifying open challenges.
- **CoALA (Cognitive Architectures for Language Agents)** (arXiv:2309.02427) provides a framework for understanding how language agents can be organized around cognitive architectures, including memory systems.
- **Mem^p** (arXiv:2508.06433) explores procedural memory specifically -- how agents can learn and recall step-by-step procedures from experience.

### Where d8um fits

d8um's cognitive memory system serves a specific audience with specific constraints:

- **TypeScript-native.** d8um is the only cognitive memory framework built natively in TypeScript. Graphiti, Mem0, MemOS, and Letta are all Python-first. For teams building in TypeScript/Node.js, d8um provides first-class types, native async/await patterns, and zero Python interop overhead.

- **Lightest infrastructure.** d8um requires no graph database. The memory substrate works with the same vector store adapters used for retrieval (pgvector, sqlite-vec). For teams that want cognitive memory without adding Neo4j or a separate memory service to their stack, d8um provides the full memory lifecycle with minimal operational burden.

- **Unified RAG + memory.** d8um's retrieval engine and memory system share the same embedding infrastructure, adapter layer, and job system. A single SDK handles both document retrieval and agent memory, with `assembleContext()` merging both into a single prompt context.

- **Job system for memory operations.** d8um is unique in offering schedulable memory operations (consolidation, decay, forgetting) through the same job system used for data ingestion. No competitor provides built-in scheduled memory lifecycle management.

- **Bi-temporal model without a graph DB.** d8um implements Graphiti-inspired bi-temporal tracking (world time + system time) on top of standard vector storage, providing point-in-time queries and full invalidation history without requiring a graph database.

These are excellent tools that have advanced the field significantly. Graphiti established the bi-temporal paradigm. Mem0 demonstrated that memory can be radically simple. MemOS showed that lifecycle management matters. Letta proved that agents can manage their own context. d8um builds on these research contributions while serving TypeScript developers who want lightweight infrastructure and composable integration with their existing stack.
