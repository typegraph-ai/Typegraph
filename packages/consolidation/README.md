# @d8um/consolidation

Memory lifecycle management -- consolidation, decay, forgetting, correction, and procedural promotion.

## Install

```bash
npm install @d8um/consolidation
```

## Usage

```ts
import { registerConsolidationJobs, ConsolidationEngine, decayScore } from '@d8um/consolidation'

// Register all 5 memory lifecycle jobs at once
registerConsolidationJobs()

// Or use engines directly
const engine = new ConsolidationEngine({ memoryStore, llm, embedding })
await engine.consolidate({ scope, strategy: 'merge' })

// Score memory decay
const score = decayScore(memory, { halfLife: 7, accessBoost: 0.1 })
```

## API

### Engines

| Export | Description |
|--------|-------------|
| `ConsolidationEngine` | Merge and compress related memories |
| `ForgettingEngine` | Apply forgetting policies (archive, summarize, delete) |
| `MemoryCorrector` | Apply NL corrections to stored memories |
| `decayScore()` | Calculate decay score for a memory |
| `scoreMemories()` | Score a batch of memories |
| `findDecayedMemories()` | Find memories below a decay threshold |

### Jobs

| Export | Description |
|--------|-------------|
| `registerConsolidationJobs()` | Register all 5 jobs at once |
| `memoryConsolidationJob` | Merge related memories |
| `memoryDecayJob` | Score and flag decayed memories |
| `memoryCommunityDetectionJob` | Detect entity clusters in the graph |
| `memoryCorrectionJob` | Process pending corrections |
| `memoryProceduralPromotionJob` | Promote repeated patterns to procedural memory |

### Types

`DecayConfig`, `ForgettingPolicy`, `ForgettingResult`, `CorrectionResult`, `ConsolidationConfig`, `ConsolidationStrategy`, `ConsolidationResult`

## Related

- [d8um main repo](../../README.md)
- [@d8um/memory](../memory/README.md)
- [@d8um/memory-graph](../memory-graph/README.md)
