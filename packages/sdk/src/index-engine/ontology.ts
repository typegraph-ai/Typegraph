/**
 * Predicate ontology for triple extraction.
 * ~150 predicates organized by entity-type pair.
 *
 * Design principles:
 * - Organized by entity-type pair so the model self-selects relevant predicates
 * - Excludes generic/vague predicates (IS, HAS, RELATED_TO, MENTIONED, ASSOCIATED_WITH)
 *   which are caught by GENERIC_PREDICATES filter in graph-bridge.ts
 * - Tense-significant predicates have separate present/past forms
 * - Each predicate should carry specific relational semantics, not just co-occurrence
 */

// ── Person → Person ──
const PERSON_PERSON = [
  'MARRIED', 'DIVORCED', 'CHILD_OF', 'PARENT_OF', 'SIBLING_OF',
  'MENTORED', 'SUCCEEDED', 'PRECEDED',
  'INFLUENCED', 'INSPIRED', 'RIVALED', 'OPPOSED', 'ALLIED_WITH',
  'COLLABORATED_WITH', 'CORRESPONDS_WITH', 'BEFRIENDED',
  'EMPLOYED', 'REPORTED_TO', 'SUPERVISED',
  'KILLED', 'BETRAYED', 'RESCUED', 'SERVED',
] as const

// ── Person → Organization ──
const PERSON_ORGANIZATION = [
  'WORKS_FOR', 'WORKED_FOR', 'FOUNDED', 'CO_FOUNDED',
  'LEADS', 'LED', 'ADVISES', 'ADVISED',
  'MEMBER_OF', 'JOINED', 'LEFT', 'EXPELLED_FROM',
  'INVESTED_IN', 'DONATED_TO', 'SUED',
  'REPRESENTS', 'REPRESENTED',
] as const

// ── Person → Location ──
const PERSON_LOCATION = [
  'BORN_IN', 'DIED_IN', 'LIVES_IN', 'LIVED_IN',
  'TRAVELED_TO', 'VISITED', 'MOVED_TO', 'EXILED_TO',
  'GOVERNED', 'RULED', 'CONQUERED', 'DEFENDED',
  'IMPRISONED_IN', 'ESCAPED_FROM',
] as const

// ── Person → Work of Art / Product ──
const PERSON_WORK = [
  'WROTE', 'AUTHORED', 'COMPOSED', 'DIRECTED',
  'ILLUSTRATED', 'DESIGNED', 'INVENTED',
  'PERFORMED_IN', 'STARRED_IN', 'NARRATED',
  'EDITED', 'TRANSLATED', 'REVIEWED', 'CRITIQUED',
  'COMMISSIONED', 'DEDICATED_TO',
] as const

// ── Person → Concept / Event ──
const PERSON_CONCEPT = [
  'WORKS_AS', 'WORKED_AS', 'HELD_ROLE', 'PRACTICED_AS',
  'STUDIED', 'TAUGHT', 'DISCOVERED', 'DEVELOPED',
  'PROPOSED', 'ADVOCATED_FOR', 'CHAMPIONED',
  'PARTICIPATED_IN', 'WITNESSED', 'SURVIVED',
  'SPOKE_AT', 'ATTENDED', 'ORGANIZED',
  'AWARDED', 'NOMINATED', 'DIAGNOSED', 'TREATED',
] as const

// ── Organization → Organization ──
const ORG_ORG = [
  'ACQUIRED', 'MERGED_WITH', 'SPUN_OFF',
  'PARTNERED_WITH', 'COMPETES_WITH',
  'SUED', 'REGULATED_BY', 'SANCTIONED',
  'FUNDED', 'SUBSIDIZED', 'SUPPLIED',
  'SUCCEEDED', 'PRECEDED', 'ALLIED_WITH', 'OPPOSED',
] as const

// ── Organization → Location ──
const ORG_LOCATION = [
  'HEADQUARTERED_IN', 'LOCATED_IN', 'OPERATES_IN',
  'INCORPORATED_IN', 'EXPANDED_TO', 'WITHDREW_FROM',
] as const

