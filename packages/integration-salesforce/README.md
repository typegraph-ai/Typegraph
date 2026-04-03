# @d8um-ai/integration-salesforce

Salesforce integration for d8um - sync contacts, accounts, opportunities, and leads into your sources.

## Install

```bash
npm install @d8um-ai/integration-salesforce
```

## Register

```ts
import { registerJobType } from '@d8um-ai/core'
import { SalesforceIntegration } from '@d8um-ai/integration-salesforce'

for (const job of SalesforceIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- contacts
- accounts
- opportunities
- leads

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `salesforce_contacts` | Fetches contacts from Salesforce | full |
| `salesforce_accounts` | Fetches accounts from Salesforce | full |
| `salesforce_opportunities` | Fetches opportunities from Salesforce | incremental |

## Actions

| Function | Description |
| --- | --- |
| `queryRecords(client, input)` | Execute a SOQL query against Salesforce |

## Models

Zod schemas: `SalesforceContactSchema`, `SalesforceAccountSchema`, `SalesforceOpportunitySchema`, `SalesforceLeadSchema`

## Related

- [d8um](../../README.md)
