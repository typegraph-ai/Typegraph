// Zero-infra quickstart — no Postgres, no external services needed
// Uses SqliteVecAdapter + AI SDK embedding provider

// To use a real embedding model, install a provider:
//   npm install @ai-sdk/openai
//
// import { openai } from '@ai-sdk/openai'
// embedding: { model: openai.embedding('text-embedding-3-small'), dimensions: 1536 }

import { d8um } from '@d8um/core'
import { SqliteVecAdapter } from '@d8um/adapter-sqlite-vec'

async function main() {
  d8um.initialize({
    // For local dev, you can use a custom EmbeddingProvider directly
    embedding: {
      model: 'mock/local-dev',
      dimensions: 3,
      async embed(text: string) {
        // Mock: return a simple hash-based vector
        const hash = [...text].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
        return [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2)]
      },
      async embedBatch(texts: string[]) {
        return Promise.all(texts.map(t => this.embed(t)))
      },
    },
    vectorStore: new SqliteVecAdapter({ dbPath: './local-dev.db' }),
  })

  d8um.addSource({
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
          content: 'You can configure d8um by calling d8um.initialize() with a vectorStore and embedding provider.',
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
  const result = await d8um.index('test-docs')
  console.log('Index result:', result)

  console.log('Querying...')
  const response = await d8um.query('how do I install d8um?')
  console.log('Results:', response.results.map(r => r.content))

  const context = d8um.assemble(response.results, { format: 'xml' })
  console.log('Assembled context:\n', context)
}

main().catch(console.error)
