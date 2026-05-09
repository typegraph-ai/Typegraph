export { IndexEngine } from './engine.js'
export { defaultChunker } from './chunker.js'
export { DefaultGraphExtractor, TripleExtractor } from './triple-extractor.js'
export { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
export { stripMarkdown } from './strip-markdown.js'
export {
  ENTITY_TYPES,
  DEFAULT_ENTITY_TYPE,
  VALID_ENTITY_TYPES,
  ENTITY_TYPES_LIST,
  ENTITY_TYPE_SPECS,
  PREDICATE_SPECS,
  ALL_PREDICATES,
  PREDICATE_BY_NAME,
  SYMMETRIC_PREDICATES,
  GENERIC_DISALLOWED_PREDICATES,
  ALIAS_RELATION_CUES,
  ALIAS_ASSIGNMENT_CUES,
  sanitizePredicate,
  isSymmetricPredicate,
  getPredicatesForPrompt,
  effectiveEntityTypes,
  normalizePredicateWithDirection,
  normalizeTypeCandidates,
  typeAffinityGroup,
  typesShareAffinity,
  validatePredicateEffectiveTypes,
  validatePredicateTypes,
} from './ontology.js'
export type {
  EntityType,
  EntityTypeSpec,
  PredicateAliasSpec,
  PredicateSpec,
  PredicateTemporalStatus,
  PredicateNormalization,
  PredicateTypeValidation,
  TypeCandidate,
} from './ontology.js'
