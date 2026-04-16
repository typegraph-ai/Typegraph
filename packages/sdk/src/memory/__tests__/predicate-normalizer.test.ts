import { describe, it, expect, vi } from 'vitest'
import { PredicateNormalizer } from '../extraction/predicate-normalizer.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'

/** Returns a mock embedding provider where each call returns a unique vector. */
function mockEmbedding(): EmbeddingProvider {
  let callCount = 0
  return {
    model: 'test-model',
    dimensions: 3,
    embed: vi.fn().mockImplementation(async () => {
      callCount++
      // Return distinct vectors so embedding fallback won't merge unrelated predicates
      return [callCount * 0.1, callCount * 0.2, callCount * 0.3]
    }),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }
}

/** Returns a mock embedding that makes all predicates highly similar (for testing embedding fallback). */
function mockSimilarEmbedding(): EmbeddingProvider {
  return {
    model: 'test-model',
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([0.5, 0.5, 0.5]),
    embedBatch: vi.fn().mockResolvedValue([[0.5, 0.5, 0.5]]),
  }
}

describe('PredicateNormalizer', () => {
  describe('static synonym merging', () => {
    it('merges EMPLOYED_BY → WORKS_FOR', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('EMPLOYED_BY')).toBe('WORKS_FOR')
    })

    it('merges WORKS_AT → WORKS_FOR', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('WORKS_AT')).toBe('WORKS_FOR')
    })

    it('merges EMPLOYED_AT → WORKS_FOR', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('EMPLOYED_AT')).toBe('WORKS_FOR')
    })

    it('merges BELONGS_TO → MEMBER_OF', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('BELONGS_TO')).toBe('MEMBER_OF')
    })

    it('merges SIGNED_BY → SIGNED', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('SIGNED_BY')).toBe('SIGNED')
    })

    it('merges BASED_IN → HEADQUARTERED_IN', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('BASED_IN')).toBe('HEADQUARTERED_IN')
    })

    it('merges ACQUIRED_BY → OWNED_BY', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('ACQUIRED_BY')).toBe('OWNED_BY')
    })

    it('canonical form maps to itself', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('WORKS_FOR')).toBe('WORKS_FOR')
    })
  })

  describe('tense separation', () => {
    it('keeps past-tense employment separate from present-tense', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      await normalizer.normalize('WORKS_FOR')
      expect(await normalizer.normalize('WORKED_FOR')).not.toBe('WORKS_FOR')
    })

    it('WORKED_AT maps to WORKED_FOR (past-tense synonym group)', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('WORKED_AT')).toBe('WORKED_FOR')
    })

    it('WAS_EMPLOYED_BY maps to WORKED_FOR', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      expect(await normalizer.normalize('WAS_EMPLOYED_BY')).toBe('WORKED_FOR')
    })
  })

  describe('tense guard on embedding fallback', () => {
    it('blocks cross-tense merge even with high similarity', async () => {
      // All embeddings return the same vector → cosine similarity = 1.0
      const normalizer = new PredicateNormalizer(mockSimilarEmbedding(), 0.85)

      // Register PLAYS_FOR as canonical
      const result1 = await normalizer.normalize('PLAYS_FOR')
      expect(result1).toBe('PLAYS_FOR')

      // PLAYED_FOR should NOT merge into PLAYS_FOR despite perfect similarity
      const result2 = await normalizer.normalize('PLAYED_FOR')
      expect(result2).toBe('PLAYED_FOR')
      expect(result2).not.toBe('PLAYS_FOR')
    })
  })

  describe('embedding fallback for novel predicates', () => {
    it('registers novel predicates as new canonicals', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding())
      const result = await normalizer.normalize('COMPETES_AGAINST')
      expect(result).toBe('COMPETES_AGAINST')
      expect(normalizer.size).toBe(1)
    })

    it('uses resolved cache on second call', async () => {
      const embedding = mockEmbedding()
      const normalizer = new PredicateNormalizer(embedding)

      await normalizer.normalize('COMPETES_AGAINST')
      await normalizer.normalize('COMPETES_AGAINST')

      // embed() called once for initial registration, not twice
      expect(embedding.embed).toHaveBeenCalledTimes(1)
    })
  })

  describe('extraSynonyms', () => {
    it('accepts custom synonym groups via constructor', async () => {
      const normalizer = new PredicateNormalizer(mockEmbedding(), 0.85, [
        ['COACHES', 'MANAGES', 'LEADS'],
      ])
      expect(await normalizer.normalize('MANAGES')).toBe('COACHES')
      expect(await normalizer.normalize('LEADS')).toBe('COACHES')
    })
  })
})
