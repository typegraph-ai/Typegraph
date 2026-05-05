import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudInstance } from '../cloud/cloud-instance.js'

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    bucketId: 'bkt_novel',
    mode: 'upsert',
    total: 1,
    skipped: 0,
    updated: 0,
    inserted: 1,
    pruned: 0,
    durationMs: 1,
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('createCloudInstance', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends ingest options nested under opts', async () => {
    const fetchMock = mockFetch()
    const instance = createCloudInstance({ apiKey: 'test-key', baseUrl: 'https://example.test/api' })

    await instance.ingest([
      { title: 'Novel chunk', content: 'Cole Conway met Steve Sharp.', metadata: { retryRound: 1 } },
    ], {
      bucketId: 'bkt_novel',
      deduplicateBy: ['content', 'metadata.retryRound'],
      graphExtraction: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://example.test/api/v1/buckets/bkt_novel/ingest')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.sources).toHaveLength(1)
    expect(body.opts).toEqual(expect.objectContaining({
      bucketId: 'bkt_novel',
      deduplicateBy: ['content', 'metadata.retryRound'],
      graphExtraction: true,
    }))
    expect(body.deduplicateBy).toBeUndefined()
    expect(body.graphExtraction).toBeUndefined()
  })

  it('sends pre-chunked ingest options nested under opts', async () => {
    const fetchMock = mockFetch()
    const instance = createCloudInstance({ apiKey: 'test-key', baseUrl: 'https://example.test/api' })

    await instance.ingestPreChunked(
      { title: 'Novel chunk', content: 'Cole Conway met Steve Sharp.' },
      [{ content: 'Cole Conway met Steve Sharp.', chunkIndex: 0 }],
      { bucketId: 'bkt_novel', deduplicateBy: ['content', 'metadata.retryRound'] },
    )

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.source).toEqual(expect.objectContaining({ title: 'Novel chunk' }))
    expect(body.chunks).toEqual([{ content: 'Cole Conway met Steve Sharp.', chunkIndex: 0 }])
    expect(body.opts).toEqual(expect.objectContaining({
      bucketId: 'bkt_novel',
      deduplicateBy: ['content', 'metadata.retryRound'],
    }))
    expect(body.deduplicateBy).toBeUndefined()
  })
})
