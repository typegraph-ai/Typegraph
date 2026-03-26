# @d8um/integration-hubspot

HubSpot integration for d8um — sync contacts, companies, and deals into your sources.

## Install

```bash
npm install @d8um/integration-hubspot
```

## Register

```ts
import { registerJobType } from '@d8um/core'
import { HubSpotIntegration } from '@d8um/integration-hubspot'

for (const job of HubSpotIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- contacts
- companies
- deals

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `hubspot_contacts` | Fetches contacts from HubSpot CRM | full |
| `hubspot_companies` | Fetches companies from HubSpot CRM | full |
| `hubspot_deals` | Fetches deals from HubSpot CRM | incremental |

## Actions

| Function | Description |
| --- | --- |
| `createContact(client, input)` | Create a new contact in HubSpot |

## Models

Zod schemas: `HubSpotContactSchema`, `HubSpotCompanySchema`, `HubSpotDealSchema`

## Related

- [d8um](../../README.md)
