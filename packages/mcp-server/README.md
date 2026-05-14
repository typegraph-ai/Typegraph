# @typegraph-ai/mcp-server

MCP server exposing TypeGraph cognitive memory as tools for AI agents.

## Install

```bash
npm install @typegraph-ai/mcp-server
```

## Usage

```ts
import { getToolDefinitions, executeTool } from '@typegraph-ai/mcp-server'

const tools = getToolDefinitions()
// => array of MCPToolDefinition schemas

const result = await executeTool(memory, 'typegraph_remember', {
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
| `typegraph_forget` | Invalidate a memory by ID |
| `typegraph_correct` | Apply a natural language correction |
| `typegraph_thread_add_turn` | Store a thread turn as a linked event with optional canonical `url` |

## API

| Export | Description |
|--------|-------------|
| `getToolDefinitions()` | Returns array of MCP tool schemas |
| `executeTool()` | Dispatch a tool call to the typegraphMemory instance |

### Types

`MCPToolDefinition`

## Related

- [TypeGraph main repo](../../README.md)
- [@typegraph-ai/graph](../graph/README.md)
