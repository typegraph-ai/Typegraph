# @typegraph-ai/mcp-server

MCP server exposing TypeGraph cognitive memory as tools for AI agents.

## Install

```bash
pnpm add @typegraph-ai/mcp-server
```

## Usage

```ts
import { getToolDefinitions, executeTool } from '@typegraph-ai/mcp-server'

const tools = getToolDefinitions()
// => array of MCPToolDefinition schemas

const result = await executeTool(typegraph, 'typegraph_remember', {
  content: 'Alice prefers morning meetings',
  category: 'semantic',
})
```

## Tools

| Tool | Description |
|------|-------------|
| `typegraph_remember` | Store a memory with optional category |
| `typegraph_recall` | Search memories by semantic similarity |
| `typegraph_recall_facts` | Search specifically for semantic facts |
| `typegraph_memory_context` | Return summary-first progressive memory context |
| `typegraph_memory_extract_thread` | Extract reusable memory from a stored thread |
| `typegraph_memory_consolidate` | Consolidate raw conversation memory into handbook and summary artifacts |
| `typegraph_memory_artifact_get` | Fetch a database-backed memory artifact by path |
| `typegraph_memory_artifact_list` | List memory artifacts by layout, prefix, or kind |
| `typegraph_memory_artifact_upsert` | Create or replace a memory artifact |
| `typegraph_memory_artifact_delete` | Delete a memory artifact |
| `typegraph_forget` | Invalidate a memory by ID |
| `typegraph_correct` | Apply a natural language correction |
| `typegraph_thread_add_turn` | Store a thread turn as a linked event with optional canonical `url` |
| `typegraph_health_check` | Return memory system health and storage statistics |

## API

| Export | Description |
|--------|-------------|
| `getToolDefinitions()` | Returns array of MCP tool schemas |
| `executeTool()` | Dispatch a tool call to a TypeGraph instance with `memory` and `thread` APIs |

### Types

`MCPToolDefinition`

## Related

- [TypeGraph main repo](../../README.md)
- [@typegraph-ai/sdk](../sdk/README.md)
