import type { EmbeddingProvider } from '@d8um/core'

/**
 * Synonym groups: first element is canonical form, rest map to it.
 * Tense variants are SEPARATE groups — they carry temporal meaning
 * (e.g. PLAYS_FOR = current, PLAYED_FOR = past).
 *
 * Groups are organized to match the ontology in packages/core/src/index-engine/ontology.ts.
 * Every canonical predicate in the ontology should have a synonym group here.
 */
const SYNONYM_GROUPS: readonly string[][] = [
  // ── Person → Person ──
  ['MARRIED', 'MARRIED_TO', 'WED', 'SPOUSE_OF'],
  ['DIVORCED', 'DIVORCED_FROM', 'SEPARATED_FROM'],
  ['CHILD_OF', 'SON_OF', 'DAUGHTER_OF', 'OFFSPRING_OF'],
  ['PARENT_OF', 'FATHER_OF', 'MOTHER_OF'],
  ['SIBLING_OF', 'BROTHER_OF', 'SISTER_OF'],
  ['MENTORED', 'MENTORED_BY', 'TRAINED', 'COACHED'],
  ['APPRENTICED_UNDER', 'STUDIED_UNDER', 'PUPIL_OF'],
  ['SUCCEEDED', 'SUCCEEDED_BY', 'REPLACED'],
  ['PRECEDED', 'CAME_BEFORE', 'PRIOR_TO'],
  ['INFLUENCED', 'INFLUENCED_BY', 'INSPIRED', 'INSPIRED_BY'],
  ['RIVALED', 'RIVAL_OF', 'COMPETED_AGAINST'],
  ['OPPOSED', 'FOUGHT_AGAINST', 'RESISTED', 'CRITICIZED', 'CHALLENGED'],
  ['ALLIED_WITH', 'ALLIED_TO', 'ALIGNED_WITH'],
  ['COLLABORATED_WITH', 'COOPERATED_WITH', 'WORKED_WITH'],
  ['CORRESPONDS_WITH', 'WROTE_LETTER_TO', 'COMMUNICATED_WITH'],
  ['BEFRIENDED', 'FRIEND_OF', 'FRIENDS_WITH'],
  ['EMPLOYED', 'HIRED', 'HIRED_BY'],
  ['REPORTED_TO', 'SUBORDINATE_OF', 'UNDER'],
  ['SUPERVISED', 'MANAGED'],
  ['KILLED', 'MURDERED', 'SLAIN_BY', 'ASSASSINATED'],
  ['BETRAYED', 'BETRAYED_BY', 'DECEIVED'],
  ['RESCUED', 'SAVED', 'LIBERATED'],
  ['SERVED', 'SERVED_UNDER', 'IN_SERVICE_OF'],

  // ── Person → Organization ──
  ['WORKS_FOR', 'EMPLOYED_BY', 'EMPLOYED_AT', 'WORKS_AT'],
  ['WORKED_FOR', 'WORKED_AT', 'WAS_EMPLOYED_BY', 'WAS_EMPLOYED_AT'],
  ['FOUNDED', 'FOUNDED_BY', 'CO_FOUNDED', 'CO_FOUNDED_BY', 'ESTABLISHED'],
  ['LEADS', 'LEADS_AT', 'HEADS', 'DIRECTS', 'CHAIRS'],
  ['LED', 'LED_AT', 'HEADED', 'CHAIRED'],
  ['ADVISES', 'ADVISES_AT', 'CONSULTS_FOR'],
  ['ADVISED', 'ADVISED_AT', 'CONSULTED_FOR'],
  ['MEMBER_OF', 'BELONGS_TO', 'JOINED', 'AFFILIATED_WITH'],
  ['LEFT', 'DEPARTED', 'RESIGNED_FROM', 'QUIT'],
  ['EXPELLED_FROM', 'DISMISSED_FROM', 'FIRED_FROM', 'REMOVED_FROM'],
  ['INVESTED_IN', 'INVESTOR_IN', 'BACKED'],
  ['DONATED_TO', 'CONTRIBUTED_TO', 'GAVE_TO'],
  ['REPRESENTS', 'REPRESENTATIVE_OF', 'SPEAKS_FOR'],
  ['REPRESENTED', 'REPRESENTED_BY'],

  // ── Person → Location ──
  ['BORN_IN', 'BORN_AT', 'NATIVE_OF', 'BIRTHPLACE'],
  ['DIED_IN', 'DIED_AT', 'BURIED_IN'],
  ['LIVES_IN', 'RESIDES_IN', 'DWELLING_IN'],
  ['LIVED_IN', 'RESIDED_IN', 'SETTLED_IN', 'DWELT_IN'],
  ['TRAVELED_TO', 'WENT_TO', 'JOURNEYED_TO'],
  ['VISITED', 'BEEN_TO', 'STOPPED_AT'],
  ['MOVED_TO', 'RELOCATED_TO', 'MIGRATED_TO'],
  ['EXILED_TO', 'BANISHED_TO', 'DEPORTED_TO'],
  ['GOVERNED', 'ADMINISTERED', 'OVERSAW'],
  ['RULED', 'REIGNED_OVER', 'CONTROLLED'],
  ['CONQUERED', 'CAPTURED', 'SEIZED'],
  ['DEFENDED', 'PROTECTED', 'GUARDED'],
  ['IMPRISONED_IN', 'JAILED_IN', 'DETAINED_IN', 'HELD_IN'],
  ['ESCAPED_FROM', 'FLED', 'FLED_FROM'],

  // ── Person → Work of Art / Product ──
  ['WROTE', 'AUTHORED', 'WRITTEN_BY', 'COMPOSED', 'PENNED'],
  ['DIRECTED', 'DIRECTED_BY', 'HELMED'],
  ['ILLUSTRATED', 'ILLUSTRATED_BY', 'DREW'],
  ['DESIGNED', 'DESIGNED_BY'],
  ['INVENTED', 'INVENTED_BY'],
  ['PERFORMED_IN', 'APPEARED_IN', 'STARRED_IN', 'ACTED_IN'],
  ['NARRATED', 'NARRATED_BY', 'VOICED'],
  ['EDITED', 'EDITED_BY', 'REVISED'],
  ['TRANSLATED', 'TRANSLATED_BY'],
  ['REVIEWED', 'REVIEWED_BY', 'CRITIQUED'],
  ['COMMISSIONED', 'COMMISSIONED_BY', 'ORDERED'],
  ['DEDICATED_TO', 'IN_HONOR_OF'],

  // ── Person → Concept / Event ──
  ['STUDIED', 'STUDIED_AT', 'EDUCATED_AT', 'ENROLLED_IN'],
  ['TAUGHT', 'TAUGHT_AT', 'INSTRUCTED', 'LECTURED'],
  ['DISCOVERED', 'FOUND', 'UNCOVERED', 'IDENTIFIED'],
  ['DEVELOPED', 'BUILT', 'ENGINEERED'],
  ['PROPOSED', 'SUGGESTED', 'PUT_FORWARD'],
  ['ADVOCATED_FOR', 'CHAMPIONED', 'PROMOTED'],
  ['PARTICIPATED_IN', 'TOOK_PART_IN', 'ENGAGED_IN', 'INVOLVED_IN'],
  ['WITNESSED', 'SAW', 'OBSERVED'],
  ['SURVIVED', 'LIVED_THROUGH', 'ENDURED'],
  ['SPOKE_AT', 'PRESENTED_AT', 'ADDRESSED'],
  ['ATTENDED', 'PRESENT_AT'],
  ['ORGANIZED', 'ARRANGED', 'COORDINATED'],
  ['AWARDED', 'RECEIVED', 'HONORED_WITH', 'GRANTED'],
  ['NOMINATED', 'NOMINATED_FOR', 'SHORTLISTED'],
  ['DIAGNOSED', 'DIAGNOSED_WITH', 'AFFLICTED_BY', 'SUFFERED_FROM'],
  ['TREATED', 'TREATED_BY', 'CURED_BY'],

  // ── Organization → Organization ──
  ['ACQUIRED', 'BOUGHT', 'PURCHASED'],
  ['MERGED_WITH', 'MERGED_INTO'],
  ['SPUN_OFF', 'SPUN_OFF_FROM', 'DIVESTED'],
  ['PARTNERED_WITH', 'PARTNER_OF', 'IN_PARTNERSHIP_WITH'],
  ['COMPETES_WITH', 'COMPETITOR_OF', 'RIVALS'],
  ['SUED', 'SUED_BY', 'LITIGATED_AGAINST'],
  ['REGULATED_BY', 'OVERSEEN_BY', 'SUPERVISED_BY'],
  ['SANCTIONED', 'SANCTIONED_BY', 'PENALIZED'],
  ['FUNDED', 'FUNDED_BY', 'FINANCED', 'FINANCED_BY'],
  ['SUBSIDIZED', 'SUBSIDIZED_BY'],
  ['SUPPLIED', 'SUPPLIED_BY', 'VENDOR_OF', 'SUPPLIER_TO'],

  // ── Organization → Location ──
  ['HEADQUARTERED_IN', 'BASED_IN', 'HQ_IN'],
  ['LOCATED_IN', 'SITUATED_IN'],
  ['OPERATES_IN', 'ACTIVE_IN', 'PRESENT_IN'],
  ['INCORPORATED_IN', 'REGISTERED_IN', 'CHARTERED_IN'],
  ['EXPANDED_TO', 'ENTERED'],
  ['WITHDREW_FROM', 'EXITED', 'PULLED_OUT_OF'],

  // ── Organization → Product ──
  ['PRODUCED', 'MADE', 'MANUFACTURED'],
  ['PUBLISHED', 'PUBLISHED_BY', 'PUBLISHED_IN', 'RELEASED', 'ISSUED'],
  ['DISTRIBUTES', 'DISTRIBUTES_BY', 'SELLS'],
  ['LICENSES', 'LICENSED_BY', 'LICENSED_TO'],
  ['LAUNCHED', 'INTRODUCED', 'UNVEILED', 'DEBUTED'],
  ['DISCONTINUED', 'ENDED', 'RETIRED'],

  // ── Location → Location ──
  ['BORDERS', 'BORDERS_ON', 'ADJACENT_TO'],
  ['CONTAINS', 'INCLUDES', 'ENCOMPASSES'],
  ['PART_OF', 'WITHIN'],
  ['CAPITAL_OF', 'CAPITAL_CITY_OF'],
  ['NEAR', 'CLOSE_TO', 'NEARBY'],

  // ── Concept → Concept ──
  ['DERIVES_FROM', 'DERIVED_FROM', 'BASED_ON', 'ORIGINATES_FROM'],
  ['EXTENDS', 'BUILDS_ON', 'EXPANDS'],
  ['CONTRADICTS', 'CONFLICTS_WITH', 'OPPOSES'],
  ['SUPERSEDES', 'SUPPLANTS'],
  ['EQUIVALENT_TO', 'SAME_AS', 'IDENTICAL_TO'],
  ['INFLUENCES', 'AFFECTS', 'IMPACTS'],
  ['APPLIED_TO', 'USED_IN', 'UTILIZED_IN'],
  ['ENABLES', 'FACILITATES'],

  // ── Event relations ──
  ['OCCURRED_IN', 'TOOK_PLACE_IN', 'HAPPENED_IN'],
  ['OCCURRED_AT', 'TOOK_PLACE_AT', 'HAPPENED_AT'],
  ['CAUSED', 'LED_TO', 'RESULTED_IN', 'TRIGGERED'],
  ['FOLLOWED', 'CAME_AFTER'],

  // ── Technology / Law ──
  ['IMPLEMENTS', 'IMPLEMENTS_BY', 'REALIZES'],
  ['REQUIRES', 'DEPENDS_ON', 'NEEDS'],
  ['COMPATIBLE_WITH', 'WORKS_WITH', 'INTEROPERABLE_WITH'],
  ['REPLACES', 'REPLACED_BY'],
  ['DEPRECATED_BY', 'OBSOLETED_BY'],
  ['GOVERNS', 'CONTROLS', 'OVERSEES'],
  ['REGULATES', 'REGULATES_BY'],
  ['PROHIBITS', 'BANS', 'FORBIDS'],
  ['PERMITS', 'ALLOWS', 'AUTHORIZES'],
  ['ENFORCED_BY', 'ENFORCED', 'POLICED_BY'],
  ['AMENDED_BY', 'MODIFIED_BY', 'REVISED_BY'],
  ['REPEALED', 'REVOKED', 'ANNULLED', 'RESCINDED'],

  // ── General ──
  ['CREATED', 'CONSTRUCTED', 'FABRICATED'],
  ['DESTROYED', 'DEMOLISHED', 'RAZED', 'OBLITERATED'],
  ['SUPPORTED', 'ENDORSED'],
  ['NAMED_AFTER', 'NAMED_FOR', 'EPONYMOUS_WITH'],
  ['KNOWN_AS', 'ALSO_CALLED', 'ALIAS', 'AKA'],
  ['SYMBOLIZES', 'STANDS_FOR', 'EMBODIES'],
  ['DESCRIBED', 'DESCRIBES', 'DEPICTED', 'PORTRAYED', 'CHARACTERIZED'],
  ['COMPARED_WITH', 'COMPARED_TO', 'LIKENED_TO', 'CONTRASTED_WITH'],
  ['FOUGHT_IN', 'SERVED_IN', 'BATTLED_IN'],
  ['SIGNED', 'SIGNED_BY', 'SIGNED_WITH'],
  ['OWNS', 'OWNER_OF', 'POSSESSED'],
  ['OWNED_BY', 'ACQUIRED_BY', 'PROPERTY_OF'],

  // ── Announcement / Reporting (kept from original) ──
  ['ANNOUNCED', 'DECLARED', 'PROCLAIMED', 'STATED'],
  ['REPORTED', 'DOCUMENTED', 'RECORDED', 'CHRONICLED'],
]

