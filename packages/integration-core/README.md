# @d8um-ai/integration-core

Shared types and interfaces for building d8um integrations.

## Install

```bash
npm install @d8um-ai/integration-core
```

## IntegrationDefinition

Every integration package exports a single `IntegrationDefinition` - the manifest that describes the integration and its capabilities.

```ts
import type { IntegrationDefinition } from '@d8um-ai/integration-core'

const MyIntegration: IntegrationDefinition = {
  id: 'my-service',
  name: 'My Service',
  description: 'What it does',
  author: 'Author',
  category: 'crm',              // 'crm' | 'communication' | 'productivity' | 'sales' | 'storage' | 'finance'
  scope: 'workspace',           // 'workspace' | 'individual'
  connectPermission: 'admin',   // 'admin' | 'member'
  auth: {
    type: 'oauth2',             // 'oauth2' | 'api_key' | 'oauth2_cc'
    scopes: ['read', 'write'],
  },
  api: {
    baseUrl: 'https://api.example.com',
    type: 'rest',               // 'rest' | 'graphql'
    endpoints: { users: '/v1/users' },
  },
  features: {
    jobs: true,
    webhooks: false,
    incrementalJobs: true,
  },
  display: {
    logo: 'logo.png',
    permissionsSummary: ['Read data'],
    aboutSummary: 'Short description for UI',
  },
  jobs: [/* JobTypeDefinition[] */],
  entities: ['users', 'records'],
}
```

## Exports

| Export                   | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `IntegrationDefinition`  | Full manifest interface for a 3rd-party integration   |
| `IntegrationCategory`    | Union type: `'crm' \| 'communication' \| 'productivity' \| 'sales' \| 'storage' \| 'finance'` |

## Related

- [d8um](../../README.md)
