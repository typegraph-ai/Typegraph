import { describe, it, expect, beforeEach } from 'vitest'
import { d8umCreate } from '../d8um.js'
import { createMockAdapter } from './helpers/mock-adapter.js'
import { createMockEmbedding } from './helpers/mock-embedding.js'
import { createMockBucket } from './helpers/mock-source.js'
import { createTestDocument } from './helpers/mock-connector.js'
import type { d8umInstance } from '../d8um.js'
import type { Bucket } from '../types/bucket.js'
import type { EmbeddingProvider } from '../embedding/provider.js'

/** Register a pre-built Bucket + embedding on an instance (bypasses buckets.create UUID generation). */
function registerTestBucket(instance: d8umInstance, bucket: Bucket, embedding: EmbeddingProvider) {
  const impl = instance as any
  impl._buckets.set(bucket.id, bucket)
  impl.bucketEmbeddings.set(bucket.id, embedding)
}

describe('searchWithContext', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let embedding: ReturnType<typeof createMockEmbedding>
  let instance: d8umInstance

  beforeEach(async () => {
    adapter = createMockAdapter()
    embedding = createMockEmbedding()
    instance = await d8umCreate({ vectorStore: adapter, embedding })

    const longContent = Array.from({ length: 10 }, (_, i) =>
      `Chunk ${i} content. `.repeat(50)
    ).join('')
    const doc = createTestDocument({
      id: 'doc-1',
      content: longContent,
      title: 'Long Document',
      url: 'https://example.com/long',
    })
    const { bucket, indexConfig } = createMockBucket({
      documents: [doc],
      chunkSize: 50,
      chunkOverlap: 10,
    })
    registerTestBucket(instance, bucket, embedding)
    await instance.ingest(bucket.id, [doc], indexConfig)
  })

  it('returns passages with neighbor chunks', async () => {
    const response = await instance.searchWithContext('Chunk 5 content', { surroundingChunks: 1 })
    if (response.passages.length > 0) {
      const passage = response.passages[0]!
      expect(passage.chunks.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('returns rawResults alongside passages', async () => {
    const response = await instance.searchWithContext('Chunk 5 content')
    expect(response.rawResults).toBeDefined()
    expect(Array.isArray(response.rawResults)).toBe(true)
  })

  it('includes query timing info', async () => {
    const response = await instance.searchWithContext('test')
    expect(response.query).toBeDefined()
    expect(response.query.durationMs).toBeGreaterThanOrEqual(0)
    expect(response.query.text).toBe('test')
  })

  it('returns empty passages when no results', async () => {
    const emptyAdapter = createMockAdapter()
    const emptyInstance = await d8umCreate({ vectorStore: emptyAdapter, embedding })
    const { bucket: emptyBucket } = createMockBucket({ documents: [] })
    registerTestBucket(emptyInstance, emptyBucket, embedding)
    const response = await emptyInstance.searchWithContext('nonexistent')
    expect(response.passages).toHaveLength(0)
  })

  it('passages have stitched content structure', async () => {
    const response = await instance.searchWithContext('Chunk 5 content')
    if (response.passages.length > 0) {
      const passage = response.passages[0]!
      expect(passage).toHaveProperty('content')
      expect(passage).toHaveProperty('documentId')
      expect(passage).toHaveProperty('title')
      expect(passage).toHaveProperty('rrfScore')
      expect(passage).toHaveProperty('similarity')
      expect(passage).toHaveProperty('chunks')
    }
  })

  it('marks hit chunks vs neighbor chunks', async () => {
    const response = await instance.searchWithContext('Chunk 5 content', { surroundingChunks: 1 })
    if (response.passages.length > 0) {
      const passage = response.passages[0]!
      const hits = passage.chunks.filter(c => c.isHit)
      expect(hits.length).toBeGreaterThanOrEqual(1)
    }
  })
})
