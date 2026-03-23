// Zero-infra quickstart — no Postgres, no API keys needed
// Uses SqliteVecAdapter + a mock embedding function

import { D8um } from '@d8um/core'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'

async function main() {
  const ctx = new D8um({
    embedding: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY ?? 'sk-mock',
    },
    vectorStore: new SqliteVecAdapter({ dbPath: './local-dev.db' }),
  })

  ctx.addSource({
    id: 'test-docs',
    connector: {
      async *fetch() {
        yield {
          id: 'doc-1',
          title: 'Getting Started',
          content: 'd8um is a TypeScript SDK for supplying context to LLMs. Install it with npm install @d8um/core.',
          updatedAt: new Date(),
          metadata: {},
        }
        yield {
          id: 'doc-2',
          title: 'Configuration',
          content: 'You can configure d8um by passing a vectorStore and embedding provider to the D8um constructor.',
          updatedAt: new Date(),
          metadata: {},
        }
      },
    },
    mode: 'indexed',
    index: {
      chunkSize: 256,
      chunkOverlap: 32,
      idempotencyKey: ['id'],
    },
  })

  console.log('Indexing...')
  const result = await ctx.index('test-docs')
  console.log('Index result:', result)

  console.log('Querying...')
  const response = await ctx.query('how do I install d8um?')
  console.log('Results:', response.results.map(r => r.content))

  const context = ctx.assemble(response.results, { format: 'xml' })
  console.log('Assembled context:\n', context)
}

main().catch(console.error)
