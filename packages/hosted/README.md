# @d8um/hosted

Hosted client for d8um -- zero infrastructure, just an API key.

## Install

```bash
npm install @d8um/hosted
```

## Usage

```ts
import { d8umHosted } from '@d8um/hosted'

const ctx = d8umHosted({ apiKey: process.env.D8UM_API_KEY! })

const bucket = ctx.buckets.create({ name: 'Knowledge Base' })

await ctx.ingest(bucket.id, [{ id: 'doc-1', content: 'Your content here', title: 'Doc 1', updatedAt: new Date(), metadata: {} }], { chunkSize: 512, chunkOverlap: 64, deduplicateBy: ['content'] })

const { results } = await ctx.query('How does billing work?')
const context = ctx.assemble(results)

// Hosted-only: async document CRUD
const docs = await ctx.listDocuments({ bucketId: bucket.id })
await ctx.deleteDocuments({ bucketId: bucket.id, status: 'stale' })
```

## API

| Export | Description |
|--------|-------------|
| `d8umHosted()` | Factory -- returns a d8umHostedInstance backed by the hosted API |
| `d8umApiError` | Error class with status code and response body |
| `HttpClient` | Low-level HTTP client used internally |

### d8umHostedInstance

Extends `d8umInstance` from `@d8um/core` with:

- `listDocuments(filter?)` -- async document listing
- `getDocument(documentId)` -- fetch a single document
- `updateDocument(documentId, update)` -- partial update
- `deleteDocuments(filter)` -- bulk delete by filter

### Types

`HostedConfig`, `d8umHostedInstance`

## Related

- [d8um main repo](../../README.md)
- [@d8um/core](../core/README.md)
- [d8um Cloud Guide](../../README.md#hosted)
