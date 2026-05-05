import { describe, expect, it } from 'vitest'
import {
  ALIAS_RELATION_CUES,
  ALL_PREDICATES,
  ENTITY_TYPES,
  GENERIC_DISALLOWED_PREDICATES,
  PREDICATE_SPECS,
  SYMMETRIC_PREDICATES,
  normalizePredicateWithDirection,
  validatePredicateTypes,
} from '../index-engine/ontology.js'

describe('ontology registry', () => {
  it('keeps entity types and predicates unique and centralized', () => {
    expect(new Set(ENTITY_TYPES).size).toBe(ENTITY_TYPES.length)
    expect(new Set(PREDICATE_SPECS.map(spec => spec.name)).size).toBe(PREDICATE_SPECS.length)
    for (const spec of PREDICATE_SPECS) {
      expect(spec.category).toBeTruthy()
      expect(spec.description).toBeTruthy()
      expect(spec.domain.length).toBeGreaterThan(0)
      expect(spec.range.length).toBeGreaterThan(0)
      expect(ALL_PREDICATES.has(spec.name)).toBe(true)
    }
  })

  it('normalizes simplified aliases through the registry', () => {
    expect(normalizePredicateWithDirection('CO_FOUNDED')).toEqual(expect.objectContaining({
      predicate: 'FOUNDED',
      valid: true,
      swapSubjectObject: false,
    }))
    expect(normalizePredicateWithDirection('FOUNDED_BY')).toEqual(expect.objectContaining({
      predicate: 'FOUNDED',
      valid: true,
      swapSubjectObject: true,
    }))
    expect(normalizePredicateWithDirection('WORKED_AS')).toEqual(expect.objectContaining({
      predicate: 'WORKS_AS',
      temporalStatus: 'former',
    }))
    expect(normalizePredicateWithDirection('SUPPORTED')).toEqual(expect.objectContaining({
      predicate: 'SUPPORTS',
      valid: true,
    }))
  })

  it('promotes IS_A and rejects alias cues as graph predicates', () => {
    expect(normalizePredicateWithDirection('IS_A')).toEqual(expect.objectContaining({
      predicate: 'IS_A',
      valid: true,
    }))
    expect(GENERIC_DISALLOWED_PREDICATES.has('IS_A')).toBe(false)
    for (const cue of ALIAS_RELATION_CUES) {
      expect(normalizePredicateWithDirection(cue).valid).toBe(false)
    }
  })

  it('exposes symmetry and soft domain/range validation metadata', () => {
    expect(SYMMETRIC_PREDICATES.has('MARRIED')).toBe(true)
    expect(validatePredicateTypes('WORKS_FOR', 'person', 'organization')).toEqual(expect.objectContaining({
      valid: true,
    }))
    expect(validatePredicateTypes('WORKS_FOR', 'issue', 'artifact')).toEqual(expect.objectContaining({
      valid: false,
      reason: 'domain-range-mismatch',
    }))
  })
})

