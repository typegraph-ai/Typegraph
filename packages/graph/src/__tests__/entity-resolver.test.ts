import { describe, it, expect, vi } from 'vitest'
import { EntityResolver } from '../extraction/entity-resolver.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '@d8um-ai/core'
import type { SemanticEntity } from '../types/memory.js'
import { buildScope } from '../types/scope.js'

function mockEmbedding(): EmbeddingProvider {
  return {
    model: 'test',
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
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

    it('matches existing entity by alias', async () => {
      const existing: SemanticEntity = {
        id: 'entity-1',
        name: 'Acme Corporation',
        entityType: 'organization',
        aliases: ['Acme Corp', 'Acme'],
        properties: {},
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
  })

  describe('merge', () => {
    it('adds new aliases without duplicates', () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Acme Corporation',
        entityType: 'organization',
        aliases: ['Acme Corp'],
        properties: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = resolver.merge(existing, {
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

    it('updates entityType from "other" to more specific', () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Unknown',
        entityType: 'other',
        aliases: [],
        properties: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = resolver.merge(existing, {
        name: 'Unknown',
        entityType: 'person',
        aliases: [],
      })

      expect(merged.entityType).toBe('person')
    })

    it('preserves existing specific entityType', () => {
      const resolver = new EntityResolver({
        store: mockStore(),
        embedding: mockEmbedding(),
      })

      const existing: SemanticEntity = {
        id: 'e1',
        name: 'Alice',
        entityType: 'person',
        aliases: [],
        properties: {},
        scope: testScope,
        temporal: { validAt: new Date(), createdAt: new Date() },
      }

      const merged = resolver.merge(existing, {
        name: 'Alice',
        entityType: 'organization', // incorrect but existing is specific
        aliases: [],
      })

      expect(merged.entityType).toBe('person') // preserved
    })
  })
})