// ── Organization → Product / Work ──
const ORG_PRODUCT = [
  'PRODUCED', 'MANUFACTURES', 'PUBLISHED',
  'DISTRIBUTES', 'LICENSES', 'DEVELOPED',
  'LAUNCHED', 'DISCONTINUED',
] as const

// ── Location → Location ──
const LOCATION_LOCATION = [
  'BORDERS', 'CONTAINS', 'PART_OF',
  'CAPITAL_OF', 'NEAR', 'CONNECTED_TO',
] as const

// ── Concept → Concept ──
const CONCEPT_CONCEPT = [
  'DERIVES_FROM', 'EXTENDS', 'CONTRADICTS',
  'SUBSET_OF', 'SUPERSEDES', 'EQUIVALENT_TO',
  'INFLUENCES', 'PRECEDED', 'FOLLOWED',
  'APPLIED_TO', 'ENABLES',
] as const

// ── Event → Entity ──
const EVENT_RELATIONS = [
  'OCCURRED_IN', 'OCCURRED_AT',
  'CAUSED', 'LED_TO', 'RESULTED_IN', 'TRIGGERED',
  'PRECEDED', 'FOLLOWED',
] as const

// ── Technology / Law ──
const TECHNICAL_RELATIONS = [
  'IMPLEMENTS', 'BASED_ON', 'REQUIRES',
  'COMPATIBLE_WITH', 'REPLACES', 'DEPRECATED_BY',
  'GOVERNS', 'REGULATES', 'PROHIBITS', 'PERMITS',
  'ENFORCED_BY', 'AMENDED_BY', 'REPEALED',
] as const

// ── General (any entity-type pair) ──
const GENERAL_RELATIONS = [
  'CREATED', 'DESTROYED', 'SUPPORTED', 'OPPOSED',
  'NAMED_AFTER', 'KNOWN_AS', 'SYMBOLIZES',
  'REFERS_TO', 'DESCRIBED', 'COMPARED_WITH',
  'FOUGHT_IN', 'SIGNED', 'OWNS',
] as const

/**
 * Get the full predicate vocabulary formatted for the extraction prompt.
 * Organized by entity-type pair so the model can self-select relevant predicates.
 */
export function getPredicatesForPrompt(): string {
  return `Predicate vocabulary (choose from this list when applicable):

Person → Person: ${PERSON_PERSON.join(', ')}
Person → Organization: ${PERSON_ORGANIZATION.join(', ')}
Person → Location: ${PERSON_LOCATION.join(', ')}
Person → Work/Product: ${PERSON_WORK.join(', ')}
Person → Concept/Event: ${PERSON_CONCEPT.join(', ')}
Organization → Organization: ${ORG_ORG.join(', ')}
Organization → Location: ${ORG_LOCATION.join(', ')}
Organization → Product: ${ORG_PRODUCT.join(', ')}
Location → Location: ${LOCATION_LOCATION.join(', ')}
Concept → Concept: ${CONCEPT_CONCEPT.join(', ')}
Event relations: ${EVENT_RELATIONS.join(', ')}
Technology/Law: ${TECHNICAL_RELATIONS.join(', ')}
General (any pair): ${GENERAL_RELATIONS.join(', ')}

Use ONLY predicates from this vocabulary. Do not invent new predicate names.`
}

/** All canonical predicates from the ontology (flattened). */
export const ALL_PREDICATES = new Set([
  ...PERSON_PERSON, ...PERSON_ORGANIZATION, ...PERSON_LOCATION,
  ...PERSON_WORK, ...PERSON_CONCEPT,
  ...ORG_ORG, ...ORG_LOCATION, ...ORG_PRODUCT,
  ...LOCATION_LOCATION, ...CONCEPT_CONCEPT,
  ...EVENT_RELATIONS, ...TECHNICAL_RELATIONS, ...GENERAL_RELATIONS,
])
