import type { EmbeddingProvider } from '../../embedding/provider.js'
import {
  ALL_PREDICATES,
  isSymmetricPredicate,
  normalizePredicateWithDirection,
  sanitizePredicate,
  type PredicateNormalization,
} from '../../index-engine/ontology.js'

export interface PredicateNormalizationResult {
  original: string
  predicate: string
  valid: boolean
  swapSubjectObject: boolean
  symmetric: boolean
  temporalStatus?: PredicateNormalization['temporalStatus'] | undefined
}

export { isSymmetricPredicate }

/**
 * Thin compatibility wrapper over the central ontology registry.
 *
 * The registry owns canonical predicates, aliases, inverse direction, symmetry,
 * and temporal alias metadata. This class preserves the public API used by the
 * graph bridge and tests while avoiding a second predicate table.
 */
export class PredicateNormalizer {
  private readonly canonicalPredicates = new Set<string>()
  private readonly extraSynonymMap = new Map<string, string>()

  constructor(_embedding: EmbeddingProvider, _threshold = 0.85, extraSynonyms?: readonly string[][]) {
    for (const group of extraSynonyms ?? []) {
      const canonical = sanitizePredicate(group[0]!)
      for (const synonym of group) {
        this.extraSynonymMap.set(sanitizePredicate(synonym), canonical)
      }
    }
  }

  async normalize(predicate: string): Promise<string> {
    return this.normalizeWithDirection(predicate).predicate
  }

  normalizeWithDirection(predicate: string): PredicateNormalizationResult {
    const original = sanitizePredicate(predicate)
    const extra = this.extraSynonymMap.get(original)
    const normalized = extra
      ? {
          original,
          predicate: extra,
          valid: (ALL_PREDICATES as ReadonlySet<string>).has(extra),
          swapSubjectObject: false,
          symmetric: isSymmetricPredicate(extra),
        }
      : normalizePredicateWithDirection(original)

    if (normalized.valid) this.canonicalPredicates.add(normalized.predicate)
    return normalized
  }

  get size(): number {
    return this.canonicalPredicates.size
  }
}

