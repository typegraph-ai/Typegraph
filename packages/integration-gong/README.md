# @d8um-ai/integration-gong

Gong integration for d8um - sync calls, transcripts, and users into your sources.

## Install

```bash
npm install @d8um-ai/integration-gong
```

## Register

```ts
import { registerJobType } from '@d8um-ai/core'
import { GongIntegration } from '@d8um-ai/integration-gong'

for (const job of GongIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- calls
- transcripts
- users

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `gong_calls` | Fetches call recordings from Gong | incremental |
| `gong_transcripts` | Fetches call transcripts from Gong | incremental |
| `gong_users` | Fetches users from Gong workspace | full |

## Actions

| Function | Description |
| --- | --- |
| `fetchCallTranscripts(client, input)` | Fetch transcripts for specific calls |

## Models

Zod schemas: `GongCallSchema`, `GongCallPartySchema`, `GongCallTranscriptSchema`, `GongTranscriptSpeakerSegmentSchema`, `GongUserSchema`

## Related

- [d8um](../../README.md)
