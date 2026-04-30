import type { EmbeddingProvider } from '../../embedding/provider.js'
import { ALL_PREDICATES } from '../../index-engine/ontology.js'

export interface PredicateNormalizationResult {
  original: string
  predicate: string
  valid: boolean
  swapSubjectObject: boolean
  symmetric: boolean
}

const SYMMETRIC_PREDICATES = new Set<string>([
  'ALLIED_WITH',
  'BORDERS',
  'COLLABORATED_WITH',
  'COMPARED_WITH',
  'COMPATIBLE_WITH',
  'COMPETES_WITH',
  'CONNECTED_TO',
  'CORRESPONDS_WITH',
  'EQUIVALENT_TO',
  'MARRIED',
  'MERGED_WITH',
  'NEAR',
  'PARTNERED_WITH',
  'RIVALED',
  'SIBLING_OF',
])

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
  ['MARRIED', 'MARRIED_TO', 'WED', 'SPOUSE_OF', 'HUSBAND_OF', 'WIFE_OF'],
  ['DIVORCED', 'DIVORCED_FROM', 'SEPARATED_FROM'],
  ['CHILD_OF', 'SON_OF', 'DAUGHTER_OF', 'OFFSPRING_OF'],
  ['PARENT_OF', 'FATHER_OF', 'MOTHER_OF'],
  ['SIBLING_OF', 'BROTHER_OF', 'SISTER_OF'],
  ['MENTORED', 'MENTORED_BY', 'TRAINED', 'COACHED'],
  ['SUCCEEDED', 'SUCCEEDED_BY', 'REPLACED'],
  ['PRECEDED', 'CAME_BEFORE', 'PRIOR_TO'],
  ['INFLUENCED', 'INSPIRED'],
  ['RIVALED', 'RIVAL_OF', 'COMPETED_AGAINST'],
  ['OPPOSED', 'FOUGHT_AGAINST', 'RESISTED', 'CRITICIZED', 'CHALLENGED'],
  ['ALLIED_WITH', 'ALLIED_TO', 'ALIGNED_WITH'],
  ['COLLABORATED_WITH', 'COOPERATED_WITH', 'WORKED_WITH'],
  ['CORRESPONDS_WITH', 'WROTE_LETTER_TO', 'COMMUNICATED_WITH'],
  ['BEFRIENDED', 'FRIEND_OF', 'FRIENDS_WITH'],
  ['EMPLOYED', 'HIRED', 'HIRED_BY'],
  ['REPORTED_TO', 'SUBORDINATE_OF', 'UNDER'],
  ['SUPERVISED', 'MANAGED'],
  ['KILLED', 'MURDERED', 'ASSASSINATED'],
  ['BETRAYED', 'BETRAYED_BY', 'DECEIVED'],
  ['RESCUED', 'SAVED', 'LIBERATED'],
  ['SERVED', 'SERVED_UNDER', 'IN_SERVICE_OF'],

  // ── Person → Organization ──
  ['WORKS_FOR', 'EMPLOYED_AT', 'WORKS_AT'],
  ['WORKED_FOR', 'WORKED_AT'],
  ['FOUNDED', 'CO_FOUNDED', 'ESTABLISHED'],
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
  ['WROTE', 'AUTHORED', 'COMPOSED', 'PENNED'],
  ['DIRECTED', 'HELMED'],
  ['ILLUSTRATED', 'DREW'],
  ['DESIGNED'],
  ['INVENTED'],
  ['PERFORMED_IN', 'APPEARED_IN', 'STARRED_IN', 'ACTED_IN'],
  ['NARRATED', 'VOICED'],
  ['EDITED', 'REVISED'],
  ['TRANSLATED'],
  ['REVIEWED', 'CRITIQUED'],
  ['COMMISSIONED', 'ORDERED'],
  ['DEDICATED_TO', 'IN_HONOR_OF'],

  // ── Person → Concept / Event ──
  ['WORKS_AS', 'IS_A', 'IS_AN', 'JOB_IS', 'OCCUPATION_IS', 'ROLE_IS', 'TITLE_IS', 'WORKS_IN_ROLE', 'WORKS_AS_A'],
  ['WORKED_AS', 'WAS_A', 'WAS_AN', 'WORKED_IN_ROLE', 'WORKED_AS_A'],
  ['HELD_ROLE', 'HELD_POSITION', 'SERVED_AS', 'SERVES_AS', 'HELD_TITLE', 'BY_PROFESSION'],
  ['PRACTICED_AS', 'PRACTISED_AS'],
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
  ['TREATED'],

  // ── Organization → Organization ──
  ['ACQUIRED', 'BOUGHT', 'PURCHASED'],
  ['MERGED_WITH', 'MERGED_INTO'],
  ['SPUN_OFF', 'SPUN_OFF_FROM', 'DIVESTED'],
  ['PARTNERED_WITH', 'PARTNER_OF', 'IN_PARTNERSHIP_WITH'],
  ['COMPETES_WITH', 'COMPETITOR_OF', 'RIVALS'],
  ['SUED', 'LITIGATED_AGAINST'],
  ['REGULATED_BY', 'OVERSEEN_BY'],
  ['SANCTIONED', 'PENALIZED'],
  ['FUNDED', 'FINANCED'],
  ['SUBSIDIZED'],
  ['SUPPLIED', 'VENDOR_OF', 'SUPPLIER_TO'],

  // ── Organization → Location ──
  ['HEADQUARTERED_IN', 'BASED_IN', 'HQ_IN'],
  ['LOCATED_IN', 'SITUATED_IN'],
  ['OPERATES_IN', 'ACTIVE_IN', 'PRESENT_IN'],
  ['INCORPORATED_IN', 'REGISTERED_IN', 'CHARTERED_IN'],
  ['EXPANDED_TO', 'ENTERED'],
  ['WITHDREW_FROM', 'EXITED', 'PULLED_OUT_OF'],

  // ── Organization → Product ──
  ['PRODUCED', 'MADE', 'MANUFACTURED'],
  ['PUBLISHED', 'PUBLISHED_IN', 'RELEASED', 'ISSUED'],
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
  ['IMPLEMENTS', 'REALIZES'],
  ['REQUIRES', 'DEPENDS_ON', 'NEEDS'],
  ['COMPATIBLE_WITH', 'WORKS_WITH', 'INTEROPERABLE_WITH'],
  ['REPLACES'],
  ['DEPRECATED_BY', 'OBSOLETED_BY'],
  ['GOVERNS', 'CONTROLS', 'OVERSEES'],
  ['REGULATES'],
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
  ['SIGNED', 'SIGNED_WITH'],
  ['OWNS', 'OWNER_OF', 'POSSESSED'],

  // ── Announcement / Reporting (kept from original) ──
  ['ANNOUNCED', 'DECLARED', 'PROCLAIMED', 'STATED'],
  ['REPORTED', 'DOCUMENTED', 'RECORDED', 'CHRONICLED'],
]

