# @d8um/mcp-server

MCP server exposing d8um cognitive memory as tools for AI agents.

## Install

```bash
npm install @d8um/mcp-server
```

## Usage

```ts
import { getToolDefinitions, executeTool } from '@d8um/mcp-server'

const tools = getToolDefinitions()
// => array of MCPToolDefinition schemas

const result = await executeTool(memory, 'd8um_remember', {
  content: 'Alice prefers morning meetings',
  category: 'semantic',
})
```

## Tools

| Tool | Description |
|------|-------------|
| `d8um_remember` | Store a memory with optional category |
| `d8um_recall` | Search memories by semantic similarity |
| `d8um_recall_facts` | Search specifically for semantic facts |
| `d8um_forget` | Invalidate a memory by ID |
| `d8um_correct` | Apply a natural language correction |
| `d8um_add_conversation` | Ingest conversation messages into memory |

## API

| Export | Description |
|--------|-------------|
| `getToolDefinitions()` | Returns array of MCP tool schemas |
| `executeTool()` | Dispatch a tool call to the d8umMemory instance |

### Types

`MCPToolDefinition`

## Related

- [d8um main repo](../../README.md)
- [@d8um/memory](../memory/README.md)
