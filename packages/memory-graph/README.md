# @d8um/memory-graph

Embedded graph layer for d8um cognitive memory -- no external graph database needed.

## Install

```bash
npm install @d8um/memory-graph
```

## Usage

```ts
import { EmbeddedGraph } from '@d8um/memory-graph'

const graph = new EmbeddedGraph(memoryStoreAdapter)

await graph.addEntity({ id: 'alice', name: 'Alice', type: 'person', ... })
await graph.addEntity({ id: 'acme', name: 'Acme Corp', type: 'organization', ... })
await graph.addEdge({ id: 'e1', sourceEntityId: 'alice', targetEntityId: 'acme', relation: 'WORKS_AT', ... })

const neighbors = await graph.getNeighbors('alice', 2)
const subgraph = await graph.getSubgraph(['alice', 'acme'], 1)
const context = graph.subgraphToContext(subgraph)
// => "Entities:\n- Alice (person)\n- Acme Corp (organization)\n\nRelationships:\n- Alice WORKS_AT Acme Corp"
```

## API

| Export | Description |
|--------|-------------|
| `EmbeddedGraph` | Full graph API -- addEntity, addEdge, getNeighbors, getNeighborsAt, getSubgraph, findPath, subgraphToContext |

### Methods

- `addEntity(entity)` -- upsert an entity node
- `addEdge(edge)` -- add a relationship between entities
- `getNeighbors(entityId, depth?, direction?)` -- BFS traversal
- `getNeighborsAt(entityId, at, depth?)` -- time-aware BFS
- `getSubgraph(entityIds, depth?)` -- extract a subgraph
- `findPath(fromId, toId, maxDepth?)` -- shortest path via BFS
- `subgraphToContext(subgraph)` -- serialize to LLM-ready string

### Types

`GraphNode`, `GraphPath`, `Subgraph`

## Related

- [d8um main repo](../../README.md)
- [@d8um/memory](../memory/README.md)
