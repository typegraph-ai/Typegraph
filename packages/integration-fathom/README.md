# @d8um/integration-fathom

Fathom integration for d8um — sync call recordings and transcripts into your sources.

## Install

```bash
npm install @d8um/integration-fathom
```

## Register

```ts
import { registerJobType } from '@d8um/core'
import { FathomIntegration } from '@d8um/integration-fathom'

for (const job of FathomIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- calls
- transcripts

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `fathom_calls` | Fetches call recordings and transcripts from Fathom | incremental |

## Actions

| Function | Description |
| --- | --- |
| `listCalls(client, input)` | List call recordings |

## Models

Zod schemas: `FathomCallSchema`, `FathomTranscriptSchema`, `FathomTranscriptSegmentSchema`

## Related

- [d8um](../../README.md)
