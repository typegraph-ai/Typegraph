import { describe, expect, it, vi } from 'vitest'
import { PredicateNormalizer, isSymmetricPredicate } from '../extraction/predicate-normalizer.js'
import type { EmbeddingProvider } from '../../embedding/provider.js'

function mockEmbedding(): EmbeddingProvider {
  return {
    model: 'test-model',
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }
}

describe('PredicateNormalizer', () => {
  it('normalizes ontology aliases without swapping when direction is already active', () => {
    const normalizer = new PredicateNormalizer(mockEmbedding())

    expect(normalizer.normalizeWithDirection('WORKS_AT')).toEqual({
      original: 'WORKS_AT',
      predicate: 'WORKS_FOR',
      valid: true,
      swapSubjectObject: false,
      symmetric: false,
    })
  })

  it('normalizes inverse passive predicates with subject/object swap', () => {
    const normalizer = new PredicateNormalizer(mockEmbedding())

    expect(normalizer.normalizeWithDirection('KILLED_BY')).toEqual({
      original: 'KILLED_BY',
      predicate: 'KILLED',
      valid: true,
      swapSubjectObject: true,
      symmetric: false,
    })
    expect(normalizer.normalizeWithDirection('FOUNDED_BY').swapSubjectObject).toBe(true)
    expect(normalizer.normalizeWithDirection('WRITTEN_BY').predicate).toBe('WROTE')
    expect(normalizer.normalizeWithDirection('OWNED_BY')).toEqual(expect.objectContaining({
      predicate: 'OWNS',
      swapSubjectObject: true,
      valid: true,
    }))
  })

  it('normalizes gendered spouse and sibling predicates to symmetric canonicals', () => {
    const normalizer = new PredicateNormalizer(mockEmbedding())

    expect(normalizer.normalizeWithDirection('HUSBAND_OF')).toEqual(expect.objectContaining({
      predicate: 'MARRIED',
      valid: true,
      swapSubjectObject: false,
      symmetric: true,
    }))
    expect(normalizer.normalizeWithDirection('WIFE_OF').predicate).toBe('MARRIED')
    expect(normalizer.normalizeWithDirection('BROTHER_OF')).toEqual(expect.objectContaining({
      predicate: 'SIBLING_OF',
      symmetric: true,
    }))
    expect(isSymmetricPredicate('MARRIED')).toBe(true)
  })

  it('keeps tense-significant predicates separate', async () => {
    const normalizer = new PredicateNormalizer(mockEmbedding())

    expect(await normalizer.normalize('WORKS_FOR')).toBe('WORKS_FOR')
    expect(await normalizer.normalize('WORKED_FOR')).toBe('WORKED_FOR')
    expect(await normalizer.normalize('WAS_EMPLOYED_BY')).toBe('WORKED_FOR')
    expect(normalizer.normalizeWithDirection('WAS_EMPLOYED_BY').swapSubjectObject).toBe(true)
  })

  it('rejects invented predicates that are not in the ontology', async () => {
    const normalizer = new PredicateNormalizer(mockEmbedding())

    expect(normalizer.normalizeWithDirection('FUNERAL_CHAMBER_IN')).toEqual({
      original: 'FUNERAL_CHAMBER_IN',
      predicate: 'FUNERAL_CHAMBER_IN',
      valid: false,
      swapSubjectObject: false,
      symmetric: false,
    })
    expect(await normalizer.normalize('FUNERAL_CHAMBER_IN')).toBe('FUNERAL_CHAMBER_IN')
    expect(normalizer.size).toBe(0)
  })

  it('does not accept extra synonym groups that canonicalize outside the ontology', () => {
    const normalizer = new PredicateNormalizer(mockEmbedding(), 0.85, [
      ['COACHES', 'MANAGES'],
    ])

    expect(normalizer.normalizeWithDirection('MANAGES')).toEqual(expect.objectContaining({
      predicate: 'COACHES',
      valid: false,
    }))
  })
})
