import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudInstance } from '../cloud/cloud-instance.js'

function mockFetch() {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
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

  it('normalizes null optional request bodies to empty objects', async () => {
    const fetchMock = mockFetch()
    const instance = createCloudInstance({ apiKey: 'test-key', baseUrl: 'https://example.test/api' })

    await instance.sources.list(null)
    await instance.jobs.list(null)
    await instance.policies.list(null)
    await instance.listSources(null)

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string)
      expect(body).toEqual({})
    }
  })

  it('accepts null ingest opts and keeps opts nested', async () => {
    const fetchMock = mockFetch()
    const instance = createCloudInstance({ apiKey: 'test-key', baseUrl: 'https://example.test/api' })

    await instance.ingest([
      { title: 'Untargeted', content: 'Default bucket content' },
    ], null)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://example.test/api/v1/buckets/bkt_default/ingest')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.opts).toEqual({})
  })

  it('rejects null destructive source filters with a ConfigError', async () => {
    const instance = createCloudInstance({ apiKey: 'test-key', baseUrl: 'https://example.test/api' })

    await expect(instance.sources.delete(null)).rejects.toThrow('sources.delete requires at least one filter field')
    await expect(instance.deleteSources(null)).rejects.toThrow('deleteSources requires at least one filter field')
  })

  it('uses unified memory opts bags in cloud mode', async () => {
    const fetchMock = mockFetch()
    const instance = createCloudInstance({ apiKey: 'test-key', baseUrl: 'https://example.test/api' })

    await instance.remember('Prefers SMS', {
      userId: 'user-1',
      category: 'semantic',
      importance: 0.8,
      metadata: { source: 'test' },
    })
    await instance.recall('SMS', null)
    await instance.healthCheck(null)
    await instance.addConversationTurn([
      { role: 'user', content: 'hello' },
    ], { userId: 'user-1', conversationId: 'conv-1' })

    const rememberBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(rememberBody).toEqual({
      content: 'Prefers SMS',
      identity: { userId: 'user-1' },
      category: 'semantic',
      importance: 0.8,
      metadata: { source: 'test' },
    })

    const recallBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)
    expect(recallBody).toEqual({ query: 'SMS', identity: {} })

    const healthBody = JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)
    expect(healthBody).toEqual({ identity: {} })

    const turnBody = JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string)
    expect(turnBody).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
      identity: { userId: 'user-1', conversationId: 'conv-1' },
    })
  })
})
