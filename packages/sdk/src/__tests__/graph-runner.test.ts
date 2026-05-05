import { describe, expect, it, vi } from 'vitest'
import { GraphRunner } from '../query/runners/graph-runner.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'

describe('GraphRunner', () => {
  it('maps chunk graph results into normalized graph results', async () => {
    const searchGraphChunks = vi.fn().mockResolvedValue({
      results: [{
        chunkId: 'chunk-1',
        content: 'Adarsh Tadimari is debugging Plotline SDK initialization.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        chunkIndex: 2,
        totalChunks: 5,
        score: 0.42,
        metadata: { source: 'test' },
        tenantId: 'tenant-1',
      }],
      facts: [{
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'ent-1',
        sourceEntityName: 'Adarsh Tadimari',
        targetEntityId: 'ent-2',
        targetEntityName: 'Plotline SDK',
        relation: 'WORKS_ON',
        factText: 'Adarsh works on Plotline SDK',
        weight: 1,
        evidenceCount: 1,
      }],
      entities: [{
        id: 'ent-1',
        name: 'Adarsh Tadimari',
        entityType: 'person',
        aliases: [],
        edgeCount: 1,
      }],
      trace: {
        entitySeedCount: 1,
        factSeedCount: 1,
        chunkSeedCount: 1,
        graphNodeCount: 3,
        graphEdgeCount: 2,
        pprNonzeroCount: 3,
        candidatesBeforeMerge: 1,
        candidatesAfterMerge: 1,
        topGraphScores: [0.42],
        selectedFactIds: ['fact-1'],
        selectedEntityIds: ['ent-1'],
        selectedChunkIds: ['chunk-1'],
      },
    })

    const runner = new GraphRunner({ searchGraphChunks } satisfies KnowledgeGraphBridge)
    const run = await runner.run(
      'Adarsh Plotline SDK',
      { tenantId: 'tenant-1' },
      3,
      ['bucket-1'],
      { restartProbability: 0.5 }
    )

    expect(searchGraphChunks).toHaveBeenCalledWith(
      'Adarsh Plotline SDK',
      { tenantId: 'tenant-1' },
      {
        factFilter: true,
        factCandidateLimit: 80,
        factFilterInputLimit: 12,
        factSeedLimit: 4,
        chunkSeedLimit: 80,
        maxExpansionEdgesPerEntity: 25,
        factChainLimit: 2,
        maxPprIterations: 40,
        minPprScore: 1e-8,
        restartProbability: 0.5,
        count: 3,
        bucketIds: ['bucket-1'],
      }
    )
    expect(run.facts).toEqual([expect.objectContaining({ id: 'fact-1', factText: 'Adarsh works on Plotline SDK' })])
    expect(run.entities).toEqual([expect.objectContaining({ id: 'ent-1', name: 'Adarsh Tadimari' })])
    expect(run.results).toEqual([
      expect.objectContaining({
        content: 'Adarsh Tadimari is debugging Plotline SDK initialization.',
        bucketId: 'bucket-1',
        documentId: 'doc-1',
        rawScores: { graph: 0.42 },
        mode: 'graph',
        chunk: { index: 2, total: 5 },
        metadata: expect.objectContaining({
          source: 'test',
          chunkId: 'chunk-1',
        }),
        tenantId: 'tenant-1',
      }),
    ])
  })

  it('throws when searchGraphChunks is missing', async () => {
    const runner = new GraphRunner({} satisfies KnowledgeGraphBridge)

    await expect(
      runner.run('Adarsh', { tenantId: 'tenant-1' }, 5)
    ).rejects.toThrow('Knowledge graph bridge must implement searchGraphChunks for graph queries.')
  })

  it('lets explicit graph options override the default profile', async () => {
    const searchGraphChunks = vi.fn().mockResolvedValue({
      results: [],
      facts: [],
      entities: [],
      trace: {},
    })
    const runner = new GraphRunner({ searchGraphChunks } satisfies KnowledgeGraphBridge)

    await runner.run('query', { tenantId: 'tenant-1' }, 5, undefined, {
      factFilter: false,
      factCandidateLimit: 25,
    })

    expect(searchGraphChunks).toHaveBeenCalledWith(
      'query',
      { tenantId: 'tenant-1' },
      expect.objectContaining({
        factFilter: false,
        factCandidateLimit: 25,
        factSeedLimit: 4,
        count: 5,
      })
    )
  })
})
