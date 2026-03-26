# @d8um/integration-slack

Slack integration for d8um — sync channels, messages, and users into your sources.

## Install

```bash
npm install @d8um/integration-slack
```

## Register

```ts
import { registerJobType } from '@d8um/core'
import { SlackIntegration } from '@d8um/integration-slack'

for (const job of SlackIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- channels
- messages
- users

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `slack_channels` | Fetches channels from Slack workspace | full |
| `slack_messages` | Fetches messages from Slack channels | incremental |

## Actions

| Function | Description |
| --- | --- |
| `sendMessage(client, input)` | Send a message to a Slack channel |
| `listUsers(client, input)` | List users in the Slack workspace |

## Models

Zod schemas: `SlackChannelSchema`, `SlackMessageSchema`, `SlackUserSchema`, `SlackReactionSchema`

## Related

- [d8um](../../README.md)
