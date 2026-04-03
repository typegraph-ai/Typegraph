# @d8um-ai/integration-linear

Linear integration for d8um - sync issues, projects, and teams into your sources.

## Install

```bash
npm install @d8um-ai/integration-linear
```

## Register

```ts
import { registerJobType } from '@d8um-ai/core'
import { LinearIntegration } from '@d8um-ai/integration-linear'

for (const job of LinearIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- issues
- projects
- teams

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `linear_issues` | Fetches issues from Linear workspace | incremental |

## Actions

| Function | Description |
| --- | --- |
| `listIssues(client, input)` | List issues from Linear |

## Models

Zod schemas: `LinearIssueSchema`, `LinearProjectSchema`, `LinearTeamSchema`

## Related

- [d8um](../../README.md)
