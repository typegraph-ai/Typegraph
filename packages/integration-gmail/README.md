# @d8um/integration-gmail

Gmail integration for d8um — sync messages, threads, and labels into your sources.

## Install

```bash
npm install @d8um/integration-gmail
```

## Register

```ts
import { registerJobType } from '@d8um/core'
import { GmailIntegration } from '@d8um/integration-gmail'

for (const job of GmailIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- messages
- threads
- labels

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `gmail_messages` | Fetches messages from Gmail | incremental |

## Actions

| Function | Description |
| --- | --- |
| `listMessages(client, input)` | List Gmail messages |

## Models

Zod schemas: `GmailMessageSchema`, `GmailMessageBodySchema`, `GmailAttachmentSchema`, `GmailThreadSchema`, `GmailLabelSchema`

## Related

- [d8um](../../README.md)
