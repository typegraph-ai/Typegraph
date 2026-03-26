# @d8um/memory

Cognitive memory substrate for AI agents -- working memory, episodic recall, semantic knowledge, and procedural learning.

## Install

```bash
npm install @d8um/memory
```

## Usage

```ts
import { d8umMemory } from '@d8um/memory'

const memory = new d8umMemory({
  memoryStore: myAdapter,
  embedding: embeddingProvider,
  llm: llmProvider,
  scope: { agentId: 'agent-1' },
})

await memory.remember('Alice works at Acme Corp')
const results = await memory.recall('Where does Alice work?')
await memory.correct('Actually, Alice works at Beta Inc now')
await memory.addConversationTurn([
  { role: 'user', content: 'Schedule a meeting with Bob' },
  { role: 'assistant', content: 'Done -- meeting set for 3pm' },
])
const context = await memory.assembleContext('What do I know about Alice?')
```

## API

### Core

| Export | Description |
|--------|-------------|
| `d8umMemory` | Unified API -- remember, recall, correct, forget, addConversationTurn, assembleContext |
| `WorkingMemory` | Short-term scratchpad with TTL eviction |
| `MemoryExtractor` | LLM-powered extraction of facts and episodes from conversations |
| `EntityResolver` | Merge and deduplicate entity references |
| `InvalidationEngine` | Detect contradictions and invalidate stale facts |
| `conversationIngestJob` | Job definition for automated conversation ingestion |

### Temporal

| Export | Description |
|--------|-------------|
| `transitionStatus()` | Move a memory through its lifecycle |
| `createTemporal()` | Create a temporal record |
| `isActiveAt()` | Check if a record is valid at a point in time |
| `invalidateRecord()` | Mark a record as invalidated |

### Scope

| Export | Description |
|--------|-------------|
| `buildScope()` | Construct a scope from parts |
| `scopeKey()` | Serialize a scope to a string key |
| `scopeMatches()` | Check if a record matches a scope |

### Types

`MemoryRecord`, `MemoryStatus`, `MemoryScope`, `EpisodicMemory`, `SemanticFact`, `ProceduralMemory`, `MemoryStoreAdapter`, `MemoryCategory`, `MemoryFilter`, `ConversationMessage`, `ExtractionResult`, `LLMProvider`, `WorkingMemoryConfig`

## Related

- [d8um main repo](../../README.md)
- [Agentic Memory Guide](../../README.md#agentic-memory)