/**
 * Clusters semantically equivalent predicates into canonical forms.
 *
 * Without normalization, predicates like PLAYS_FOR, IS_A_PLAYER_FOR, PLAYED_FOR
 * are treated as distinct relation types, fragmenting graph traversal paths.
 *
 * Resolution order:
 * 1. Exact canonical match (O(1))
 * 2. Static synonym table (O(1) deterministic)
 * 3. Resolved cache (skips embedding for repeated surface forms)
 * 4. Embedding similarity with tense guard (prevents cross-tense merging)
 * 5. Register as new canonical form
 */
export class PredicateNormalizer {
  private readonly embedding: EmbeddingProvider
  private readonly threshold: number
  private readonly canonicalPredicates = new Map<string, number[]>() // predicate → embedding
  // Cache: normalized text → canonical predicate (skips embedding for repeated surface forms)
  private readonly resolvedCache = new Map<string, string>()
  // Static synonym lookup: EMPLOYED_BY → WORKS_FOR, etc.
  private readonly synonymMap = new Map<string, string>()

  constructor(embedding: EmbeddingProvider, threshold = 0.85, extraSynonyms?: readonly string[][]) {
    this.embedding = embedding
    this.threshold = threshold
    for (const group of [...SYNONYM_GROUPS, ...(extraSynonyms ?? [])]) {
      const canonical = group[0]!
      for (const synonym of group) {
        this.synonymMap.set(synonym, canonical)
      }
    }
  }

