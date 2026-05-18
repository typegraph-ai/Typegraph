import { describe, it, expect, vi } from 'vitest'
import { createKnowledgeGraphBridge } from '../graph-bridge.js'
import type { ExternalId, MemoryStoreAdapter, SemanticEntity, SemanticEdge, SemanticEntityChunkEdge, SemanticFactRecord } from '../../memory/types/index.js'
import { buildScope } from '../../memory/index.js'
import { GraphSelfEdgeError } from '../../types/errors.js'

const testScope = buildScope({ userId: 'test-user' })

function makeEntity(id: string, name: string, type: string = 'concept'): SemanticEntity {
  return {
    id,
    name,
    entityType: type,
    aliases: [],
    metadata: {},
    embedding: [0.1, 0.2, 0.3],
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
  }
}

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  relation: string,
  metadata: Record<string, unknown> = {},
): SemanticEdge {
  return {
    id,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    relation,
    weight: 1.0,
    metadata,
    scope: testScope,
    temporal: { validAt: new Date(), createdAt: new Date() },
    evidence: [],
  }
}

interface MockMention {
  entityId: string
  documentId: string
  chunkIndex: number
  bucketId: string
  mentionType: 'subject' | 'object' | 'co_occurrence' | 'entity' | 'alias' | 'document_subject'
  surfaceText?: string | undefined
  normalizedSurfaceText?: string | undefined
  confidence?: number | undefined
}

function externalIdKey(externalId: ExternalId): string {
  return [
    externalId.type.trim().toLowerCase(),
    externalId.id.trim(),
    externalId.encoding ?? 'none',
  ].join('|')
}

function mockStore(
  entities: Map<string, SemanticEntity> = new Map(),
  edges: SemanticEdge[] = [],
  mentions: MockMention[] = [],
) {
  const externalEntityIdByKey = new Map<string, string>()
  const externalIdsByEntity = new Map<string, ExternalId[]>()

  const attachExternalIds = (entity: SemanticEntity): SemanticEntity => ({
    ...entity,
    externalIds: externalIdsByEntity.get(entity.id) ?? entity.externalIds,
  })

  const linkExternalIds = (entityId: string, externalIds: ExternalId[]) => {
    const existing = externalIdsByEntity.get(entityId) ?? []
    const byKey = new Map(existing.map(externalId => [externalIdKey(externalId), externalId]))
    for (const externalId of externalIds) {
      const normalized: ExternalId = {
        ...externalId,
        type: externalId.type.trim().toLowerCase(),
        id: externalId.id.trim(),
        encoding: externalId.encoding ?? 'none',
      }
      const key = externalIdKey(normalized)
      const currentEntityId = externalEntityIdByKey.get(key)
      if (currentEntityId && currentEntityId !== entityId) {
        throw new Error(`external ID conflict for ${key}`)
      }
      externalEntityIdByKey.set(key, entityId)
      byKey.set(key, normalized)
    }
    externalIdsByEntity.set(entityId, [...byKey.values()])
  }

  const store: MemoryStoreAdapter = {
    initialize: vi.fn(),
    upsert: vi.fn().mockImplementation(async (r) => r),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    upsertEntity: vi.fn().mockImplementation(async (e: SemanticEntity) => {
      if (e.externalIds?.length) linkExternalIds(e.id, e.externalIds)
      entities.set(e.id, e)
      return attachExternalIds(e)
    }),
    getEntity: vi.fn().mockImplementation(async (id: string) => {
      const entity = entities.get(id)
      return entity ? attachExternalIds(entity) : null
    }),
    findEntities: vi.fn().mockImplementation(async (query: string) => {
      return [...entities.values()].filter(e =>
        e.name.toLowerCase().includes(query.toLowerCase()),
      ).map(attachExternalIds)
    }),
    upsertEntityExternalIds: vi.fn().mockImplementation(async (entityId: string, externalIds: ExternalId[]) => {
      linkExternalIds(entityId, externalIds)
      const entity = entities.get(entityId)
      if (entity) entities.set(entityId, attachExternalIds(entity))
    }),
    findEntityByExternalId: vi.fn().mockImplementation(async (externalId: ExternalId) => {
      const entityId = externalEntityIdByKey.get(externalIdKey({
        ...externalId,
        type: externalId.type.trim().toLowerCase(),
        id: externalId.id.trim(),
        encoding: externalId.encoding ?? 'none',
      }))
      const entity = entityId ? entities.get(entityId) : undefined
      return entity ? attachExternalIds(entity) : null
    }),
    mergeEntityReferences: vi.fn().mockImplementation(async ({ sourceEntityId, targetEntityId, metadata }) => {
      const source = entities.get(sourceEntityId)
      const target = entities.get(targetEntityId)
      if (!source || !target) throw new Error('entity not found')
      const sourceExternalIds = externalIdsByEntity.get(sourceEntityId) ?? []
      const targetExternalIds = externalIdsByEntity.get(targetEntityId) ?? []
      const mergedExternalIds = [...targetExternalIds]
      for (const externalId of sourceExternalIds) {
        const key = externalIdKey(externalId)
        const linked = externalEntityIdByKey.get(key)
        if (linked && linked !== sourceEntityId && linked !== targetEntityId) throw new Error('external ID conflict')
        externalEntityIdByKey.set(key, targetEntityId)
        if (!mergedExternalIds.some(existing => externalIdKey(existing) === key)) mergedExternalIds.push(externalId)
      }
      externalIdsByEntity.delete(sourceEntityId)
      externalIdsByEntity.set(targetEntityId, mergedExternalIds)
      let redirectedEdges = 0
      let removedSelfEdges = 0
      for (const edge of edges) {
        if (edge.sourceEntityId === sourceEntityId) {
          edge.sourceEntityId = targetEntityId
          edge.sourceId = targetEntityId
          redirectedEdges += 1
        }
        if (edge.targetEntityId === sourceEntityId) {
          edge.targetEntityId = targetEntityId
          edge.targetId = targetEntityId
          redirectedEdges += 1
        }
        if (edge.sourceEntityId === edge.targetEntityId) {
          edge.temporal.invalidAt = new Date()
          removedSelfEdges += 1
        }
      }
      let movedMentions = 0
      for (const mention of mentions) {
        if (mention.entityId === sourceEntityId) {
          mention.entityId = targetEntityId
          movedMentions += 1
        }
      }
      const updatedTarget: SemanticEntity = {
        ...target,
        aliases: [...new Set([...target.aliases, source.name, ...source.aliases])],
        externalIds: mergedExternalIds,
        metadata: { ...source.metadata, ...target.metadata, ...(metadata ?? {}) },
      }
      const mergedSource: SemanticEntity = {
        ...source,
        status: 'merged',
        mergedIntoEntityId: targetEntityId,
        temporal: { ...source.temporal, invalidAt: new Date() },
      }
      entities.set(targetEntityId, updatedTarget)
      entities.set(sourceEntityId, mergedSource)
      return {
        target: {
          id: updatedTarget.id,
          name: updatedTarget.name,
          entityType: updatedTarget.entityType,
          aliases: updatedTarget.aliases,
          externalIds: mergedExternalIds,
          edgeCount: edges.filter(edge => edge.sourceEntityId === targetEntityId || edge.targetEntityId === targetEntityId).length,
          metadata: updatedTarget.metadata,
          createdAt: updatedTarget.temporal.createdAt,
          validAt: updatedTarget.temporal.validAt,
          topEdges: [],
        },
        sourceEntityId,
        targetEntityId,
        redirectedEdges,
        redirectedFacts: 0,
        redirectedGraphEdges: redirectedEdges,
        movedMentions,
        movedExternalIds: sourceExternalIds.length,
        removedSelfEdges,
      }
    }),
    deleteEntityReferences: vi.fn().mockImplementation(async (entityId: string, opts = {}) => {
      const mode = opts.mode ?? 'invalidate'
      const matchingEdges = edges.filter(edge => edge.sourceEntityId === entityId || edge.targetEntityId === entityId)
      const matchingMentions = mentions.filter(mention => mention.entityId === entityId)
      const matchingExternalIds = externalIdsByEntity.get(entityId) ?? []
      if (mode === 'purge') {
        entities.delete(entityId)
        for (const externalId of matchingExternalIds) externalEntityIdByKey.delete(externalIdKey(externalId))
        externalIdsByEntity.delete(entityId)
      } else {
        const entity = entities.get(entityId)
        if (entity) {
          entities.set(entityId, {
            ...entity,
            status: 'invalidated',
            temporal: { ...entity.temporal, invalidAt: new Date() },
          })
        }
      }
      for (const edge of matchingEdges) edge.temporal.invalidAt = new Date()
      return {
        entityId,
        mode,
        deletedEdges: matchingEdges.length,
        deletedFacts: 0,
        deletedGraphEdges: matchingEdges.length,
        deletedMentions: matchingMentions.length,
        deletedExternalIds: matchingExternalIds.length,
      }
    }),
    searchEntities: vi.fn().mockImplementation(async () => [...entities.values()].map(attachExternalIds)),
    searchEntitiesHybrid: vi.fn().mockImplementation(async (query: string) => {
      const normalized = query
        .replace(/[Ææ]/g, 'ae')
        .replace(/[Œœ]/g, 'oe')
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
      const exact = [...entities.values()]
        .filter(e =>
          e.name.toLowerCase() === query.toLowerCase()
          || e.aliases.some(a => a.toLowerCase() === query.toLowerCase())
          || mentions.some(m => m.entityId === e.id && m.normalizedSurfaceText === normalized)
        )
        .map(e => ({ ...attachExternalIds(e), metadata: { ...e.metadata, _similarity: 1 } }))
      return exact.length > 0
        ? exact
        : [...entities.values()].map(e => ({ ...attachExternalIds(e), metadata: { ...e.metadata, _similarity: 0.5 } }))
    }),
    upsertEdge: vi.fn().mockImplementation(async (e: SemanticEdge) => {
      edges.push(e)
      return e
    }),
    getEntitiesBatch: vi.fn().mockImplementation(async (ids: string[]) => {
      return ids
        .map(id => entities.get(id))
        .filter((entity): entity is SemanticEntity => !!entity)
        .map(attachExternalIds)
    }),
    getEdges: vi.fn().mockImplementation(async (entityId: string, direction: string = 'both') => {
      return edges.filter(e => {
        if (direction === 'out') return e.sourceEntityId === entityId
        if (direction === 'in') return e.targetEntityId === entityId
        return e.sourceEntityId === entityId || e.targetEntityId === entityId
      })
    }),
    getEdgesBatch: vi.fn().mockImplementation(async (entityIds: string[], direction: string = 'both') => {
      return edges.filter(e => {
        const matchSource = entityIds.includes(e.sourceEntityId)
        const matchTarget = entityIds.includes(e.targetEntityId)
        if (direction === 'out') return matchSource
        if (direction === 'in') return matchTarget
        return matchSource || matchTarget
      })
    }),
    findEdges: vi.fn().mockResolvedValue([]),
    invalidateEdge: vi.fn(),
    upsertEntityChunkMentions: vi.fn().mockImplementation(async (rows: MockMention[]) => {
      mentions.push(...rows)
    }),
  }
  return store
}

