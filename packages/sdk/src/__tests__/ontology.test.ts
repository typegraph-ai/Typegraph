import { describe, expect, it } from 'vitest'
import {
  ALIAS_RELATION_CUES,
  ALL_PREDICATES,
  BUILT_IN_ENTITY_VOCABULARY,
  BUILT_IN_RELATION_VOCABULARY,
  ENTITY_TYPES,
  GENERIC_DISALLOWED_PREDICATES,
  PREDICATE_SPECS,
  SYMMETRIC_PREDICATES,
  compileOntology,
  getEntityTypesForPrompt,
  normalizePredicateWithDirection,
  validateOntologyConfig,
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
    expect(validatePredicateTypes('WORKS_FOR', 'issue', 'document')).toEqual(expect.objectContaining({
      valid: false,
      reason: 'domain-range-mismatch',
    }))
  })

  it('compiles ontology profiles into the same shape as user supplied ontology', () => {
    const ontology = compileOntology({ version: 'bench-literary', profiles: ['literary'] })
    expect(ontology.config.profiles).toEqual(['literary'])
    expect(ontology.entityTypes).toEqual(expect.arrayContaining(['character', 'place', 'building', 'creative_work', 'publication']))
    expect(ontology.relationNames).toEqual(expect.arrayContaining(['CONFLICT_WITH', 'APPEARS_IN', 'PUBLISHED_IN']))
    expect(getEntityTypesForPrompt(ontology)).toContain('character')
    expect(normalizePredicateWithDirection('AT_WAR_WITH', ontology)).toEqual(expect.objectContaining({
      predicate: 'CONFLICT_WITH',
      valid: true,
      symmetric: true,
    }))
    expect(normalizePredicateWithDirection('APPEARED_IN', ontology)).toEqual(expect.objectContaining({
      predicate: 'PUBLISHED_IN',
      valid: true,
    }))
    expect(validatePredicateTypes('APPEARS_IN', 'creative_work', 'publication', ontology).valid).toBe(false)
    expect(validatePredicateTypes('PUBLISHED_IN', 'creative_work', 'publication', ontology).valid).toBe(true)
  })

  it('borrows mature vocabulary references without expanding prompts', () => {
    const ontology = compileOntology({ version: 'medical+legal', profiles: ['medical', 'legal'] })
    expect(BUILT_IN_ENTITY_VOCABULARY.condition?.length).toBeGreaterThan(0)
    expect(BUILT_IN_RELATION_VOCABULARY.PROHIBITS?.length).toBeGreaterThan(0)
    expect(ontology.vocabulary.entities.condition).toEqual(expect.arrayContaining([
      expect.objectContaining({ vocabulary: 'HL7 FHIR', id: 'Condition' }),
      expect.objectContaining({ vocabulary: 'Mondo Disease Ontology' }),
    ]))
    expect(ontology.vocabulary.entities.clause).toEqual(expect.arrayContaining([
      expect.objectContaining({ vocabulary: 'European Legislation Identifier' }),
      expect.objectContaining({ vocabulary: 'Akoma Ntoso' }),
    ]))
    expect(ontology.vocabulary.relations.PROHIBITS).toEqual(expect.arrayContaining([
      expect.objectContaining({ vocabulary: 'LegalRuleML', id: 'Prohibition' }),
    ]))
    expect(getEntityTypesForPrompt(ontology)).not.toContain('SNOMED')
  })

  it('keeps custom ontology definitions compatible with built-in profiles', () => {
    const ontology = compileOntology({
      version: 'custom',
      profiles: ['saas'],
      entities: {
        renewal_risk: {
          extends: 'concept',
          description: 'A specific renewal risk.',
          vocabulary: [{ vocabulary: 'CRM demo ontology', id: 'RenewalRisk', match: 'exact' }],
        },
      },
      relations: {
        HAS_RISK: {
          from: ['account'],
          to: ['renewal_risk'],
          aliases: ['RISKED_BY'],
          description: 'An account has a renewal risk.',
          vocabulary: [{ vocabulary: 'CRM demo ontology', id: 'hasRisk', match: 'exact' }],
        },
      },
    })
    expect(ontology.entityTypes).toContain('renewal_risk')
    expect(ontology.relationNames).toContain('HAS_RISK')
    expect(normalizePredicateWithDirection('RISKED_BY', ontology)).toEqual(expect.objectContaining({
      predicate: 'HAS_RISK',
      valid: true,
    }))
    expect(validatePredicateTypes('HAS_RISK', 'account', 'renewal_risk', ontology).valid).toBe(true)
    expect(ontology.vocabulary.entities.renewal_risk).toEqual(expect.arrayContaining([
      expect.objectContaining({ vocabulary: 'CRM demo ontology', id: 'RenewalRisk' }),
    ]))
    expect(ontology.vocabulary.relations.HAS_RISK).toEqual(expect.arrayContaining([
      expect.objectContaining({ vocabulary: 'CRM demo ontology', id: 'hasRisk' }),
    ]))
  })

  it('supports strict custom ontologies without built-in profile leakage', () => {
    const ontology = validateOntologyConfig({
      version: 'customer-support-strict',
      mode: 'strict',
      profiles: ['saas'],
      entities: {
        customer: { description: 'A customer organization.' },
        escalation: { description: 'A named customer escalation.' },
      },
      relations: {
        HAS_ESCALATION: {
          from: ['customer'],
          to: ['escalation'],
          description: 'A customer has an escalation.',
        },
      },
    })

    expect(ontology.config.mode).toBe('strict')
    expect(ontology.entityTypes).toEqual(['customer', 'escalation'])
    expect(ontology.entityTypes).not.toContain('person')
    expect(ontology.entityTypes).not.toContain('account')
    expect(ontology.relationNames).toEqual(['HAS_ESCALATION'])
    expect(getEntityTypesForPrompt(ontology)).toContain('customer')
    expect(validatePredicateTypes('HAS_ESCALATION', 'customer', 'escalation', ontology).valid).toBe(true)
  })

  it('rejects invalid strict ontology relation endpoint types', () => {
    expect(() => validateOntologyConfig({
      version: 'bad-strict',
      mode: 'strict',
      entities: {
        customer: { description: 'A customer organization.' },
      },
      relations: {
        HAS_RISK: {
          from: ['customer'],
          to: ['risk'],
          description: 'A customer has a risk.',
        },
      },
    })).toThrow('unknown entity type "risk"')
  })

  it('uses the curated B2B SaaS ontology for the saas profile', () => {
    const ontology = compileOntology({ version: 'saas-test', profiles: ['saas'] })
    expect(ontology.entityTypes).toEqual(expect.arrayContaining([
      'company',
      'person',
      'role',
      'account',
      'opportunity',
      'feature_request',
      'security_control',
      'signal',
      'message',
      'renewal',
    ]))
    expect(ontology.entityTypes).not.toContain('contact')
    expect(ontology.entityTypes).not.toContain('persona')
    expect(ontology.relationNames).toEqual(expect.arrayContaining([
      'CHAMPIONS',
      'ECONOMIC_BUYER_FOR',
      'BLOCKS_RENEWAL',
      'WORKS_AT',
      'DISCUSSED_IN',
      'DOCUMENTED_BY',
    ]))
    expect(normalizePredicateWithDirection('economic_buyer_for', ontology)).toEqual(expect.objectContaining({
      predicate: 'ECONOMIC_BUYER_FOR',
      valid: true,
    }))
    expect(validatePredicateTypes('BLOCKS_RENEWAL', 'ticket', 'renewal', ontology).valid).toBe(true)
    expect(validatePredicateTypes('BLOCKS_RENEWAL', 'product', 'renewal', ontology).valid).toBe(false)
    expect(ontology.resolution.genericAliasBlocklist).toEqual(expect.arrayContaining([
      'the customer',
      'the cto',
      'eoq',
    ]))
    expect(ontology.prompt.entityGuidelines.join('\n')).toContain('Distinguish company as the legal organization from account')
  })
})