const INVERSE_SYNONYMS = new Map<string, string>([
  ['KILLED_BY', 'KILLED'],
  ['SLAIN_BY', 'KILLED'],
  ['MURDERED_BY', 'KILLED'],
  ['ASSASSINATED_BY', 'KILLED'],
  ['BETRAYED_BY', 'BETRAYED'],
  ['SUCCEEDED_BY', 'SUCCEEDED'],
  ['INFLUENCED_BY', 'INFLUENCED'],
  ['INSPIRED_BY', 'INSPIRED'],
  ['MENTORED_BY', 'MENTORED'],
  ['TRAINED_BY', 'MENTORED'],
  ['COACHED_BY', 'MENTORED'],
  ['HIRED_BY', 'EMPLOYED'],
  ['SUPERVISED_BY', 'SUPERVISED'],
  ['MANAGED_BY', 'SUPERVISED'],
  ['EMPLOYED_BY', 'WORKS_FOR'],
  ['WAS_EMPLOYED_BY', 'WORKED_FOR'],
  ['FOUNDED_BY', 'FOUNDED'],
  ['CO_FOUNDED_BY', 'CO_FOUNDED'],
  ['WRITTEN_BY', 'WROTE'],
  ['AUTHORED_BY', 'AUTHORED'],
  ['COMPOSED_BY', 'COMPOSED'],
  ['DIRECTED_BY', 'DIRECTED'],
  ['ILLUSTRATED_BY', 'ILLUSTRATED'],
  ['DESIGNED_BY', 'DESIGNED'],
  ['INVENTED_BY', 'INVENTED'],
  ['NARRATED_BY', 'NARRATED'],
  ['EDITED_BY', 'EDITED'],
  ['TRANSLATED_BY', 'TRANSLATED'],
  ['REVIEWED_BY', 'REVIEWED'],
  ['COMMISSIONED_BY', 'COMMISSIONED'],
  ['TREATED_BY', 'TREATED'],
  ['CURED_BY', 'TREATED'],
  ['SUED_BY', 'SUED'],
  ['SANCTIONED_BY', 'SANCTIONED'],
  ['FUNDED_BY', 'FUNDED'],
  ['FINANCED_BY', 'FUNDED'],
  ['SUBSIDIZED_BY', 'SUBSIDIZED'],
  ['SUPPLIED_BY', 'SUPPLIED'],
  ['PUBLISHED_BY', 'PUBLISHED'],
  ['DISTRIBUTES_BY', 'DISTRIBUTES'],
  ['DISTRIBUTED_BY', 'DISTRIBUTES'],
  ['LICENSED_BY', 'LICENSES'],
  ['LICENSED_TO', 'LICENSES'],
  ['IMPLEMENTS_BY', 'IMPLEMENTS'],
  ['REPLACED_BY', 'REPLACES'],
  ['REGULATES_BY', 'REGULATES'],
  ['ENFORCED', 'ENFORCED_BY'],
  ['AMENDED_BY', 'AMENDED_BY'],
  ['MODIFIED_BY', 'AMENDED_BY'],
  ['REVISED_BY', 'AMENDED_BY'],
  ['OWNED_BY', 'OWNS'],
  ['ACQUIRED_BY', 'ACQUIRED'],
  ['PROPERTY_OF', 'OWNS'],
  ['REPRESENTED_BY', 'REPRESENTS'],
  ['SIGNED_BY', 'SIGNED'],
])

function sanitizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
}

export function isSymmetricPredicate(predicate: string): boolean {
  return SYMMETRIC_PREDICATES.has(predicate)
}

/**
 * Clusters semantically equivalent predicates into canonical forms.
 *
 * Without normalization, predicates like PLAYS_FOR, IS_A_PLAYER_FOR, PLAYED_FOR
 * are treated as distinct relation types, fragmenting graph traversal paths.
 *
 * Resolution order:
 * 1. Exact canonical match (O(1))
 * 2. Static synonym table (O(1))
 * 3. Inverse synonym table with subject/object swap metadata
 * 4. Ontology validation; unknown predicates are rejected
 */
export class PredicateNormalizer {
  private readonly canonicalPredicates = new Set<string>()
  private readonly synonymMap = new Map<string, string>()
  private readonly inverseSynonymMap = new Map<string, string>()

  constructor(_embedding: EmbeddingProvider, _threshold = 0.85, extraSynonyms?: readonly string[][]) {
    for (const group of [...SYNONYM_GROUPS, ...(extraSynonyms ?? [])]) {
      const canonical = sanitizePredicate(group[0]!)
      for (const synonym of group) {
        this.synonymMap.set(sanitizePredicate(synonym), canonical)
      }
    }
    for (const [synonym, canonical] of INVERSE_SYNONYMS) {
      this.inverseSynonymMap.set(sanitizePredicate(synonym), sanitizePredicate(canonical))
    }
  }

  /**
   * Normalize a predicate to its canonical form.
   */
  async normalize(predicate: string): Promise<string> {
    return this.normalizeWithDirection(predicate).predicate
  }

  normalizeWithDirection(predicate: string): PredicateNormalizationResult {
    const original = sanitizePredicate(predicate)
    const direct = this.synonymMap.get(original) ?? original
    const inverse = this.inverseSynonymMap.get(original)
    const normalized = inverse ?? direct
    const valid = (ALL_PREDICATES as ReadonlySet<string>).has(normalized)
    if (valid) this.canonicalPredicates.add(normalized)

    return {
      original,
      predicate: normalized,
      valid,
      swapSubjectObject: !!inverse,
      symmetric: isSymmetricPredicate(normalized),
    }
  }

  /** Number of canonical predicates registered. */
  get size(): number {
    return this.canonicalPredicates.size
  }
}