function mockEmbedding() {
  let counter = 0
  return {
    name: 'mock-embed',
    dimensions: 10,
    embed: vi.fn().mockImplementation(async (input: { texts: string[] }) => {
      return input.texts.map(() => {
        counter++
        const vec = new Array(10).fill(0)
        vec[counter % 10] = 1.0
        return vec
      })
    }),
  }
}

describe('createKnowledgeGraphBridge', () => {
  describe('developer seeding', () => {
    it('upserts and resolves entities by deterministic external ID', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const externalId: ExternalId = {
        id: 'ryan@example.com',
        type: 'email',
      }

      const seeded = await bridge.upsertEntity!({
        name: 'Ryan Musser',
        entityType: 'person',
        externalIds: [externalId],
      })
      const resolved = await bridge.resolveEntity!({ externalId }, testScope)

      expect(seeded.externalIds).toEqual([expect.objectContaining({
        id: 'ryan@example.com',
        type: 'email',
        encoding: 'none',
      })])
      expect(resolved?.id).toBe(seeded.id)
      expect(store.findEntityByExternalId).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ryan@example.com', type: 'email' }),
        testScope,
      )
    })

    it('uses external IDs before fuzzy entity creation when seeding facts', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const slackId: ExternalId = {
        id: 'U123',
        type: 'slack_user_id',
      }

      const jane = await bridge.upsertEntity!({
        name: 'Jane Doe',
        entityType: 'person',
        externalIds: [slackId],
      })

      const fact = await bridge.upsertFact!({
        source: { name: 'J. Doe', entityType: 'person', externalId: slackId },
        relation: 'works at',
        target: { name: 'TypeGraph', entityType: 'organization' },
        evidenceText: 'J. Doe works at TypeGraph.',
      })

      const people = [...entities.values()].filter(entity => entity.entityType === 'person')
      expect(people).toHaveLength(1)
      expect(people[0]?.id).toBe(jane.id)
      expect(people[0]?.aliases).toContain('J. Doe')
      expect(fact.sourceEntityId).toBe(jane.id)
      expect(fact.relation).toBe('WORKS_FOR')
    })

    it('does not fuzzy-merge distinct explicit external IDs even when names match', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const first = await bridge.upsertEntity!({
        name: 'Enterprise SSO reliability',
        entityType: 'issue',
        externalIds: [{ type: 'demo_concept_id', id: 'enterprise_sso_reliability' }],
      })
      const second = await bridge.upsertEntity!({
        name: 'Enterprise SSO reliability',
        entityType: 'issue',
        externalIds: [{ type: 'linear_issue_id', id: 'SE-245' }],
      })

      expect(second.id).not.toBe(first.id)
      expect(entities.size).toBe(2)
      expect(await bridge.resolveEntity!({ externalId: { type: 'demo_concept_id', id: 'enterprise_sso_reliability' } }, testScope))
        .toMatchObject({ id: first.id })
      expect(await bridge.resolveEntity!({ externalId: { type: 'linear_issue_id', id: 'SE-245' } }, testScope))
        .toMatchObject({ id: second.id })
    })

    it('keeps SE-245 and enterprise SSO reliability separate when seeding references', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.upsertEntity!({
        name: 'Enterprise SSO reliability',
        entityType: 'concept',
        description: 'Reliability criterion for enterprise SSO, session timeout, and auth token refresh behavior.',
        externalIds: [{ type: 'demo_concept_id', id: 'enterprise_sso_reliability' }],
      })

      const fact = await bridge.upsertFact!({
        source: {
          name: 'SE-245 Beacon SSO technical Q&A',
          entityType: 'issue',
          description: 'Beacon sales engineering task about enterprise SSO timeout behavior.',
          externalIds: [{ type: 'linear_issue_id', id: 'SE-245' }],
        },
        relation: 'REFERENCES',
        target: {
          name: 'Enterprise SSO reliability',
          entityType: 'concept',
          externalIds: [{ type: 'demo_concept_id', id: 'enterprise_sso_reliability' }],
        },
        description: 'SE-245 references enterprise SSO reliability concerns.',
      })

      expect(fact.sourceEntityId).not.toBe(fact.targetEntityId)
      expect(edges).toHaveLength(1)
      expect(entities.size).toBe(2)
    })

    it('returns typed client errors for single self-edge writes', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const externalId: ExternalId = { type: 'demo_id', id: 'same-entity' }

      await bridge.upsertEntity!({
        name: 'Same Entity',
        entityType: 'concept',
        externalIds: [externalId],
      })

      await expect(bridge.upsertFact!({
        source: { name: 'Same Entity', entityType: 'concept', externalId },
        relation: 'REFERENCES',
        target: { name: 'Same Entity', entityType: 'concept', externalId },
      })).rejects.toMatchObject({
        name: 'GraphSelfEdgeError',
        code: 'GRAPH_SELF_EDGE',
        statusHint: 400,
      })

      await expect(bridge.upsertEdge!({
        source: { name: 'Same Entity', entityType: 'concept', externalId },
        relation: 'REFERENCES',
        target: { name: 'Same Entity', entityType: 'concept', externalId },
      })).rejects.toBeInstanceOf(GraphSelfEdgeError)
    })

    it('skips recoverable self-edges in bulk graph writes and continues valid items', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const same: ExternalId = { type: 'demo_id', id: 'same-entity' }
      const alice: ExternalId = { type: 'email', id: 'alice@example.com' }

      await bridge.upsertEntity!({ name: 'Same Entity', entityType: 'concept', externalIds: [same] })

      const facts = await bridge.upsertFacts!([
        {
          source: { name: 'Same Entity', entityType: 'concept', externalId: same },
          relation: 'REFERENCES',
          target: { name: 'Same Entity', entityType: 'concept', externalId: same },
        },
        {
          source: { name: 'Alice', entityType: 'person', externalId: alice },
          relation: 'WORKS_FOR',
          target: { name: 'TypeGraph', entityType: 'organization' },
          description: 'Alice works for TypeGraph.',
        },
      ])

      const seededEdges = await bridge.upsertEdges!([
        {
          source: { name: 'Same Entity', entityType: 'concept', externalId: same },
          relation: 'REFERENCES',
          target: { name: 'Same Entity', entityType: 'concept', externalId: same },
        },
        {
          source: { name: 'Alice', entityType: 'person', externalId: alice },
          relation: 'SUPPORTS',
          target: { name: 'TypeGraph', entityType: 'organization' },
        },
      ])

      expect(facts).toHaveLength(1)
      expect(facts[0]?.description).toBe('Alice works for TypeGraph.')
      expect(seededEdges).toHaveLength(1)
      expect(seededEdges[0]?.relation).toBe('SUPPORTS')
      expect(edges.filter(edge => edge.sourceEntityId === edge.targetEntityId)).toHaveLength(0)
    })

    it('merges entities through the graph bridge and rewrites references', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['source', makeEntity('source', 'Pat Old', 'person')],
        ['target', makeEntity('target', 'Pat Canonical', 'person')],
        ['acme', makeEntity('acme', 'Acme', 'organization')],
      ])
      const edges = [makeEdge('edge-1', 'source', 'acme', 'WORKS_FOR')]
      const mentions: MockMention[] = [{
        entityId: 'source',
        documentId: 'document-1',
        chunkIndex: 0,
        bucketId: 'bucket-1',
        mentionType: 'entity',
        surfaceText: 'Pat Old',
        normalizedSurfaceText: 'pat old',
      }]
      const store = mockStore(entities, edges, mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const result = await bridge.mergeEntities!({
        sourceEntityId: 'source',
        targetEntityId: 'target',
        metadata: { reviewed: true },
      })

      expect(result.sourceEntityId).toBe('source')
      expect(result.targetEntityId).toBe('target')
      expect(result.redirectedEdges).toBe(1)
      expect(result.movedMentions).toBe(1)
      expect(edges[0]!.sourceEntityId).toBe('target')
      expect(mentions[0]!.entityId).toBe('target')
      expect(entities.get('source')?.status).toBe('merged')
      expect(entities.get('source')?.mergedIntoEntityId).toBe('target')
      expect(entities.get('target')?.aliases).toContain('Pat Old')
      expect(entities.get('target')?.metadata.reviewed).toBe(true)
    })

    it('invalidates and purges entities through the graph bridge', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['pat', makeEntity('pat', 'Pat', 'person')],
        ['acme', makeEntity('acme', 'Acme', 'organization')],
      ])
      const edges = [makeEdge('edge-1', 'pat', 'acme', 'WORKS_FOR')]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const invalidated = await bridge.deleteEntity!('pat', { mode: 'invalidate' })
      expect(invalidated.mode).toBe('invalidate')
      expect(entities.get('pat')?.status).toBe('invalidated')
      expect(edges[0]!.temporal.invalidAt).toBeInstanceOf(Date)

      const defaultMode = await bridge.deleteEntity!('pat', null)
      expect(defaultMode.mode).toBe('invalidate')

      const purged = await bridge.deleteEntity!('acme', { mode: 'purge' })
      expect(purged.mode).toBe('purge')
      expect(entities.has('acme')).toBe(false)
    })

    it('treats null graph search opts as omitted', async () => {
      const store = mockStore()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await expect(bridge.searchFacts!('query', null)).resolves.toEqual([])
      await expect(bridge.getEntity!('missing', null)).resolves.toBeNull()
      await expect(bridge.getEdges!('missing', null)).resolves.toEqual([])
    })

    it('rejects external ID conflicts instead of reassigning identity', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const email: ExternalId = {
        id: 'alice@example.com',
        type: 'email',
      }

      await bridge.upsertEntity!({
        id: 'ent_alice',
        name: 'Alice',
        entityType: 'person',
        externalIds: [email],
      })

      await expect(bridge.upsertEntity!({
        id: 'ent_bob',
        name: 'Bob',
        entityType: 'person',
        externalIds: [email],
      })).rejects.toThrow(/External IDs resolve to entity ent_alice/)
    })

    it('resolves entity scope from entity IDs and external IDs with OR semantics', async () => {
      const email: ExternalId = { id: 'pat@example.com', type: 'email' }
      const github: ExternalId = { id: 'pm', type: 'github_handle' }
      const entities = new Map<string, SemanticEntity>([
        ['ent-manual', makeEntity('ent-manual', 'Manual Anchor', 'person')],
        ['ent-email', { ...makeEntity('ent-email', 'Pat Email', 'person'), externalIds: [email] }],
        ['ent-github', { ...makeEntity('ent-github', 'Pat GitHub', 'person'), externalIds: [github] }],
      ])
      const store = mockStore(entities)
      for (const entity of entities.values()) {
        if (entity.externalIds?.length) {
          await store.upsertEntityExternalIds!(entity.id, entity.externalIds, testScope)
        }
      }
      const chunkEdges: SemanticEntityChunkEdge[] = [
        {
          id: 'edge-manual',
          entityId: 'ent-manual',
          chunkRef: { bucketId: 'bucket-1', documentId: 'document-1', chunkIndex: 0, embeddingModel: 'mock-embed' },
          weight: 1,
          mentionCount: 1,
          surfaceTexts: ['Manual Anchor'],
          mentionTypes: ['entity'],
        },
        {
          id: 'edge-email',
          entityId: 'ent-email',
          chunkRef: { bucketId: 'bucket-1', documentId: 'document-2', chunkIndex: 0, embeddingModel: 'mock-embed' },
          weight: 1,
          mentionCount: 1,
          surfaceTexts: ['Pat Email'],
          mentionTypes: ['entity'],
        },
        {
          id: 'edge-github',
          entityId: 'ent-github',
          chunkRef: { bucketId: 'bucket-1', documentId: 'document-3', chunkIndex: 0, embeddingModel: 'mock-embed' },
          weight: 1,
          mentionCount: 1,
          surfaceTexts: ['Pat GitHub'],
          mentionTypes: ['entity'],
        },
      ]
      Object.assign(store, {
        getChunkEdgesForEntities: vi.fn().mockImplementation(async (entityIds: string[]) =>
          chunkEdges.filter(edge => entityIds.includes(edge.entityId))
        ),
      })
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const resolved = await bridge.resolveEntityScope!({
        entityIds: ['ent-manual'],
        externalIds: [email, github],
      }, testScope)

      expect(resolved.entityIds).toEqual(expect.arrayContaining(['ent-manual', 'ent-email', 'ent-github']))
      expect(resolved.chunkRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ documentId: 'document-1' }),
        expect.objectContaining({ documentId: 'document-2' }),
        expect.objectContaining({ documentId: 'document-3' }),
      ]))
      expect(store.getChunkEdgesForEntities).toHaveBeenCalledWith(
        expect.arrayContaining(['ent-manual', 'ent-email', 'ent-github']),
        expect.objectContaining({ scope: testScope }),
      )
    })

    it('preserves graph scope and external IDs in graph exploration reads', async () => {
      const email: ExternalId = { id: 'casey@example.com', type: 'email' }
      const entities = new Map<string, SemanticEntity>([
        ['ent-casey', { ...makeEntity('ent-casey', 'Casey', 'person'), externalIds: [email] }],
        ['ent-acme', makeEntity('ent-acme', 'Acme', 'organization')],
      ])
      const edges = [makeEdge('edge-casey-acme', 'ent-casey', 'ent-acme', 'WORKS_FOR')]
      const store = mockStore(entities, edges)
      await store.upsertEntityExternalIds!('ent-casey', [email], testScope)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const scopedIdentity = {
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        userId: 'user-1',
        graphId: 'user_user1',
        graphIds: ['user_user1', 'employee', 'public'],
      }
      const asOf = new Date('2026-01-15T00:00:00Z')

      const edgeResults = await bridge.getEdges!('ent-casey', scopedIdentity)
      const subgraph = await bridge.getSubgraph!({
        entityIds: ['ent-casey'],
        depth: 1,
        identity: scopedIdentity,
        asOf,
        includeInvalidated: true,
      })

      expect(edgeResults).toHaveLength(1)
      expect(store.getEdges).toHaveBeenCalledWith(
        'ent-casey',
        'both',
        expect.objectContaining({
          tenantId: 'tenant-1',
          organizationId: 'org-1',
          userId: 'user-1',
          graphId: 'user_user1',
          graphIds: ['user_user1', 'employee', 'public'],
        }),
        expect.any(Object),
      )
      expect(store.getEntitiesBatch).toHaveBeenCalledWith(
        expect.arrayContaining(['ent-casey', 'ent-acme']),
        expect.objectContaining({
          graphId: 'user_user1',
          graphIds: ['user_user1', 'employee', 'public'],
        }),
      )
      expect(store.getEdgesBatch).toHaveBeenCalledWith(
        expect.arrayContaining(['ent-casey']),
        'both',
        expect.objectContaining({
          graphId: 'user_user1',
          graphIds: ['user_user1', 'employee', 'public'],
        }),
        expect.objectContaining({ asOf, includeInvalidated: true }),
      )
      expect(subgraph.entities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'ent-casey',
          externalIds: [expect.objectContaining({ type: 'email', id: 'casey@example.com' })],
        }),
      ]))
    })
  })

  describe('addTriple', () => {
	    it('creates entities, edge, and entity↔chunk mentions from a triple', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const mentions: MockMention[] = []
      const store = mockStore(entities, edges, mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'supported',
        object: 'bone health',
        relationshipDescription: 'Vitamin D supports bone health in elderly patients.',
        evidenceText: 'Vitamin D supports bone health in elderly patients.',
        chunkId: 'chk-vitd-0',
        content: 'Vitamin D supports bone health in elderly patients.',
        bucketId: 'bucket-1',
        documentId: 'document-1',
        chunkIndex: 0,
      })

      // Two entities created, then profile evidence is updated from the stored fact.
      expect(store.upsertEntity).toHaveBeenCalledTimes(4)
      expect(entities.size).toBe(2)

      // One edge created: content is not embedded in metadata.
      expect(store.upsertEdge).toHaveBeenCalledTimes(1)
      expect(edges).toHaveLength(1)

      const edge = edges[0]!
      expect(edge.relation).toBe('SUPPORTS')
      expect(edge.metadata.content).toBeUndefined()
      expect(edge.metadata.bucketId).toBeUndefined()
      expect(edge.metadata.chunkIndex).toBeUndefined()
      expect(edge.metadata).toEqual(expect.objectContaining({
        relationshipDescription: 'Vitamin D supports bone health in elderly patients.',
        evidenceText: 'Vitamin D supports bone health in elderly patients.',
        chunkId: 'chk-vitd-0',
      }))

      // Two mentions written to the junction (subject + object for the same chunk)
      expect(store.upsertEntityChunkMentions).toHaveBeenCalled()
      expect(mentions).toHaveLength(2)
      expect(mentions.every(m => m.documentId === 'document-1' && m.chunkIndex === 0 && m.bucketId === 'bucket-1')).toBe(true)
	      expect(mentions.map(m => m.mentionType).sort()).toEqual(['object', 'subject'])
	    })

    it('uses high-confidence secondary types for predicate validation without changing canonical type', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'TypeGraph',
        subjectType: 'organization',
        subjectTypeCandidates: [
          { type: 'organization', confidence: 0.8 },
          { type: 'product', confidence: 0.72 },
          { type: 'technology', confidence: 0.68 },
        ],
        predicate: 'INTEGRATES_WITH',
        object: 'Okta SSO',
        objectType: 'technology',
        relationshipDescription: 'TypeGraph integrates with Okta SSO.',
        evidenceText: 'TypeGraph integrates with Okta SSO.',
        content: 'TypeGraph integrates with Okta SSO.',
        bucketId: 'bucket-1',
        documentId: 'document-1',
        chunkIndex: 0,
      })

      const typegraph = [...entities.values()].find(entity => entity.name === 'TypeGraph')!
      expect(typegraph.entityType).toBe('organization')
      expect(typegraph.metadata.typeCandidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'product' }),
        expect.objectContaining({ type: 'technology' }),
      ]))
      expect(edges[0]!.metadata.predicateValidation).toBeUndefined()
    })

    it('propagates access scope and identity scope to graph rows from a triple', async () => {
      const cases = [
        { label: 'tenant', identity: { tenantId: 'tenant-1' }, accessScope: [{ type: 'organization', id: 'org-1' }] },
        { label: 'group', identity: { groupId: 'group-1' }, accessScope: [{ type: 'group', id: 'group-1' }] },
        { label: 'user', identity: { userId: 'user-1' }, accessScope: [{ type: 'user', id: 'user-1' }] },
        { label: 'agent', identity: { agentId: 'agent-1' }, accessScope: [{ type: 'agent', id: 'agent-1' }] },
        { label: 'thread', identity: { threadId: 'thread-1' }, accessScope: [{ type: 'thread', id: 'thread-1' }] },
      ]

      for (const item of cases) {
        const entities = new Map<string, SemanticEntity>()
        const edges: SemanticEdge[] = []
        const store = mockStore(entities, edges)
        store.upsertGraphEdges = vi.fn().mockResolvedValue(undefined)
        store.upsertFactRecord = vi.fn().mockImplementation(async fact => fact)
        const bridge = createKnowledgeGraphBridge({
          memoryStore: store,
          embedding: mockEmbedding(),
          scope: testScope,
        })

        await bridge.addTriple!({
          subject: `Subject ${item.label}`,
          subjectType: 'person',
          predicate: 'leads',
          object: `Object ${item.label}`,
          objectType: 'organization',
          content: `Subject ${item.label} leads Object ${item.label}.`,
          bucketId: 'bucket-1',
          documentId: `document-${item.label}`,
          chunkIndex: 0,
          ...item.identity,
          accessScope: item.accessScope,
        })

        expect([...entities.values()].every(entity =>
          entity.accessScope === item.accessScope
          && Object.entries(item.identity).every(([key, value]) => entity.scope[key as keyof typeof item.identity] === value)
        )).toBe(true)
        expect(edges.every(edge =>
          edge.accessScope === item.accessScope
          && Object.entries(item.identity).every(([key, value]) => edge.scope[key as keyof typeof item.identity] === value)
        )).toBe(true)
        expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
          accessScope: item.accessScope,
          scope: expect.objectContaining(item.identity),
        }))
        expect(store.upsertGraphEdges).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({
            accessScope: item.accessScope,
            scope: expect.objectContaining(item.identity),
          }),
        ]))
      }
    })

    it('writes canonical temporal fields and supersession keys to seeded facts', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn().mockImplementation(async fact => fact)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const fact = await bridge.upsertFact!({
        source: { name: 'Jane Doe', entityType: 'person' },
        relation: 'works_at',
        target: { name: 'Acme Corp', entityType: 'organization' },
        validAt: '2026-01-01T00:00:00Z',
        invalidAt: '2026-02-01T00:00:00Z',
        supersessionKey: 'crelate:contact:123:works_at_current',
        evidenceText: 'Crelate current position for Jane Doe: employee at Acme Corp.',
      })

      expect(edges[0]?.temporal.validAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
      expect(edges[0]?.temporal.invalidAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z')
      expect(edges[0]?.supersessionKey).toBe('crelate:contact:123:works_at_current')
      expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
        validAt: new Date('2026-01-01T00:00:00Z'),
        invalidAt: new Date('2026-02-01T00:00:00Z'),
        supersessionKey: 'crelate:contact:123:works_at_current',
      }))
      expect(fact.validAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
      expect(fact.invalidAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z')
      expect(fact.supersessionKey).toBe('crelate:contact:123:works_at_current')
    })

    it('uses supersessionKey and validAt as the deterministic graph fact version identity', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn().mockImplementation(async fact => fact)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const input = {
        source: { name: 'Jane Doe', entityType: 'person' },
        relation: 'works_at',
        target: { name: 'Acme Corp', entityType: 'organization' },
        validAt: '2026-02-01T00:00:00Z',
        supersessionKey: 'hubspot:12345:contact:111:works_at',
      }

      await bridge.upsertFact!(input)
      await bridge.upsertFact!({
        ...input,
        evidenceText: 'Repeated drip sync of the same HubSpot deal stage version.',
      })

      const storedFactCalls = (store.upsertFactRecord as ReturnType<typeof vi.fn>).mock.calls
      const factIds = storedFactCalls.map(([fact]) => fact.id)
      const edgeIds = edges.map(edge => edge.id)
      expect(new Set(factIds).size).toBe(1)
      expect(new Set(edgeIds).size).toBe(1)
      expect(storedFactCalls[0]?.[0].supersessionKey).toBe('hubspot:12345:contact:111:works_at')
      expect(storedFactCalls[0]?.[0].validAt.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    })

    it('does not create temporal versions for facts without a supersessionKey', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn().mockImplementation(async fact => fact)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.upsertFact!({
        source: { name: 'Jane Doe', entityType: 'person' },
        relation: 'works_at',
        target: { name: 'Acme Corp', entityType: 'organization' },
        validAt: '2026-01-01T00:00:00Z',
      })
      await bridge.upsertFact!({
        source: { name: 'Jane Doe', entityType: 'person' },
        relation: 'works_at',
        target: { name: 'Acme Corp', entityType: 'organization' },
        validAt: '2026-02-01T00:00:00Z',
      })

      const storedFactCalls = (store.upsertFactRecord as ReturnType<typeof vi.fn>).mock.calls
      expect(new Set(storedFactCalls.map(([fact]) => fact.id)).size).toBe(1)
      expect(storedFactCalls.every(([fact]) => fact.supersessionKey === undefined)).toBe(true)
    })

    it('passes temporal query filters to graph fact storage', async () => {
      const store = mockStore()
      store.searchFacts = vi.fn().mockResolvedValue([])
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })
      const asOf = new Date('2026-01-15T00:00:00Z')

      await bridge.searchFacts!('deal stage', {
        tenantId: 'tenant-1',
        graphId: 'employee',
        asOf,
        includeInvalidated: false,
        limit: 5,
      })

      expect(store.searchFacts).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ tenantId: 'tenant-1', graphId: 'employee' }),
        5,
        expect.objectContaining({ asOf, includeInvalidated: false }),
      )
    })

    it('does not merge same-name entities across groups in one process', async () => {
      const entities = new Map<string, SemanticEntity>()
      const store = mockStore(entities)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addEntityMentions!([{
        name: 'TypeGraph',
        type: 'organization',
        content: 'TypeGraph appears in group A.',
        bucketId: 'bucket-1',
        documentId: 'document-a',
        chunkIndex: 0,
        groupId: 'group-a',
      }])
      await bridge.addEntityMentions!([{
        name: 'TypeGraph',
        type: 'organization',
        content: 'TypeGraph appears in group B.',
        bucketId: 'bucket-1',
        documentId: 'document-b',
        chunkIndex: 0,
        groupId: 'group-b',
      }])

      const typegraphEntities = [...entities.values()].filter(entity => entity.name === 'TypeGraph')
      expect(typegraphEntities).toHaveLength(2)
      expect(new Set(typegraphEntities.map(entity => entity.scope.groupId))).toEqual(new Set(['group-a', 'group-b']))
    })

	    it('stores aliases as searchable surface mentions', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const mentions: MockMention[] = []
      const store = mockStore(entities, edges, mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Cæsar Simon',
        subjectType: 'person',
        subjectAliases: ['Conway', 'Cole Conway', 'Cousin Cæsar'],
        predicate: 'collaborated_with',
        object: 'Steve Sharp',
        objectType: 'person',
        content: 'Cæsar Simon was calling himself Cole Conway in company with Steve Sharp.',
        bucketId: 'bucket-1',
        documentId: 'document-47558',
        chunkIndex: 24,
      })

      expect(mentions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          mentionType: 'alias',
          surfaceText: 'Cole Conway',
          normalizedSurfaceText: 'cole conway',
        }),
      ]))

      const found = await bridge.searchEntities!('Cole Conway', testScope, 10)
      expect(found[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundBySurname = await bridge.searchEntities!('Conway', testScope, 10)
      expect(foundBySurname[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundByAlias = await bridge.searchEntities!('Cousin Cæsar', testScope, 10)
      expect(foundByAlias[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))

      const foundByAsciiAlias = await bridge.searchEntities!('Cousin Caesar', testScope, 10)
      expect(foundByAsciiAlias[0]).toEqual(expect.objectContaining({ name: 'Cæsar Simon' }))
    })

    it('routes alias predicates into entity aliases instead of graph edges', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Cæsar Simon',
        subjectType: 'person',
        subjectAliases: ['Conway'],
        predicate: 'known_as',
        object: 'Conway',
        objectType: 'person',
        objectAliases: ['Cæsar Simon'],
        content: 'Cæsar Simon was known as Conway.',
        bucketId: 'bucket-1',
        documentId: 'document-1',
        chunkIndex: 0,
      })

      expect(edges).toHaveLength(0)
      expect(entities.size).toBe(1)
      expect([...entities.values()][0]?.aliases).toContain('Conway')
    })

    it('stores entity mentions even when no relationship is available', async () => {
      const entities = new Map<string, SemanticEntity>()
      const mentions: MockMention[] = []
      const store = mockStore(entities, [], mentions)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addEntityMentions!([{
        name: 'Cole Conway',
        type: 'person',
        aliases: ['Conway'],
        description: 'A name used by Cæsar Simon in Paducah.',
        content: 'At twenty years of age Cousin Cæsar was calling himself Cole Conway.',
        bucketId: 'bucket-1',
        documentId: 'document-1',
        chunkIndex: 0,
      }])

      expect(entities.size).toBe(1)
      expect(mentions).toEqual(expect.arrayContaining([
        expect.objectContaining({ mentionType: 'entity', surfaceText: 'Cole Conway' }),
        expect.objectContaining({ mentionType: 'alias', surfaceText: 'Conway' }),
      ]))
    })

    it('normalizes predicate to SCREAMING_SNAKE_CASE', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Alice',
        predicate: 'works at',
        object: 'Acme Corp',
        content: 'Alice works at Acme Corp.',
        bucketId: 'source-2',
      })

      expect(edges[0]!.relation).toBe('WORKS_FOR')
    })

    it('rejects invented predicates before persistence', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Chaacmol',
        predicate: 'FUNERAL_CHAMBER_IN',
        object: 'Chichen-Itza',
        content: 'Chaacmol is associated with a funeral chamber at Chichen-Itza.',
        bucketId: 'bucket-1',
      })

      expect(edges).toHaveLength(0)
      expect(store.upsertFactRecord).not.toHaveBeenCalled()
    })

    it('normalizes inverse predicates by swapping subject and object', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Chaacmol',
        predicate: 'KILLED_BY',
        object: 'Aac',
        relationshipDescription: 'Chaacmol was killed by Aac.',
        evidenceText: 'Chaacmol was killed by Aac.',
        content: 'Chaacmol was killed by Aac.',
        bucketId: 'bucket-1',
      })

      const edge = edges[0]!
      const entityById = new Map([...entities.values()].map(entity => [entity.id, entity]))
      expect(edge.relation).toBe('KILLED')
      expect(entityById.get(edge.sourceEntityId)?.name).toBe('Aac')
      expect(entityById.get(edge.targetEntityId)?.name).toBe('Chaacmol')
    })

    it('drops obvious directional contradictions instead of persisting them', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      store.upsertFactRecord = vi.fn()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Chaacmol',
        predicate: 'KILLED',
        object: 'Aac',
        relationshipDescription: 'Aac killed Chaacmol with a spear.',
        evidenceText: 'Aac killed Chaacmol with a spear.',
        content: 'Aac killed Chaacmol with a spear.',
        bucketId: 'bucket-1',
      })

      expect(edges).toHaveLength(0)
      expect(store.upsertFactRecord).not.toHaveBeenCalled()
    })

    it('normalizes gendered spouse predicates to MARRIED before persistence', async () => {
      const edges: SemanticEdge[] = []
      const store = mockStore(new Map(), edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      await bridge.addTriple!({
        subject: 'Moo',
        predicate: 'WIFE_OF',
        object: 'Chaacmol',
        relationshipDescription: 'Moo was married to Chaacmol.',
        evidenceText: 'Moo was married to Chaacmol.',
        content: 'Moo was married to Chaacmol.',
        bucketId: 'bucket-1',
      })

      expect(edges[0]!.relation).toBe('MARRIED')
    })

    it('resolves duplicate entities on repeated addTriple calls', async () => {
      const entities = new Map<string, SemanticEntity>()
      const edges: SemanticEdge[] = []
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      // First triple: creates "Vitamin D" and "osteoporosis"
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'supported',
        object: 'bone health',
        content: 'Chunk 1',
        bucketId: 'source-1',
      })

      const firstEntityCount = entities.size

      // Second triple: "Vitamin D" should be resolved to existing entity
      await bridge.addTriple!({
        subject: 'Vitamin D',
        predicate: 'supported',
        object: 'skeletal health',
        content: 'Chunk 2',
        bucketId: 'source-1',
      })

      // Should have 3 entities (Vitamin D reused, + bone health + skeletal health)
      expect(firstEntityCount).toBe(2)
      expect(entities.size).toBe(3)
      // 2 explicit edges, 0 CO_OCCURS (all entities have direct edges)
      expect(edges).toHaveLength(2)
    })
  })

  describe('backfill', () => {
    it('creates entity-chunk graph edges, fact records, and profiles from existing rows', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['alice', makeEntity('alice', 'Alice', 'person')],
        ['beta', makeEntity('beta', 'Beta Inc', 'organization')],
      ])
      const edges = [makeEdge('edge-1', 'alice', 'beta', 'WORKS_FOR')]
      const store = mockStore(entities, edges)
      Object.assign(store, {
        listChunkBackfillRecords: vi.fn().mockImplementation(async ({ offset }: { offset?: number }) => {
          if ((offset ?? 0) > 0) return []
          return [{
            chunkId: 'chk-1',
            bucketId: 'bucket-1',
            documentId: 'document-1',
            chunkIndex: 0,
            embeddingModel: 'mock-embed',
            content: 'Alice works at Beta Inc.',
            metadata: { source: 'test' },
            userId: 'test-user',
          }]
        }),
        listChunkMentionBackfillRows: vi.fn().mockImplementation(async ({ offset }: { offset?: number }) => {
          if ((offset ?? 0) > 0) return []
          return [
            {
              chunkId: 'chk-1',
              bucketId: 'bucket-1',
              documentId: 'document-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
              content: 'Alice works at Beta Inc.',
              metadata: {},
              userId: 'test-user',
              entityId: 'alice',
              mentionType: 'subject',
              surfaceText: 'Alice',
              confidence: 0.9,
            },
            {
              chunkId: 'chk-1',
              bucketId: 'bucket-1',
              documentId: 'document-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
              content: 'Alice works at Beta Inc.',
              metadata: {},
              userId: 'test-user',
              entityId: 'beta',
              mentionType: 'object',
              surfaceText: 'Beta Inc',
              confidence: 0.9,
            },
          ]
        }),
        listSemanticEdgesForBackfill: vi.fn().mockImplementation(async ({ offset }: { offset?: number } = {}) => {
          if ((offset ?? 0) > 0) return []
          return edges
        }),
        upsertGraphEdges: vi.fn(),
        upsertFactRecord: vi.fn().mockImplementation(async fact => fact),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'chunks_mock',
      })

      const result = await bridge.backfill!(testScope, { batchSize: 10 })

      expect(result.entityChunkEdgesUpserted).toBe(2)
      expect(result.factRecordsUpserted).toBe(1)
      expect(result.entityProfilesUpdated).toBe(2)
      expect(store.upsertGraphEdges).toHaveBeenCalled()
      expect(store.upsertFactRecord).toHaveBeenCalledWith(expect.objectContaining({
        description: 'Alice works for Beta Inc',
      }))
    })
  })

  describe('searchEntities', () => {
    it('embeds query and searches store', async () => {
      const entities = new Map<string, SemanticEntity>()
      entities.set('e1', {
        ...makeEntity('e1', 'Vitamin D', 'supplement'),
        aliases: ['cholecalciferol'],
        metadata: { source: 'test fixture' },
      })
      entities.set('e2', makeEntity('e2', 'Calcium'))
      const edges = [
        makeEdge('edge-1', 'e1', 'e2', 'SUPPORTS'),
        makeEdge('edge-2', 'e1', 'e3', 'IMPROVES'),
      ]

      const store = mockStore(entities, edges)
      ;(store.getEdgesBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
        edges[0]!,
        edges[0]!,
        edges[1]!,
      ])
      const emb = mockEmbedding()
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: emb,
        scope: testScope,
      })

      const results = await bridge.searchEntities!('vitamin supplements', testScope, 5)

      expect(emb.embed).toHaveBeenCalledWith({ texts: ['vitamin supplements'], inputType: 'document' })
      expect(store.searchEntitiesHybrid).toHaveBeenCalled()
      expect(results).toHaveLength(2)
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('name')
      expect(results[0]).toHaveProperty('entityType')
      expect(results[0]).toEqual(expect.objectContaining({
        aliases: ['cholecalciferol'],
        similarity: 0.5,
        edgeCount: 2,
        metadata: expect.objectContaining({ source: 'test fixture' }),
      }))
      expect(results[0]?.metadata).not.toHaveProperty('_similarity')
      expect(results[1]).toEqual(expect.objectContaining({ edgeCount: 1 }))
    })

    it('returns empty array when store does not support searchEntities', async () => {
      const store = mockStore()
      delete (store as any).searchEntities

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const results = await bridge.searchEntities!('query', testScope, 5)
      expect(results).toEqual([])
    })
  })

  describe('searchGraphChunks', () => {
    it('returns ranked chunks and keeps direct entity seeding from hybrid entity lookup', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['adarsh', {
          ...makeEntity('adarsh', 'Adarsh Tadimari', 'person'),
          aliases: [],
          metadata: { description: 'Technical team member at Plotline.' },
        }],
      ])
      const mentions: MockMention[] = [{
        entityId: 'adarsh',
        documentId: 'document-1',
        chunkIndex: 0,
        bucketId: 'bucket-1',
        mentionType: 'entity',
        surfaceText: 'Adarsh',
        normalizedSurfaceText: 'adarsh',
      }]
      const store = mockStore(entities, [], mentions)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue([]),
        searchChunks: vi.fn().mockResolvedValue([]),
        getChunkEdgesForEntities: vi.fn().mockResolvedValue([{
          id: 'edge_chunk_test',
          entityId: 'adarsh',
          chunkRef: {
            chunkId: 'chunk_test',
            bucketId: 'bucket-1',
            documentId: 'document-1',
            chunkIndex: 0,
            embeddingModel: 'mock-embed',
          },
          weight: 1.5,
          mentionCount: 1,
          confidence: 0.9,
          surfaceTexts: ['Adarsh'],
          mentionTypes: ['entity'],
        }]),
        getChunksByRefs: vi.fn().mockResolvedValue([{
          chunkId: 'chunk_test',
          content: 'Adarsh Tadimari is debugging Plotline SDK initialization issues.',
          bucketId: 'bucket-1',
          documentId: 'document-1',
          chunkIndex: 0,
          embeddingModel: 'mock-embed',
          totalChunks: 1,
          metadata: { source: 'test' },
          userId: 'test-user',
        }]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
      })

      const result = await bridge.searchGraphChunks!('Adarsh', testScope, { count: 5 })

      expect(store.searchEntitiesHybrid).toHaveBeenCalledWith(expect.any(String), expect.any(Array), testScope, 5)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({
        chunkId: 'chunk_test',
        bucketId: 'bucket-1',
        documentId: 'document-1',
        chunkIndex: 0,
      }))
      expect(result.results[0]!.score).toBeGreaterThan(0)
      expect(result.trace.entitySeedCount).toBeGreaterThan(0)
      expect(result.trace.selectedEntityIds).toContain('adarsh')
    })

    it('attaches selected graph facts and entity names to evidence chunks', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['tennyson', makeEntity('tennyson', 'Tennyson', 'person')],
        ['maud', makeEntity('maud', 'Maud', 'creative_work')],
      ])
      const edges = [makeEdge('edge-1', 'tennyson', 'maud', 'AUTHORED')]
      const fact: SemanticFactRecord = {
        id: 'fact-1',
        edgeId: 'edge-1',
        sourceEntityId: 'tennyson',
        targetEntityId: 'maud',
        relation: 'AUTHORED',
        description: 'Tennyson wrote Maud',
        weight: 1,
        scope: testScope,
        createdAt: new Date(),
        updatedAt: new Date(),
        similarity: 0.9,
      }
      const store = mockStore(entities, edges)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue([fact]),
        searchChunks: vi.fn().mockResolvedValue([]),
        getChunkEdgesForEntities: vi.fn().mockResolvedValue([
          {
            id: 'edge_chunk_maud_tennyson',
            entityId: 'tennyson',
            chunkRef: {
              chunkId: 'chunk_maud',
              bucketId: 'bucket-1',
              documentId: 'document-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
            },
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Tennyson'],
            mentionTypes: ['subject'],
          },
          {
            id: 'edge_chunk_maud_maud',
            entityId: 'maud',
            chunkRef: {
              chunkId: 'chunk_maud',
              bucketId: 'bucket-1',
              documentId: 'document-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
            },
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Maud'],
            mentionTypes: ['object'],
          },
        ]),
        getChunksByRefs: vi.fn().mockResolvedValue([{
          chunkId: 'chunk_maud',
          content: 'A tiny shell was moralised over by Tennyson in Maud.',
          bucketId: 'bucket-1',
          documentId: 'document-1',
          chunkIndex: 0,
          embeddingModel: 'mock-embed',
          totalChunks: 1,
          metadata: { source: 'test' },
          userId: 'test-user',
        }]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
      })

      const result = await bridge.searchGraphChunks!('Who wrote Maud?', testScope, { count: 5 })

      expect(result.facts).toEqual([expect.objectContaining({ id: 'fact-1', description: 'Tennyson wrote Maud' })])
      expect(result.facts[0]!.metadata?.relevanceScore).toEqual(expect.any(Number))
      expect(result.entities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'tennyson', name: 'Tennyson' }),
        expect.objectContaining({ id: 'maud', name: 'Maud' }),
      ]))
      expect(result.results[0]).not.toHaveProperty('facts')
      expect(result.results[0]).not.toHaveProperty('entities')
      expect(result.trace.finalChunkIds).toEqual(['chunk_maud'])
      expect(result.trace.selectedFactTexts).toEqual([{ id: 'fact-1', content: 'Tennyson wrote Maud' }])
      expect(result.trace.selectedEntityNames).toEqual(expect.arrayContaining([
        { id: 'tennyson', content: 'Tennyson' },
        { id: 'maud', content: 'Maud' },
      ]))
    })

    it('ranks exact entity-constrained facts ahead of weaker adjacent facts and emits chains', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['tennyson', makeEntity('tennyson', 'Tennyson', 'person')],
        ['maud', makeEntity('maud', 'Maud', 'creative_work')],
        ['shell', makeEntity('shell', 'Tiny shell', 'object')],
        ['lizard', makeEntity('lizard', 'Lizard', 'place')],
      ])
      const edges = [
        makeEdge('edge-1', 'tennyson', 'maud', 'AUTHORED'),
        makeEdge('edge-2', 'maud', 'shell', 'MORALISED'),
        makeEdge('edge-3', 'lizard', 'shell', 'CONTAINS'),
      ]
      const facts: SemanticFactRecord[] = [
        {
          id: 'fact-noisy',
          edgeId: 'edge-3',
          sourceEntityId: 'lizard',
          targetEntityId: 'shell',
          relation: 'CONTAINS',
          description: 'Lizard contains a tiny shell',
          weight: 1,
          scope: testScope,
          createdAt: new Date(),
          updatedAt: new Date(),
          similarity: 0.6,
        },
        {
          id: 'fact-maud',
          edgeId: 'edge-1',
          sourceEntityId: 'tennyson',
          targetEntityId: 'maud',
          relation: 'AUTHORED',
          description: 'Tennyson wrote Maud',
          weight: 1,
          scope: testScope,
          createdAt: new Date(),
          updatedAt: new Date(),
          similarity: 0.3,
        },
        {
          id: 'fact-shell',
          edgeId: 'edge-2',
          sourceEntityId: 'maud',
          targetEntityId: 'shell',
          relation: 'MORALISED',
          description: 'Maud moralised a tiny shell',
          weight: 1,
          scope: testScope,
          createdAt: new Date(),
          updatedAt: new Date(),
          similarity: 0.2,
        },
      ]
      const store = mockStore(entities, edges)
      Object.assign(store, {
        searchFacts: vi.fn().mockResolvedValue(facts),
        searchChunks: vi.fn().mockResolvedValue([]),
        getChunkEdgesForEntities: vi.fn().mockResolvedValue([
          {
            id: 'edge_chunk_maud_tennyson',
            entityId: 'tennyson',
            chunkRef: {
              chunkId: 'chunk_maud',
              bucketId: 'bucket-1',
              documentId: 'document-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
            },
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Tennyson'],
            mentionTypes: ['subject'],
          },
          {
            id: 'edge_chunk_maud_maud',
            entityId: 'maud',
            chunkRef: {
              chunkId: 'chunk_maud',
              bucketId: 'bucket-1',
              documentId: 'document-1',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
            },
            weight: 1,
            mentionCount: 1,
            surfaceTexts: ['Maud'],
            mentionTypes: ['object'],
          },
          {
            id: 'edge_chunk_shell',
            entityId: 'shell',
            chunkRef: {
              chunkId: 'chunk_shell',
              bucketId: 'bucket-1',
              documentId: 'document-2',
              chunkIndex: 0,
              embeddingModel: 'mock-embed',
            },
            weight: 0.4,
            mentionCount: 1,
            surfaceTexts: ['shell'],
            mentionTypes: ['object'],
          },
        ]),
        getChunksByRefs: vi.fn().mockResolvedValue([
          {
            chunkId: 'chunk_maud',
            content: 'A tiny shell was moralised over by Tennyson in Maud.',
            bucketId: 'bucket-1',
            documentId: 'document-1',
            chunkIndex: 0,
            embeddingModel: 'mock-embed',
            totalChunks: 1,
            metadata: { source: 'test' },
            userId: 'test-user',
          },
          {
            chunkId: 'chunk_shell',
            content: 'The Lizard coast contains shells.',
            bucketId: 'bucket-1',
            documentId: 'document-2',
            chunkIndex: 0,
            embeddingModel: 'mock-embed',
            totalChunks: 1,
            metadata: { source: 'test' },
            userId: 'test-user',
          },
        ]),
      })

      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
        resolveChunksTable: () => 'typegraph_chunks_mock',
      })

      const result = await bridge.searchGraphChunks!('Who wrote Maud?', testScope, {
        count: 5,
        factCandidateLimit: 3,
        factChainLimit: 2,
      })

      expect(result.trace.selectedFactIds[0]).toBe('fact-maud')
      expect(result.facts[0]).toEqual(expect.objectContaining({ id: 'fact-maud', description: 'Tennyson wrote Maud' }))
      expect(result.facts.map(fact => fact.id)).not.toContain('fact-noisy')
      expect(result.facts.map(fact => fact.id)).not.toContain('fact-shell')
      expect(result.factChains).toEqual([])
      expect(result.trace.selectedFactChains).toEqual([])
    })
  })

  describe('explore graph intent V2', () => {
    it('uses deterministic source/target intent to keep only matching killer facts', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['aac', makeEntity('aac', 'Aac', 'person')],
        ['chaacmol', makeEntity('chaacmol', 'Chaacmol', 'person')],
        ['moo', makeEntity('moo', 'Moo', 'person')],
      ])
      const edges = [
        makeEdge('edge-killed', 'aac', 'chaacmol', 'KILLED'),
        makeEdge('edge-sibling', 'chaacmol', 'aac', 'SIBLING_OF'),
        makeEdge('edge-married', 'chaacmol', 'moo', 'MARRIED'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const result = await bridge.explore!('Who killed Chaacmol?', { userId: 'test-user', explain: true })

      expect(result.trace?.parser).toBe('deterministic')
      expect(result.intent.targetEntityQueries).toEqual(['Chaacmol'])
      expect(result.intent.predicates.map(predicate => predicate.name)).toEqual(['KILLED'])
      expect(result.intent.strictness).toBe('strict')
      expect(result.facts.map(fact => fact.edgeId)).toEqual(['edge-killed'])
      expect(result.entities.map(entity => entity.name).sort()).toEqual(['Aac', 'Chaacmol'])
    })

    it('treats spouse facts as symmetric evidence without returning unrelated relations', async () => {
      const entities = new Map<string, SemanticEntity>([
        ['aac', makeEntity('aac', 'Aac', 'person')],
        ['chaacmol', makeEntity('chaacmol', 'Chaacmol', 'person')],
        ['moo', makeEntity('moo', 'Moo', 'person')],
      ])
      const edges = [
        makeEdge('edge-killed', 'aac', 'chaacmol', 'KILLED'),
        makeEdge('edge-sibling', 'chaacmol', 'aac', 'SIBLING_OF'),
        makeEdge('edge-married', 'moo', 'chaacmol', 'MARRIED'),
      ]
      const store = mockStore(entities, edges)
      const bridge = createKnowledgeGraphBridge({
        memoryStore: store,
        embedding: mockEmbedding(),
        scope: testScope,
      })

      const result = await bridge.explore!('Who is Chaacmol wife?', { userId: 'test-user', explain: true })

      expect(result.intent.predicates).toEqual([
        expect.objectContaining({ name: 'MARRIED', symmetric: true }),
      ])
      expect(result.facts.map(fact => fact.edgeId)).toEqual(['edge-married'])
      expect(result.entities.map(entity => entity.name).sort()).toEqual(['Chaacmol', 'Moo'])
      expect(result.facts.map(fact => fact.relation)).not.toContain('KILLED')
      expect(result.facts.map(fact => fact.relation)).not.toContain('SIBLING_OF')
    })
  })
})