  /**
   * Normalize a predicate to its canonical form.
   */
  async normalize(predicate: string): Promise<string> {
    // 1. Exact match — skip everything
    if (this.canonicalPredicates.has(predicate)) return predicate

    // 2. Static synonym lookup (O(1))
    const synonymCanonical = this.synonymMap.get(predicate)
    if (synonymCanonical) {
      this.resolvedCache.set(predicate.replace(/_/g, ' ').toLowerCase(), synonymCanonical)
      if (!this.canonicalPredicates.has(synonymCanonical)) {
        const embedding = await this.embedding.embed(synonymCanonical.replace(/_/g, ' ').toLowerCase())
        this.canonicalPredicates.set(synonymCanonical, embedding)
      }
      return synonymCanonical
    }

    // 3. Resolved cache (catches variants we've already mapped)
    const normalizedText = predicate.replace(/_/g, ' ').toLowerCase()
    const cached = this.resolvedCache.get(normalizedText)
    if (cached) return cached

    // 4. Embedding comparison with tense guard
    const predicateEmbedding = await this.embedding.embed(normalizedText)

    let bestMatch: string | null = null
    let bestSimilarity = 0

    for (const [canonical, embedding] of this.canonicalPredicates) {
      const similarity = cosineSimilarity(predicateEmbedding, embedding)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestMatch = canonical
      }
    }

    if (bestMatch && bestSimilarity >= this.threshold && !hasTenseMismatch(predicate, bestMatch)) {
      this.resolvedCache.set(normalizedText, bestMatch)
      return bestMatch
    }

    // 5. Register as new canonical predicate
    this.canonicalPredicates.set(predicate, predicateEmbedding)
    this.resolvedCache.set(normalizedText, predicate)
    return predicate
  }

  /** Number of canonical predicates registered. */
  get size(): number {
    return this.canonicalPredicates.size
  }
}

/**
 * Detects tense mismatch between two SCREAMING_SNAKE_CASE predicates.
 * Prevents embedding fallback from merging PLAYS_FOR with PLAYED_FOR.
 */
function hasTenseMismatch(a: string, b: string): boolean {
  const verbA = a.split('_')[0] ?? ''
  const verbB = b.split('_')[0] ?? ''
  const isPast = (v: string) => v.endsWith('ED')
  const isPresent = (v: string) => v.endsWith('S') || v.endsWith('ES')
  return (isPast(verbA) && isPresent(verbB)) || (isPast(verbB) && isPresent(verbA))
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
