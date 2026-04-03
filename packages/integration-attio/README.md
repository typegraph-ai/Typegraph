# @d8um-ai/integration-attio

Attio integration for d8um - sync contacts, companies, and tasks into your sources.

## Install

```bash
npm install @d8um-ai/integration-attio
```

## Register

```ts
import { registerJobType } from '@d8um-ai/core'
import { AttioIntegration } from '@d8um-ai/integration-attio'

for (const job of AttioIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- contacts
- companies
- tasks

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `attio_contacts` | Fetches contacts from Attio workspace | full |
| `attio_companies` | Fetches companies from Attio workspace | full |
| `attio_tasks` | Fetches tasks from Attio workspace | incremental |

## Actions

| Function | Description |
| --- | --- |
| `listRecords(client, input)` | List records from any Attio object |

## Models

Zod schemas: `AttioContactSchema`, `AttioCompanySchema`, `AttioTaskSchema`

## Related

- [d8um](../../README.md)
