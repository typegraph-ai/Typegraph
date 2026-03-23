# d8um

A TypeScript SDK and open protocol for supplying context to LLMs.

Define your data sources once. Query all of them with one call.

```ts
import { D8um } from '@d8um/core'
import { PgVectorAdapter } from '@d8um/adapter-pgvector'
import { UrlConnector } from '@d8um/connector-url'
import { NotionConnector } from '@d8um/connector-notion'

const ctx = new D8um({
  embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  vectorStore: new PgVectorAdapter({ connectionString: process.env.DATABASE_URL! }),
})

ctx.addSource({
  id: 'docs',
  connector: new UrlConnector({ urls: ['https://docs.acme.com/sitemap.xml'] }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['url'],
  },
})

ctx.addSource({
  id: 'wiki',
  connector: new NotionConnector({ apiKey: process.env.NOTION_API_KEY! }),
  mode: 'indexed',
  index: {
    chunkSize: 512,
    chunkOverlap: 64,
    idempotencyKey: ['metadata.pageId'],
    propagateMetadata: ['url', 'title', 'updatedAt', 'metadata.pageId'],
  },
})

// Index your sources (run this in a background job or on deploy)
await ctx.index('docs', { mode: 'upsert' })
await ctx.index('wiki', { mode: 'upsert', pruneDeleted: true })

// Query — fans out across all sources, merges, re-ranks
const { results } = await ctx.query('how do I configure SSO?', { topK: 8 })

// Assemble a prompt-ready context block
const context = ctx.assemble(results, { format: 'xml', maxTokens: 4000 })
```

**Indexed sources** are chunked, embedded, and stored — semantic search runs against them.
**Live sources** are fetched at query time — no storage, always fresh.
**Cached sources** are fetched once and stored until a TTL expires.

## Why not LangChain / LlamaIndex?

Those are frameworks. This is a protocol. You don't build *inside* d8um —
you compose it with whatever stack you're already using.

## Packages

| Package | Description |
|---------|-------------|
| `@d8um/core` | Main SDK — query engine, index engine, types |
| `@d8um/adapter-pgvector` | PostgreSQL + pgvector adapter (production) |
| `@d8um/adapter-sqlite-vec` | SQLite adapter (local dev, zero infra) |
| `@d8um/connector-url` | URL / sitemap crawler connector |
| `@d8um/connector-notion` | Notion connector |

## Development

```bash
npm install
npm run build
npm run test
```

## License

MIT
