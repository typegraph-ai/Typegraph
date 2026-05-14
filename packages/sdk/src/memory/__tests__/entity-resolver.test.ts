import { describe, it, expect, vi } from 'vitest'
import { EntityResolver, hasConflictingDistinguishers, hasMatchingLastToken, hasSharedNameToken, isValidAlias } from '../extraction/entity-resolver.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { Embedder } from '../../embedding/provider.js'
import type { SemanticEntity } from '../types/memory.js'
import { buildScope } from '../types/scope.js'

function mockEmbedding(): Embedder {
  return {
    name: 'test',
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }
}

function mockStore(entities: SemanticEntity[] = []): MemoryStoreAdapter {
  return {
    initialize: vi.fn(),
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    invalidate: vi.fn(),
    expire: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    findEntities: vi.fn().mockResolvedValue(entities),
    searchEntities: vi.fn().mockResolvedValue(entities),
  }
}

const testScope = buildScope({ userId: 'alice' })

describe('EntityResolver', () => {
  describe('isValidAlias', () => {
    it('rejects noisy person alias fragments observed in support threads', () => {
      expect(isValidAlias('Hi Adarsh')).toBe(false)
      expect(isValidAlias('Inform Adarsh Tadimari')).toBe(false)
      expect(isValidAlias("Plotline's Adarsh")).toBe(false)
      expect(isValidAlias("Adarsh's")).toBe(false)
      expect(isValidAlias('Both Adarsh')).toBe(false)
      expect(isValidAlias('Adarsh Tadimari')).toBe(true)
    })

    it('rejects OCR/editorial noise and citation phrase aliases', () => {
      expect(isValidAlias('Egpptian[TN-3]')).toBe(false)
      expect(isValidAlias('[TN-3] Landa')).toBe(false)
      expect(isValidAlias('according to Landa')).toBe(false)
      expect(isValidAlias('as described by Bancroft')).toBe(false)
      expect(isValidAlias('Landa')).toBe(true)
    })
  })

  describe('resolve', () => {
    it('creates a new entity when no match found', async () => {
      const resolver = new EntityResolver({
        store: mockStore([]),
        embedding: mockEmbedding(),
      })

      const { entity, isNew } = await resolver.resolve('Acme Corp', 'organization', [], testScope)
      expect(isNew).toBe(true)
      expect(entity.name).toBe('Acme Corp')
      expect(entity.entityType).toBe('organization')
      expect(entity.embedding).toEqual([0.1, 0.2, 0.3])
    })

    it('stores description embedding at entity creation', async () => {
      const embedding = mockEmbedding()
      let callCount = 0
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++
        // First call: name embedding, Second call: description embedding
        return [callCount === 1 ? [0.1, 0.2, 0.3] : [0.4, 0.5, 0.6]]
      })

      const resolver = new EntityResolver({
        store: mockStore([]),
        embedding,
      })

      const { entity, isNew } = await resolver.resolve(
        'Chris Mullin', 'person', [], testScope,
        'American professional basketball player',
      )
      expect(isNew).toBe(true)
      expect(entity.descriptionEmbedding).toEqual([0.4, 0.5, 0.6])
      // Name embed + description embed = 2 calls
      expect(embedding.embed).toHaveBeenCalledTimes(2)
      expect(embedding.embed).toHaveBeenCalledWith({ texts: ['American professional basketball player'], inputType: 'document' })
    })

    it('does not create description embedding when no description provided', async () => {
      const embedding = mockEmbedding()
      const resolver = new EntityResolver({
        store: mockStore([]),
        embedding,
      })

      const { entity, isNew } = await resolver.resolve('Acme Corp', 'organization', [], testScope)
      expect(isNew).toBe(true)
      expect(entity.descriptionEmbedding).toBeUndefined()
      // Only name embedding
      expect(embedding.embed).toHaveBeenCalledTimes(1)
    })

    it('matches existing entity by alias', async () => {
      const existing: SemanticEntity = {
        id: 'entity-1',
        name: 'Acme Corporation',
        entityType: 'organization',
        aliases: ['Acme Corp', 'Acme'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const resolver = new EntityResolver({
        store: mockStore([existing]),
        embedding: mockEmbedding(),
      })

      const { entity, isNew } = await resolver.resolve('Acme Corp', 'organization', [], testScope)
      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-1')
      expect(entity.name).toBe('Acme Corporation')
    })

    it('merges exact aliases within brand-platform affinity without changing the canonical primary type', async () => {
      const existing: SemanticEntity = {
        id: 'entity-typegraph',
        name: 'TypeGraph',
        entityType: 'organization',
        aliases: ['TypeGraph Platform'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const resolver = new EntityResolver({
        store: mockStore([existing]),
        embedding: mockEmbedding(),
      })

      const { entity, isNew } = await resolver.resolve(
        'TypeGraph Platform',
        'product',
        [],
        testScope,
        'A productized graph memory platform.',
        undefined,
        [],
        [{ type: 'product', confidence: 0.8 }],
      )

      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-typegraph')
      expect(entity.entityType).toBe('organization')
      expect(entity.metadata.typeCandidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'product' }),
      ]))
    })

    it('does not fuzzy-merge across organization/product affinity without exact alias evidence', async () => {
      const existing: SemanticEntity = {
        id: 'entity-typegraph',
        name: 'TypeGraph',
        entityType: 'organization',
        aliases: [],
        metadata: { _similarity: 0.99 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }
      const store = mockStore([existing])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const { entity, isNew } = await resolver.resolve(
        'TypeGraph Platform',
        'product',
        [],
        testScope,
        'A productized graph memory platform.',
      )

      expect(isNew).toBe(true)
      expect(entity.id).not.toBe('entity-typegraph')
      expect(entity.entityType).toBe('product')
    })

    it('keeps an externally anchored concept from drifting to a product or technology type', async () => {
      const externalId = { type: 'demo_concept_id', id: 'enterprise_sso_reliability' }
      const existing: SemanticEntity = {
        id: 'entity-sso-reliability',
        name: 'Enterprise SSO reliability',
        entityType: 'concept',
        aliases: [],
        externalIds: [externalId],
        metadata: { description: 'A seeded concept for reliability of enterprise SSO.' },
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }
      const store = {
        ...mockStore([existing]),
        findEntityByExternalId: vi.fn().mockResolvedValue(existing),
      }

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const { entity, isNew } = await resolver.resolve(
        'Enterprise SSO reliability',
        'technology',
        [],
        testScope,
        'An extracted technology mention from a support thread.',
        undefined,
        [externalId],
        [{ type: 'technology', confidence: 0.74 }],
      )

      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-sso-reliability')
      expect(entity.entityType).toBe('concept')
      expect(entity.metadata.description).toBe('A seeded concept for reliability of enterprise SSO.')
    })

    it('does not merge Simon-family people through weak surname evidence alone', async () => {
      const existing: SemanticEntity = {
        id: 'entity-caesar',
        name: 'Cæsar Simon',
        entityType: 'person',
        aliases: ['Simon'],
        metadata: { _similarity: 0.99 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }
      const store = mockStore([existing])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const youngSimon = await resolver.resolve('Young Simon', 'person', ['Simon'], testScope)
      expect(youngSimon.isNew).toBe(true)
      expect(youngSimon.entity.id).not.toBe('entity-caesar')

      const ssSimon = await resolver.resolve('S. S. Simon', 'person', ['Simon'], testScope)
      expect(ssSimon.isNew).toBe(true)
      expect(ssSimon.entity.id).not.toBe('entity-caesar')
    })

    it('does not merge distinct full names that only share a surname', async () => {
      const existing: SemanticEntity = {
        id: 'entity-elsie',
        name: 'Elsie Inglis',
        entityType: 'person',
        aliases: ['Inglis'],
        metadata: { _similarity: 0.99 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }
      const store = mockStore([existing])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const johnInglis = await resolver.resolve('John Inglis', 'person', ['Inglis'], testScope)
      expect(johnInglis.isNew).toBe(true)
      expect(johnInglis.entity.id).not.toBe('entity-elsie')
    })

    it('keeps pseudonym surname aliases strong when backed by a full pseudonym', async () => {
      const existing: SemanticEntity = {
        id: 'entity-caesar',
        name: 'Cousin Cæsar',
        entityType: 'person',
        aliases: ['Cole Conway', 'Conway'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const resolver = new EntityResolver({
        store: mockStore([existing]),
        embedding: mockEmbedding(),
      })

      const { entity, isNew } = await resolver.resolve('Conway', 'person', [], testScope)
      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-caesar')
    })

    it('does not merge from weak single-token surname aliases', async () => {
      const existing: SemanticEntity = {
        id: 'entity-caesar',
        name: 'Cæsar Simon',
        entityType: 'person',
        aliases: ['Simon'],
        metadata: { _similarity: 0.99 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }
      const store = mockStore([existing])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const { entity, isNew } = await resolver.resolve('Simon', 'person', [], testScope)
      expect(isNew).toBe(true)
      expect(entity.id).not.toBe('entity-caesar')
    })

    it('Phase 3.5: merges entities when descriptions confirm near-miss name match', async () => {
      const existing: SemanticEntity = {
        id: 'entity-mullin',
        name: 'Chris Mullin',
        entityType: 'person',
        aliases: [],
        metadata: {
          description: 'American former professional basketball player and coach',
          _similarity: 0.55, // Near-miss: above 0.45, below 0.68
        },
        embedding: [0.8, 0.5, 0.3],
        descriptionEmbedding: [0.9, 0.85, 0.4],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      let callCount = 0
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++
        if (callCount === 1) return [0.7, 0.6, 0.3]     // name embedding (Phase 3)
        if (callCount === 2) return [0.88, 0.86, 0.42]   // incoming description embedding (Phase 3.5)
        return [0.1, 0.2, 0.3]                           // merge re-embed
      })

      const resolver = new EntityResolver({ store, embedding })

      const { entity, isNew } = await resolver.resolve(
        'Christopher Paul Mullin', 'person', [], testScope,
        'Golden State Warriors player selected for the United States men\'s national basketball team.',
      )

      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-mullin')
      expect(entity.aliases).toContain('Christopher Paul Mullin')
    })

    it('Phase 3.5: does not merge when descriptions are dissimilar', async () => {
      const existing: SemanticEntity = {
        id: 'entity-mj-player',
        name: 'Michael Jordan',
        entityType: 'person',
        aliases: [],
        metadata: {
          description: 'Former professional basketball player, six-time NBA champion',
          _similarity: 0.55,
        },
        embedding: [0.8, 0.5, 0.3],
        descriptionEmbedding: [0.9, 0.1, 0.1], // basketball-related direction
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      let callCount = 0
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++
        if (callCount === 1) return [0.7, 0.6, 0.3]  // name embedding
        if (callCount === 2) return [0.1, 0.9, 0.1]  // description embedding — orthogonal to candidate
        return [0.1, 0.2, 0.3]                        // entity creation description embed
      })

      const resolver = new EntityResolver({ store, embedding })

      const { entity, isNew } = await resolver.resolve(
        'Michael Jordan', 'person', [], testScope,
        'American rapper and songwriter from Atlanta, Georgia',
      )

      expect(isNew).toBe(true)
      expect(entity.name).toBe('Michael Jordan')
      expect(entity.id).not.toBe('entity-mj-player')
    })

    it('Phase 3.5: skips when incoming entity has no description', async () => {
      const existing: SemanticEntity = {
        id: 'entity-1',
        name: 'Some Entity',
        entityType: 'person',
        aliases: [],
        metadata: {
          description: 'Some description',
          _similarity: 0.55,
        },
        embedding: [0.8, 0.5, 0.3],
        descriptionEmbedding: [0.9, 0.85, 0.4],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      const resolver = new EntityResolver({ store, embedding })

      // No description provided — Phase 3.5 should not fire
      const { isNew } = await resolver.resolve('Some Other Entity', 'person', [], testScope)
      expect(isNew).toBe(true)
      // Only 1 embed call (name), not 2 (name + description)
      expect(embedding.embed).toHaveBeenCalledTimes(1)
    })

    it('Phase 3.5: skips when candidate has no description embedding', async () => {
      const existing: SemanticEntity = {
        id: 'entity-1',
        name: 'Some Entity',
        entityType: 'person',
        aliases: [],
        metadata: { _similarity: 0.55 },
        embedding: [0.8, 0.5, 0.3],
        // No descriptionEmbedding
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      const resolver = new EntityResolver({ store, embedding })

      const { isNew } = await resolver.resolve(
        'Some Other Entity', 'person', [], testScope, 'A description',
      )
      expect(isNew).toBe(true)
    })

    it('distinguishing attribute guard prevents over-merging in Phase 2.5', async () => {
      // "1988 team" and "1992 team" have trigram Jaccard ~0.95 but different years
      const existing: SemanticEntity = {
        id: 'entity-1992-team',
        name: '1992 United States men\'s Olympic basketball team',
        entityType: 'organization',
        aliases: [],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([existing])
      // Also return from searchEntities with high similarity
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...existing, metadata: { _similarity: 0.95 } },
      ])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const { isNew } = await resolver.resolve(
        '1988 United States men\'s Olympic basketball team',
        'organization', [], testScope,
      )
      expect(isNew).toBe(true) // Should NOT merge — different years
    })

    it('distinguishing attribute guard allows merge when years match', async () => {
      const existing: SemanticEntity = {
        id: 'entity-1992-team',
        name: '1992 United States men\'s Olympic basketball team',
        entityType: 'organization',
        aliases: [],
        metadata: { _similarity: 0.95 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.9, 0.9, 0.9])

      const resolver = new EntityResolver({ store, embedding })

      const { entity, isNew } = await resolver.resolve(
        '1992 Dream Team', 'organization', [], testScope,
      )
      // Same year (1992) — guard does NOT block; Phase 3 similarity is high
      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-1992-team')
    })
  })

  describe('merge', () => {
    it('adds new aliases without duplicates', async () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Acme Corporation',
        entityType: 'organization',
        aliases: ['Acme Corp'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Acme Inc',
        entityType: 'organization',
        aliases: ['Acme Corp', 'ACME'], // 'Acme Corp' is duplicate
      })

      expect(merged.aliases).toContain('Acme Corp')
      expect(merged.aliases).toContain('Acme Inc')
      expect(merged.aliases).toContain('ACME')
      // No duplicate 'Acme Corp'
      expect(merged.aliases.filter(a => a.toLowerCase() === 'acme corp')).toHaveLength(1)
    })

    it('updates entityType from "other" to more specific', async () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Unknown',
        entityType: 'other',
        aliases: [],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Unknown',
        entityType: 'person',
        aliases: [],
      })

      expect(merged.entityType).toBe('person')
    })

    it('preserves existing specific entityType', async () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Alice',
        entityType: 'person',
        aliases: [],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Alice',
        entityType: 'organization', // incorrect but existing is specific
        aliases: [],
      })

      expect(merged.entityType).toBe('person') // preserved
    })

    it('re-embeds description when description changes on merge', async () => {
      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.7, 0.8, 0.9])

      const resolver = new EntityResolver({
        store: mockStore(),
        embedding,
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Chris Mullin',
        entityType: 'person',
        aliases: [],
        metadata: { description: 'NBA player' },
        descriptionEmbedding: [0.1, 0.2, 0.3],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Christopher Mullin',
        entityType: 'person',
        aliases: [],
        description: 'Five-time All-Star',
      })

      // Description changed — should re-embed
      expect(merged.descriptionEmbedding).toEqual([0.7, 0.8, 0.9])
      expect(embedding.embed).toHaveBeenCalledWith({ texts: ['NBA player Five-time All-Star'], inputType: 'document' })
    })

    it('compacts merged descriptions by sentence without duplicate facts or mid-sentence cuts', async () => {
      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.7, 0.8, 0.9])

      const resolver = new EntityResolver({
        store: mockStore(),
        embedding,
      })

      const existing: SemanticEntity = {
        id: 'e-caesar',
        name: 'Cousin Cæsar',
        entityType: 'person',
        aliases: ['Cole Conway'],
        metadata: {
          description: 'A card player using the pseudonym Cole Conway. A card player using the pseudonym Cole Conway.',
        },
        descriptionEmbedding: [0.1, 0.2, 0.3],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const incomingDescription = [
        'A card player using the pseudonym Cole Conway.',
        'A partner of Steve Sharp in Paducah, Kentucky.',
        'A man who travels toward the West Indies.',
      ].join(' ')

      const merged = await resolver.merge(existing, {
        name: 'Cole Conway',
        entityType: 'person',
        aliases: ['Conway'],
        description: incomingDescription,
      })

      const description = merged.metadata.description as string
      expect(description.length).toBeLessThanOrEqual(320)
      expect(description.match(/A card player using the pseudonym Cole Conway/g)).toHaveLength(1)
      expect(description).toContain('A partner of Steve Sharp in Paducah, Kentucky.')
      expect(description).not.toContain('A man who travels toward the West Indies.')
      expect(description.endsWith('.')).toBe(true)
      expect(embedding.embed).toHaveBeenCalledWith({ texts: [description], inputType: 'document' })
    })

    it('ignores generic relation-only profile summaries when a real description already exists', async () => {
      const embedding = mockEmbedding()
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding,
      })

      const existing: SemanticEntity = {
        id: 'e-elsie',
        name: 'Elsie Inglis',
        entityType: 'person',
        aliases: [],
        metadata: { description: 'Doctor and suffrage campaigner.' },
        descriptionEmbedding: [0.1, 0.2, 0.3],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Elsie Inglis',
        entityType: 'person',
        aliases: [],
        description: 'Elsie Inglis is connected to Serbia through traveled to.',
      })

      expect(merged.metadata.description).toBe('Doctor and suffrage campaigner.')
      expect(embedding.embed).not.toHaveBeenCalled()
    })

    it('drops chopped fragment descriptions that end in abbreviation fragments', async () => {
      const embedding = mockEmbedding()
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding,
      })

      const merged = await resolver.merge({
        id: 'e-foreign-office',
        name: 'Foreign Office',
        entityType: 'organization',
        aliases: [],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }, {
        name: 'Foreign Office',
        entityType: 'organization',
        aliases: [],
        description: 'British authority corresponding with S.',
      })

      expect(merged.metadata.description).toBeUndefined()
      expect(embedding.embed).not.toHaveBeenCalled()
    })

    it('does not append descriptions that describe a different named person by relationship', async () => {
      const embedding = mockEmbedding()
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding,
      })

      const existing: SemanticEntity = {
        id: 'e-caesar',
        name: 'Cousin Cæsar',
        entityType: 'person',
        aliases: ['Cole Conway'],
        metadata: { description: 'The main protagonist who uses the name Cole Conway.' },
        descriptionEmbedding: [0.1, 0.2, 0.3],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'S. S. Simon',
        entityType: 'person',
        aliases: ['Simon'],
        description: 'The uncle of Cousin Cæsar who left a significant estate in Arkansas after his death.',
      })

      expect(merged.metadata.description).toBe('The main protagonist who uses the name Cole Conway.')
      expect(embedding.embed).not.toHaveBeenCalled()
    })

    it('preserves description embedding when description unchanged', async () => {
      const embedding = mockEmbedding()
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding,
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Chris Mullin',
        entityType: 'person',
        aliases: [],
        metadata: { description: 'NBA player' },
        descriptionEmbedding: [0.1, 0.2, 0.3],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Christopher Mullin',
        entityType: 'person',
        aliases: [],
        // No description — existing description unchanged
      })

      expect(merged.descriptionEmbedding).toEqual([0.1, 0.2, 0.3])
      expect(embedding.embed).not.toHaveBeenCalled()
    })
  })

  describe('hasConflictingDistinguishers', () => {
    it('detects conflicting years', () => {
      expect(hasConflictingDistinguishers(
        '1992 United States men\'s Olympic basketball team',
        '1988 United States men\'s Olympic basketball team',
      )).toBe(true)
    })

    it('allows matching years', () => {
      expect(hasConflictingDistinguishers(
        '1992 United States men\'s Olympic basketball team',
        '1992 Dream Team',
      )).toBe(false)
    })

    it('allows when no years present', () => {
      expect(hasConflictingDistinguishers(
        'Chris Mullin',
        'Christopher Paul Mullin',
      )).toBe(false)
    })

    it('allows when only one string has a year', () => {
      expect(hasConflictingDistinguishers(
        '1992 Dream Team',
        'Dream Team',
      )).toBe(false)
    })

    it('detects conflicting version numbers', () => {
      expect(hasConflictingDistinguishers(
        'TypeScript v4.9',
        'TypeScript v5.0',
      )).toBe(true)
    })

    it('detects conflicting ordinals', () => {
      expect(hasConflictingDistinguishers(
        '3rd Annual Conference',
        '4th Annual Conference',
      )).toBe(true)
    })

    it('allows matching ordinals', () => {
      expect(hasConflictingDistinguishers(
        '3rd Annual Conference on AI',
        '3rd Annual AI Conference',
      )).toBe(false)
    })

    it('does not conflict on overlapping year sets', () => {
      // "1992-1996 Dream Team" has years {1992, 1996}, "1992 US team" has {1992}
      // They share 1992, so no conflict
      expect(hasConflictingDistinguishers(
        '1992-1996 Dream Team',
        '1992 US Olympic team',
      )).toBe(false)
    })
  })

  describe('hasSharedNameToken', () => {
    it('returns false for completely different entity names', () => {
      expect(hasSharedNameToken('Toronto Raptors', 'Oklahoma City Thunder')).toBe(false)
    })

    it('returns false for different person names', () => {
      expect(hasSharedNameToken('Kevin Durant', 'Russell Westbrook')).toBe(false)
    })

    it('returns true when names share a meaningful token', () => {
      expect(hasSharedNameToken('Chris Mullin', 'Christopher Paul Mullin')).toBe(true)
    })

    it('filters stop words — "United" is not a distinguishing token', () => {
      expect(hasSharedNameToken('United States', 'United Kingdom')).toBe(false)
    })

    it('handles punctuation and case differences', () => {
      expect(hasSharedNameToken('J.K. Rowling', 'Rowling, J.K.')).toBe(true)
    })

    it('returns false for single-char tokens only', () => {
      // After stripping, only single-char tokens remain — below length threshold
      expect(hasSharedNameToken('A B C', 'A D E')).toBe(false)
    })

    it('filters common location/identity stop words', () => {
      expect(hasSharedNameToken('National Football League', 'National Basketball Association')).toBe(false)
    })
  })

  describe('lexical overlap guard integration', () => {
    it('Phase 3: blocks merge when no shared name tokens despite high embedding similarity', async () => {
      // Same-type entities with high embedding similarity but no shared tokens
      const existing: SemanticEntity = {
        id: 'entity-thunder',
        name: 'Oklahoma City Thunder',
        entityType: 'organization',
        aliases: [],
        metadata: { _similarity: 0.92 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.9, 0.9, 0.9])

      const resolver = new EntityResolver({ store, embedding })

      const { isNew } = await resolver.resolve(
        'Toronto Raptors', 'organization', [], testScope,
      )
      expect(isNew).toBe(true) // Must NOT merge — no shared name tokens
    })

    it('Phase 3: allows merge when shared tokens exist and similarity is high', async () => {
      const existing: SemanticEntity = {
        id: 'entity-mullin',
        name: 'Chris Mullin',
        entityType: 'person',
        aliases: [],
        metadata: { _similarity: 0.92 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.9, 0.9, 0.9])

      const resolver = new EntityResolver({ store, embedding })

      const { entity, isNew } = await resolver.resolve(
        'Christopher Mullin', 'person', [], testScope,
      )
      // "mullin" is shared → lexical guard passes; similarity 0.92 > 0.85 → merge
      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-mullin')
    })

    it('Phase 3.5: blocks merge when no shared name tokens despite similar descriptions', async () => {
      const existing: SemanticEntity = {
        id: 'entity-lakers',
        name: 'Los Angeles Lakers',
        entityType: 'organization',
        aliases: [],
        metadata: {
          description: 'Professional basketball team in the NBA',
          _similarity: 0.55,
        },
        embedding: [0.8, 0.5, 0.3],
        descriptionEmbedding: [0.9, 0.85, 0.4],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      let callCount = 0
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++
        if (callCount === 1) return [0.7, 0.6, 0.3]     // name embedding
        if (callCount === 2) return [0.88, 0.86, 0.42]   // description embedding (similar to existing)
        return [0.1, 0.2, 0.3]
      })

      const resolver = new EntityResolver({ store, embedding })

      const { isNew } = await resolver.resolve(
        'Boston Celtics', 'organization', [], testScope,
        'Professional basketball team in the NBA',
      )
      // No shared tokens between "Los Angeles Lakers" and "Boston Celtics" → blocked
      expect(isNew).toBe(true)
    })

    it('Phase 3: rejects at raised threshold (0.75 is below new 0.85)', async () => {
      const existing: SemanticEntity = {
        id: 'entity-mullin',
        name: 'Chris Mullin',
        entityType: 'person',
        aliases: [],
        metadata: { _similarity: 0.75 }, // above old 0.68, below new 0.85
        embedding: [0.8, 0.5, 0.3],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([existing])

      const embedding = mockEmbedding()
      const resolver = new EntityResolver({ store, embedding })

      const { isNew } = await resolver.resolve(
        'Christopher Mullin', 'person', [], testScope,
      )
      // Similarity 0.75 < threshold 0.85 → Phase 3 rejects (would have merged at old 0.68)
      // No description provided → Phase 3.5 doesn't fire
      expect(isNew).toBe(true)
    })
  })

  describe('isValidAlias', () => {
    // ── Should reject ──

    it('rejects empty string', () => {
      expect(isValidAlias('')).toBe(false)
    })

    it('rejects single character', () => {
      expect(isValidAlias('a')).toBe(false)
      expect(isValidAlias('X')).toBe(false)
    })

    it('rejects pronouns', () => {
      expect(isValidAlias('it')).toBe(false)
      expect(isValidAlias('he')).toBe(false)
      expect(isValidAlias('she')).toBe(false)
      expect(isValidAlias('they')).toBe(false)
      expect(isValidAlias('them')).toBe(false)
      expect(isValidAlias('we')).toBe(false)
      expect(isValidAlias('this')).toBe(false)
      expect(isValidAlias('that')).toBe(false)
    })

    it('rejects generic references with articles', () => {
      expect(isValidAlias('the team')).toBe(false)
      expect(isValidAlias('the roster')).toBe(false)
      expect(isValidAlias('the company')).toBe(false)
      expect(isValidAlias('the city')).toBe(false)
      expect(isValidAlias('a league')).toBe(false)
      expect(isValidAlias('an organization')).toBe(false)
    })

    it('rejects generic references with adjectives', () => {
      expect(isValidAlias('the final team')).toBe(false)
      expect(isValidAlias('the professional roster')).toBe(false)
      expect(isValidAlias('the forthcoming event')).toBe(false)
    })

    it('rejects pure numbers', () => {
      expect(isValidAlias('2024')).toBe(false)
      expect(isValidAlias('42')).toBe(false)
      expect(isValidAlias('1984')).toBe(false)
    })

    // ── Should accept ──

    it('accepts abbreviations', () => {
      expect(isValidAlias('NASA')).toBe(true)
      expect(isValidAlias('NBA')).toBe(true)
      expect(isValidAlias('MIT')).toBe(true)
      expect(isValidAlias('AI')).toBe(true)
      expect(isValidAlias('US')).toBe(true)
    })

    it('accepts proper names', () => {
      expect(isValidAlias('Stephen Curry')).toBe(true)
      expect(isValidAlias('Klay Thompson')).toBe(true)
    })

    it('accepts single-word proper nouns', () => {
      expect(isValidAlias('Google')).toBe(true)
      expect(isValidAlias('Apple')).toBe(true)
      expect(isValidAlias('Celtics')).toBe(true)
    })

    it('accepts "the"-prefixed proper names', () => {
      expect(isValidAlias('The New York Times')).toBe(true)
      expect(isValidAlias('The Beatles')).toBe(true)
    })

    it('accepts legitimate nicknames', () => {
      expect(isValidAlias('KD')).toBe(true)
      expect(isValidAlias('The Slim Reaper')).toBe(true)
      expect(isValidAlias('Magic Johnson')).toBe(true)
    })

    it('accepts alphanumeric combinations', () => {
      expect(isValidAlias('Apollo 13')).toBe(true)
      expect(isValidAlias('2024 Finals')).toBe(true)
    })
  })

  describe('merge with isValidAlias filtering', () => {
    it('filters garbage aliases during merge', async () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e-celtics',
        name: 'Boston Celtics',
        entityType: 'organization',
        aliases: ['Celtics'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'Boston Celtics',
        entityType: 'organization',
        aliases: ['it', 'the team', 'Team USA', 'Celtics'],
      })

      // "Team USA" is valid and new → kept
      expect(merged.aliases).toContain('Team USA')
      // "Celtics" already exists → not duplicated
      expect(merged.aliases.filter(a => a === 'Celtics')).toHaveLength(1)
      // "it" and "the team" are garbage → rejected
      expect(merged.aliases).not.toContain('it')
      expect(merged.aliases).not.toContain('the team')
    })

    it('filters expanded generic nouns during merge', async () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e-finals',
        name: 'NBA Finals',
        entityType: 'event',
        aliases: [],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = await resolver.merge(existing, {
        name: 'NBA Finals',
        entityType: 'event',
        aliases: ['Finals', 'the finals', 'championship', 'the championship'],
      })

      // All are generic nouns / generic references → rejected
      expect(merged.aliases).not.toContain('Finals')
      expect(merged.aliases).not.toContain('the finals')
      expect(merged.aliases).not.toContain('championship')
      expect(merged.aliases).not.toContain('the championship')
    })
  })

  describe('type compatibility integration', () => {
    it('Phase 0 cache: blocks cross-type merge for same name', async () => {
      const resolver = new EntityResolver({
        store: mockStore([]),
        embedding: mockEmbedding(),
      })

      // First resolve: "France" as location → goes into cache
      const { entity: france } = await resolver.resolve('France', 'location', [], testScope)
      expect(france.entityType).toBe('location')

      // Second resolve: "France" as organization → cache hit, but type mismatch → should NOT merge
      const { entity: franceTeam, isNew } = await resolver.resolve(
        'France', 'organization', ['France men\'s national basketball team'], testScope,
      )
      expect(isNew).toBe(true) // Must create new entity, not merge with location
      expect(franceTeam.entityType).toBe('organization')
    })

    it('Phase 1 alias: blocks cross-type merge via alias match', async () => {
      const franceLocation: SemanticEntity = {
        id: 'entity-france-loc',
        name: 'France',
        entityType: 'location',
        aliases: ['French Republic'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([franceLocation])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const { isNew } = await resolver.resolve(
        'France men\'s national basketball team', 'organization', ['France'], testScope,
      )
      // "France" alias matches franceLocation, but types are incompatible → no merge
      expect(isNew).toBe(true)
    })

    it('Phase 2 normalized: blocks cross-type merge on normalized match', async () => {
      const franceLocation: SemanticEntity = {
        id: 'entity-france-loc',
        name: 'France',
        entityType: 'location',
        aliases: [],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([franceLocation])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      // "france" normalizes the same as "France" but types differ
      const { isNew } = await resolver.resolve('france', 'organization', [], testScope)
      expect(isNew).toBe(true)
    })

    it('Phase 0/1/2: allows same-type merge', async () => {
      const acme: SemanticEntity = {
        id: 'entity-acme',
        name: 'Acme Corporation',
        entityType: 'organization',
        aliases: ['Acme Corp'],
        metadata: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([acme])
      const resolver = new EntityResolver({ store, embedding: mockEmbedding() })

      const { entity, isNew } = await resolver.resolve(
        'Acme Corp', 'organization', [], testScope,
      )
      expect(isNew).toBe(false)
      expect(entity.id).toBe('entity-acme')
    })
  })

  describe('hasMatchingLastToken', () => {
    it('blocks different surnames with shared first name', () => {
      expect(hasMatchingLastToken('Kevin Durant', 'Kevin Love')).toBe(false)
    })

    it('blocks first-name-as-surname confusion', () => {
      expect(hasMatchingLastToken('LeBron James', 'James Harden')).toBe(false)
    })

    it('blocks father vs son (Jr. suffix)', () => {
      expect(hasMatchingLastToken('LeBron James', 'LeBron James Jr.')).toBe(false)
    })

    it('blocks generational namesakes (III vs Jr.)', () => {
      expect(hasMatchingLastToken('Martin Luther King Jr.', 'Martin Luther King III')).toBe(false)
    })

    it('allows same surname', () => {
      expect(hasMatchingLastToken('Chris Mullin', 'Christopher Paul Mullin')).toBe(true)
    })

    it('allows same person different prefix', () => {
      expect(hasMatchingLastToken('Dr. Martin Luther King Jr.', 'Martin Luther King Jr.')).toBe(true)
    })

    it('allows different married names (but blocks correctly)', () => {
      expect(hasMatchingLastToken('Mary Jane Watson', 'Mary Jane Smith')).toBe(false)
    })

    it('bypasses for single-word names (Madonna)', () => {
      expect(hasMatchingLastToken('Madonna', 'Madonna Louise Ciccone')).toBe(true)
    })

    it('bypasses for single-word names (Chris)', () => {
      expect(hasMatchingLastToken('Chris', 'Christopher Paul Mullin')).toBe(true)
    })

    it('bypasses when both are single-word', () => {
      expect(hasMatchingLastToken('Madonna', 'Cher')).toBe(true)
    })

    it('handles 3+ word names correctly', () => {
      expect(hasMatchingLastToken('Martin Luther King', 'Coretta Scott King')).toBe(true)
    })

    it('handles punctuation in names', () => {
      expect(hasMatchingLastToken('J.K. Rowling', 'Joanne Rowling')).toBe(true)
    })
  })

  describe('person surname guard integration', () => {
    it('Phase 3: blocks Kevin Durant / Kevin Love merge despite high embedding similarity', async () => {
      const kevinLove: SemanticEntity = {
        id: 'entity-love',
        name: 'Kevin Love',
        entityType: 'person',
        aliases: [],
        metadata: { _similarity: 0.92 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([kevinLove])

      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.9, 0.9, 0.9])

      const resolver = new EntityResolver({ store, embedding })

      const { isNew } = await resolver.resolve('Kevin Durant', 'person', [], testScope)
      expect(isNew).toBe(true) // Must NOT merge — different surnames
    })

    it('Phase 3: allows Chris Mullin / Christopher Paul Mullin merge', async () => {
      const chrisMullin: SemanticEntity = {
        id: 'entity-mullin',
        name: 'Chris Mullin',
        entityType: 'person',
        aliases: [],
        metadata: { _similarity: 0.92 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([chrisMullin])

      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.9, 0.9, 0.9])

      const resolver = new EntityResolver({ store, embedding })

      const { entity, isNew } = await resolver.resolve(
        'Christopher Paul Mullin', 'person', [], testScope,
      )
      expect(isNew).toBe(false) // Same surname "Mullin" → allowed
      expect(entity.id).toBe('entity-mullin')
    })

    it('does not apply surname guard to non-person entities', async () => {
      // Two organizations with different last tokens but high similarity should still merge
      const eastern: SemanticEntity = {
        id: 'entity-eastern-div',
        name: 'Eastern Division',
        entityType: 'organization',
        aliases: [],
        metadata: { _similarity: 0.92 },
        embedding: [0.9, 0.9, 0.9],
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const store = mockStore([])
      ;(store.findEntities as ReturnType<typeof vi.fn>).mockResolvedValue([])
      ;(store.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([eastern])

      const embedding = mockEmbedding()
      ;(embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([0.9, 0.9, 0.9])

      const resolver = new EntityResolver({ store, embedding })

      // Note: this will be blocked by opposing qualifier guard (eastern vs western),
      // but the surname guard itself does not apply to organizations
      const { isNew } = await resolver.resolve(
        'Eastern Basketball Division', 'organization', [], testScope,
      )
      // Same name ("Eastern Division" ≈ "Eastern Basketball Division") — allowed by surname guard
      // but opposing qualifier guard is NOT triggered (both have "eastern")
      expect(isNew).toBe(false)
    })
  })

  describe('opposing qualifiers in hasConflictingDistinguishers', () => {
    // Spatial
    it('detects western vs eastern conflict', () => {
      expect(hasConflictingDistinguishers('Western Conference', 'Eastern Conference')).toBe(true)
    })

    it('detects north vs south conflict', () => {
      expect(hasConflictingDistinguishers('North America', 'South America')).toBe(true)
    })

    // Magnitude
    it('detects major vs minor conflict', () => {
      expect(hasConflictingDistinguishers('Major League Baseball', 'Minor League Baseball')).toBe(true)
    })

    it('detects senior vs junior conflict', () => {
      expect(hasConflictingDistinguishers('Senior Open', 'Junior Open')).toBe(true)
    })

    // Relational
    it('detects public vs private conflict', () => {
      expect(hasConflictingDistinguishers('Public University', 'Private University')).toBe(true)
    })

    it('detects internal vs external conflict', () => {
      expect(hasConflictingDistinguishers('Internal Affairs', 'External Affairs')).toBe(true)
    })

    it('detects offensive vs defensive conflict', () => {
      expect(hasConflictingDistinguishers('Offensive Coordinator', 'Defensive Coordinator')).toBe(true)
    })

    // Gender / demographic
    it('detects men vs women conflict', () => {
      expect(hasConflictingDistinguishers(
        'France men\'s national basketball team',
        'France women\'s national basketball team',
      )).toBe(true)
    })

    // Medical
    it('detects acute vs chronic conflict', () => {
      expect(hasConflictingDistinguishers('Acute bronchitis', 'Chronic bronchitis')).toBe(true)
    })

    it('detects benign vs malignant conflict', () => {
      expect(hasConflictingDistinguishers('Benign tumor', 'Malignant tumor')).toBe(true)
    })

    // Non-conflicts
    it('allows same-side qualifiers (no conflict)', () => {
      expect(hasConflictingDistinguishers('Western Division', 'Western Conference')).toBe(false)
    })

    it('allows when no opposing qualifiers present', () => {
      expect(hasConflictingDistinguishers('Golden State Warriors', 'Warriors')).toBe(false)
    })

    it('still detects year conflicts alongside opposing pairs', () => {
      expect(hasConflictingDistinguishers('2023 Western Conference', '2024 Western Conference')).toBe(true)
    })

    // Temporal
    it('detects early vs late conflict', () => {
      expect(hasConflictingDistinguishers('Early Renaissance', 'Late Renaissance')).toBe(true)
    })

    it('detects ancient vs modern conflict', () => {
      expect(hasConflictingDistinguishers('Ancient Rome', 'Modern Rome')).toBe(true)
    })

    // Progressive / traditional
    it('detects progressive vs traditional conflict', () => {
      expect(hasConflictingDistinguishers('Progressive Party', 'Traditional Party')).toBe(true)
    })
  })

  describe('expanded isValidAlias', () => {
    // New generic nouns
    it('rejects "Finals" (single-word generic, capitalized)', () => {
      expect(isValidAlias('Finals')).toBe(false)
    })

    it('rejects "finals" (single-word generic, lowercase)', () => {
      expect(isValidAlias('finals')).toBe(false)
    })

    it('rejects "Olympics" (single-word generic)', () => {
      expect(isValidAlias('Olympics')).toBe(false)
    })

    it('rejects "MVP" (single-word generic)', () => {
      expect(isValidAlias('MVP')).toBe(false)
    })

    it('rejects "championship" (single-word generic)', () => {
      expect(isValidAlias('championship')).toBe(false)
    })

    it('rejects "draft" (single-word generic)', () => {
      expect(isValidAlias('draft')).toBe(false)
    })

    it('rejects "trophy" (single-word generic)', () => {
      expect(isValidAlias('trophy')).toBe(false)
    })

    // Still accepts qualified forms
    it('accepts "NBA Finals" (qualified)', () => {
      expect(isValidAlias('NBA Finals')).toBe(true)
    })

    it('accepts "2024 Olympics" (qualified)', () => {
      expect(isValidAlias('2024 Olympics')).toBe(true)
    })

    it('accepts "Larry O\'Brien Trophy" (qualified)', () => {
      expect(isValidAlias('Larry O\'Brien Trophy')).toBe(true)
    })

    // Max length guard
    it('rejects overly long aliases (book titles)', () => {
      const longTitle = 'The Comprehensive Guide to Modern Basketball Strategy and Team Management in Professional Leagues'
      expect(longTitle.length).toBeGreaterThan(80)
      expect(isValidAlias(longTitle)).toBe(false)
    })

    it('accepts reasonable-length aliases', () => {
      expect(isValidAlias('National Basketball Association')).toBe(true)
    })

    // Parenthetical guard
    it('rejects parenthetical disambiguators — (book)', () => {
      expect(isValidAlias('Dune (book)')).toBe(false)
    })

    it('rejects parenthetical disambiguators — (film)', () => {
      expect(isValidAlias('Dune (film)')).toBe(false)
    })

    it('rejects parenthetical disambiguators — (TV series)', () => {
      expect(isValidAlias('House (TV series)')).toBe(false)
    })

    it('rejects parenthetical disambiguators — (disambiguation)', () => {
      expect(isValidAlias('Mercury (disambiguation)')).toBe(false)
    })

    it('rejects parenthetical disambiguators — (video game)', () => {
      expect(isValidAlias('Doom (video game)')).toBe(false)
    })

    it('rejects parenthetical disambiguators — (comics)', () => {
      expect(isValidAlias('Batman (comics)')).toBe(false)
    })

    it('accepts parenthetical that is not a disambiguator', () => {
      expect(isValidAlias('Apple (company)')).toBe(true)
    })
  })
})
