/**
 * Central ontology registry for graph extraction, predicate normalization,
 * query-intent parsing, and graph write validation.
 *
 * Keep entity types, canonical predicates, aliases, inverse direction, symmetry,
 * prompt grouping, and soft domain/range metadata here. Other modules should
 * import the derived helpers instead of maintaining their own predicate lists.
 */

export const ENTITY_TYPES = [
  'person',
  'organization',
  'location',
  'product',
  'technology',
  'concept',
  'event',
  'meeting',
  'artifact',
  'project',
  'issue',
  'role',
  'law_regulation',
  'time_period',
  'creative_work',
] as const

export type EntityType = typeof ENTITY_TYPES[number]

export const DEFAULT_ENTITY_TYPE: EntityType = 'concept'

export interface EntityTypeSpec {
  name: EntityType
  description: string
  examples: string[]
}

export type PredicateTemporalStatus = 'current' | 'former' | 'historical' | 'unknown'

export interface PredicateAliasSpec {
  name: string
  swap?: boolean | undefined
  temporalStatus?: PredicateTemporalStatus | undefined
}

export interface PredicateSpec {
  name: string
  description: string
  category: string
  domain: readonly EntityType[] | readonly ['*']
  range: readonly EntityType[] | readonly ['*']
  aliases?: readonly PredicateAliasSpec[] | undefined
  symmetric?: boolean | undefined
  inverse?: string | undefined
}

export interface PredicateNormalization {
  original: string
  predicate: string
  valid: boolean
  swapSubjectObject: boolean
  symmetric: boolean
  temporalStatus?: PredicateTemporalStatus | undefined
}

export interface PredicateTypeValidation {
  valid: boolean
  domainValid: boolean
  rangeValid: boolean
  reason?: string | undefined
}

const ALL_TYPES = ['*'] as const

export const ENTITY_TYPE_SPECS: readonly EntityTypeSpec[] = [
  { name: 'person', description: 'A specific individual or named human persona.', examples: ['Ada Lovelace', 'Pat Smith'] },
  { name: 'organization', description: 'A company, institution, agency, team, department, or formal group.', examples: ['OpenAI', 'Platform team'] },
  { name: 'location', description: 'A place, region, address, market, or jurisdiction.', examples: ['San Francisco', 'European Union'] },
  { name: 'product', description: 'A commercial product, service, package, SKU, or productized capability.', examples: ['Stripe Billing', 'iPhone 16'] },
  { name: 'technology', description: 'A technical system, framework, language, protocol, platform, or standard.', examples: ['PostgreSQL', 'React Native'] },
  { name: 'concept', description: 'A named idea, method, topic, category, metric, goal, or abstract domain object.', examples: ['retention', 'zero trust'] },
  { name: 'event', description: 'A named occurrence with a time anchor.', examples: ['CES 2025', 'Q4 launch'] },
  { name: 'meeting', description: 'A call, demo, sync, review, interview, or transcript-backed event.', examples: ['weekly pipeline review', 'Acme demo'] },
  { name: 'artifact', description: 'An authored business material distinct from TypeGraph storage documents.', examples: ['RFP', 'contract', 'architecture spec'] },
  { name: 'project', description: 'A bounded initiative, deal, opportunity, migration, program, or body of work.', examples: ['SOC2 rollout', 'Acme renewal'] },
  { name: 'issue', description: 'A ticket, bug, request, story, incident, task, or blocker.', examples: ['AUTH-123', 'billing bug'] },
  { name: 'role', description: 'A title, job, office, function, responsibility, or persona.', examples: ['CTO', 'account owner'] },
  { name: 'law_regulation', description: 'A statute, policy, regulation, contract clause, or formal rule.', examples: ['GDPR', 'SOC2 policy'] },
  { name: 'time_period', description: 'A named period, fiscal window, era, version interval, or date range.', examples: ['Q1 2026', 'Series B stage'] },
  { name: 'creative_work', description: 'A genuinely creative work such as a novel, poem, song, film, or artwork.', examples: ['Maud', 'Frankenstein'] },
]

const person = ['person'] as const
const personOrg = ['organization'] as const
const org = ['organization'] as const
const loc = ['location'] as const
const role = ['role'] as const
const artifact = ['artifact', 'creative_work'] as const
const workObject = ['artifact', 'creative_work', 'product', 'technology', 'concept'] as const
const productTech = ['product', 'technology'] as const
const issueProject = ['issue', 'project'] as const
const eventMeeting = ['event', 'meeting'] as const
const legal = ['law_regulation'] as const

export const PREDICATE_SPECS: readonly PredicateSpec[] = [
  // Core / taxonomy
  {
    name: 'IS_A',
    category: 'Core / taxonomy',
    description: 'Classifies an entity as an instance of a role, type, class, or category.',
    domain: ALL_TYPES,
    range: ['concept', 'role'],
    aliases: [
      { name: 'IS_AN' },
      { name: 'TYPE_OF' },
      { name: 'INSTANCE_OF' },
      { name: 'CLASSIFIED_AS' },
      { name: 'WAS_A', temporalStatus: 'former' },
      { name: 'WAS_AN', temporalStatus: 'former' },
    ],
  },
  {
    name: 'PART_OF',
    category: 'Core / taxonomy',
    description: 'Indicates membership in a larger structure or whole.',
    domain: ALL_TYPES,
    range: ALL_TYPES,
    aliases: [{ name: 'WITHIN' }, { name: 'SUBSET_OF' }, { name: 'BELONGS_TO' }],
  },
  {
    name: 'CONTAINS',
    category: 'Core / taxonomy',
    description: 'Indicates that one entity contains, includes, or encompasses another.',
    domain: ALL_TYPES,
    range: ALL_TYPES,
    aliases: [{ name: 'INCLUDES' }, { name: 'ENCOMPASSES' }, { name: 'HAS_COMPONENT' }],
  },
  {
    name: 'EQUIVALENT_TO',
    category: 'Core / taxonomy',
    description: 'Indicates semantic equivalence between distinct entities.',
    domain: ALL_TYPES,
    range: ALL_TYPES,
    symmetric: true,
    aliases: [{ name: 'SAME_AS' }, { name: 'IDENTICAL_TO' }],
  },
  {
    name: 'RELATED_TO',
    category: 'Core / taxonomy',
    description: 'A weak fallback relation for explicit but non-specific relationships.',
    domain: ALL_TYPES,
    range: ALL_TYPES,
    symmetric: true,
    aliases: [{ name: 'ASSOCIATED_WITH' }, { name: 'INVOLVES' }],
  },

  // People, roles, and organizations
  {
    name: 'WORKS_FOR',
    category: 'People / roles / orgs',
    description: 'A person or organization is employed by, contracted with, or attached to an organization.',
    domain: ['person', 'organization'],
    range: personOrg,
    aliases: [
      { name: 'WORKS_AT' },
      { name: 'EMPLOYED_AT' },
      { name: 'EMPLOYED_BY' },
      { name: 'WORKED_FOR', temporalStatus: 'former' },
      { name: 'WORKED_AT', temporalStatus: 'former' },
      { name: 'WAS_EMPLOYED_BY', temporalStatus: 'former' },
    ],
  },
  {
    name: 'WORKS_AS',
    category: 'People / roles / orgs',
    description: 'An entity serves in a title, job, function, or responsibility.',
    domain: ['person', 'organization'],
    range: role,
    aliases: [
      { name: 'JOB_IS' },
      { name: 'OCCUPATION_IS' },
      { name: 'ROLE_IS' },
      { name: 'TITLE_IS' },
      { name: 'WORKS_IN_ROLE' },
      { name: 'WORKS_AS_A' },
      { name: 'HELD_ROLE', temporalStatus: 'former' },
      { name: 'HELD_POSITION', temporalStatus: 'former' },
      { name: 'SERVED_AS' },
      { name: 'SERVES_AS' },
      { name: 'PRACTICED_AS' },
      { name: 'WORKED_AS', temporalStatus: 'former' },
      { name: 'WORKED_AS_A', temporalStatus: 'former' },
    ],
  },
  { name: 'REPORTS_TO', category: 'People / roles / orgs', description: 'A person or role reports to another person or role.', domain: ['person', 'role'], range: ['person', 'role'], aliases: [{ name: 'REPORTED_TO' }, { name: 'SUBORDINATE_OF' }, { name: 'UNDER' }] },
  { name: 'MANAGES', category: 'People / roles / orgs', description: 'A person, role, or organization manages another entity.', domain: ['person', 'organization', 'role'], range: ALL_TYPES, aliases: [{ name: 'SUPERVISES' }, { name: 'SUPERVISED' }, { name: 'MANAGED' }, { name: 'OVERSEES' }, { name: 'ADMINISTERS' }] },
  { name: 'FOUNDED', category: 'People / roles / orgs', description: 'An entity founded or co-founded an organization, product, project, or initiative.', domain: ['person', 'organization'], range: ['organization', 'product', 'project'], aliases: [{ name: 'ESTABLISHED' }, { name: 'CO_FOUNDED' }, { name: 'COFOUNDED' }, { name: 'FOUNDED_BY', swap: true }, { name: 'CO_FOUNDED_BY', swap: true }, { name: 'COFOUNDED_BY', swap: true }] },
  { name: 'LEADS', category: 'People / roles / orgs', description: 'A person, role, or organization leads another entity.', domain: ['person', 'organization', 'role'], range: ALL_TYPES, aliases: [{ name: 'HEADS' }, { name: 'DIRECTS' }, { name: 'CHAIRS' }, { name: 'LED', temporalStatus: 'former' }, { name: 'HEADED', temporalStatus: 'former' }, { name: 'CHAIRED', temporalStatus: 'former' }] },
  { name: 'ADVISES', category: 'People / roles / orgs', description: 'A person or organization advises another person, organization, or project.', domain: ['person', 'organization'], range: ALL_TYPES, aliases: [{ name: 'CONSULTS_FOR' }, { name: 'ADVISED', temporalStatus: 'former' }, { name: 'CONSULTED_FOR', temporalStatus: 'former' }] },
  { name: 'MEMBER_OF', category: 'People / roles / orgs', description: 'A person or organization is a member of a group or organization.', domain: ['person', 'organization'], range: ['organization'], aliases: [{ name: 'AFFILIATED_WITH' }, { name: 'JOINED' }] },
  { name: 'REPRESENTS', category: 'People / roles / orgs', description: 'A person or organization represents another entity.', domain: ['person', 'organization'], range: ALL_TYPES, aliases: [{ name: 'REPRESENTATIVE_OF' }, { name: 'SPEAKS_FOR' }, { name: 'REPRESENTED_BY', swap: true }] },
  { name: 'INVESTED_IN', category: 'People / roles / orgs', description: 'A person or organization invested in another entity.', domain: ['person', 'organization'], range: ['organization', 'product', 'project'], aliases: [{ name: 'INVESTOR_IN' }, { name: 'BACKED' }] },
  { name: 'MARRIED', category: 'People / personal', description: 'Two people are or were spouses.', domain: person, range: person, symmetric: true, aliases: [{ name: 'MARRIED_TO' }, { name: 'WED' }, { name: 'SPOUSE_OF' }, { name: 'HUSBAND_OF' }, { name: 'WIFE_OF' }] },
  { name: 'DIVORCED', category: 'People / personal', description: 'Two people divorced or separated.', domain: person, range: person, symmetric: true, aliases: [{ name: 'DIVORCED_FROM' }, { name: 'SEPARATED_FROM' }] },
  { name: 'PARENT_OF', category: 'People / personal', description: 'A person is a parent of another person.', domain: person, range: person, aliases: [{ name: 'FATHER_OF' }, { name: 'MOTHER_OF' }] },
  { name: 'CHILD_OF', category: 'People / personal', description: 'A person is a child of another person.', domain: person, range: person, aliases: [{ name: 'SON_OF' }, { name: 'DAUGHTER_OF' }, { name: 'OFFSPRING_OF' }, { name: 'BORN_TO' }] },
  { name: 'SIBLING_OF', category: 'People / personal', description: 'Two people are siblings.', domain: person, range: person, symmetric: true, aliases: [{ name: 'BROTHER_OF' }, { name: 'SISTER_OF' }] },
  { name: 'MENTORED', category: 'People / personal', description: 'A person mentored, trained, or coached another person.', domain: person, range: person, aliases: [{ name: 'TRAINED' }, { name: 'COACHED' }, { name: 'MENTORED_BY', swap: true }, { name: 'TRAINED_BY', swap: true }, { name: 'COACHED_BY', swap: true }] },

  // Business / organization
  { name: 'ACQUIRED', category: 'Business / organization', description: 'An organization acquired another organization or asset.', domain: org, range: ALL_TYPES, aliases: [{ name: 'BOUGHT' }, { name: 'PURCHASED' }, { name: 'ACQUIRED_BY', swap: true }] },
  { name: 'MERGED_WITH', category: 'Business / organization', description: 'Two organizations or projects merged.', domain: ['organization', 'project'], range: ['organization', 'project'], symmetric: true, aliases: [{ name: 'MERGED_INTO' }] },
  { name: 'PARTNERED_WITH', category: 'Business / organization', description: 'Two entities partnered or collaborated.', domain: ALL_TYPES, range: ALL_TYPES, symmetric: true, aliases: [{ name: 'PARTNER_OF' }, { name: 'IN_PARTNERSHIP_WITH' }, { name: 'COLLABORATED_WITH' }, { name: 'WORKED_WITH' }] },
  { name: 'COMPETES_WITH', category: 'Business / organization', description: 'Two entities compete or rival each other.', domain: ALL_TYPES, range: ALL_TYPES, symmetric: true, aliases: [{ name: 'COMPETITOR_OF' }, { name: 'RIVALS' }, { name: 'RIVALED' }] },
  { name: 'FUNDED', category: 'Business / organization', description: 'An entity funded or financed another entity.', domain: ['person', 'organization'], range: ALL_TYPES, aliases: [{ name: 'FINANCED' }, { name: 'SUBSIDIZED' }, { name: 'FUNDED_BY', swap: true }, { name: 'FINANCED_BY', swap: true }] },
  { name: 'SUPPLIED', category: 'Business / organization', description: 'An entity supplied another entity or acted as a vendor.', domain: ['organization', 'person'], range: ALL_TYPES, aliases: [{ name: 'SUPPLIER_TO' }, { name: 'VENDOR_OF' }, { name: 'SUPPLIED_BY', swap: true }] },
  { name: 'SUED', category: 'Business / organization', description: 'An entity sued or litigated against another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'LITIGATED_AGAINST' }, { name: 'SUED_BY', swap: true }] },
  { name: 'REGULATED_BY', category: 'Business / organization', description: 'An entity is regulated or overseen by another entity.', domain: ALL_TYPES, range: ['organization', 'law_regulation'], aliases: [{ name: 'OVERSEEN_BY' }, { name: 'REGULATES', swap: true }] },
  { name: 'OWNS', category: 'Business / organization', description: 'An entity owns another entity or asset.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'OWNER_OF' }, { name: 'POSSESSES' }, { name: 'OWNED_BY', swap: true }, { name: 'PROPERTY_OF', swap: true }] },

  // Product / technical
  { name: 'USES', category: 'Product / technical', description: 'An entity uses a product, technology, vendor, or process.', domain: ALL_TYPES, range: ['product', 'technology', 'organization', 'concept'], aliases: [{ name: 'USES_VENDOR' }, { name: 'USES_TOOL' }, { name: 'USED_IN', swap: true }, { name: 'UTILIZED_IN', swap: true }] },
  { name: 'IMPLEMENTS', category: 'Product / technical', description: 'A technology, product, or project implements another technology or concept.', domain: ['product', 'technology', 'project'], range: ['technology', 'concept', 'law_regulation'], aliases: [{ name: 'REALIZES' }, { name: 'IMPLEMENTED_BY', swap: true }] },
  { name: 'INTEGRATES_WITH', category: 'Product / technical', description: 'Two products or technologies integrate or interoperate.', domain: productTech, range: productTech, symmetric: true, aliases: [{ name: 'INTEGRATED_WITH' }, { name: 'INTEROPERATES_WITH' }] },
  { name: 'REQUIRES', category: 'Product / technical', description: 'An entity requires or depends on another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'DEPENDS_ON' }, { name: 'NEEDS' }, { name: 'REQUIRED_BY', swap: true }] },
  { name: 'COMPATIBLE_WITH', category: 'Product / technical', description: 'Two products or technologies are compatible.', domain: productTech, range: productTech, symmetric: true, aliases: [{ name: 'WORKS_WITH' }, { name: 'INTEROPERABLE_WITH' }] },
  { name: 'MIGRATED_FROM', category: 'Product / technical', description: 'An entity migrated from another product, technology, or system.', domain: ALL_TYPES, range: productTech, aliases: [{ name: 'MOVED_FROM' }] },
  { name: 'DEPLOYED_AT', category: 'Product / technical', description: 'A product, technology, or project is deployed at an organization or location.', domain: ['product', 'technology', 'project'], range: ['organization', 'location'], aliases: [{ name: 'RUNS_AT' }, { name: 'HOSTED_AT' }] },
  { name: 'REPLACES', category: 'Product / technical', description: 'An entity replaces or supersedes another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'SUPERSEDES' }, { name: 'REPLACED_BY', swap: true }, { name: 'DEPRECATED_BY', swap: true }, { name: 'OBSOLETED_BY', swap: true }] },
  { name: 'BASED_ON', category: 'Product / technical', description: 'An entity is based on or derives from another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'DERIVES_FROM' }, { name: 'DERIVED_FROM' }, { name: 'ORIGINATES_FROM' }] },

  // Work / project / issue / artifact
  { name: 'ASSIGNED_TO', category: 'Work / issue / artifact', description: 'A project, issue, task, account, or artifact is assigned to an owner.', domain: issueProject, range: ['person', 'organization', 'role'], aliases: [{ name: 'OWNER_ASSIGNED' }, { name: 'CLOSED_BY' }, { name: 'REPORTED_BY', swap: true }] },
  { name: 'BLOCKS', category: 'Work / issue / artifact', description: 'An issue, project, or dependency blocks another work item.', domain: issueProject, range: issueProject, aliases: [{ name: 'BLOCKED_BY', swap: true }] },
  { name: 'DUPLICATES', category: 'Work / issue / artifact', description: 'An issue duplicates another issue.', domain: ['issue'], range: ['issue'], aliases: [{ name: 'DUPLICATE_OF' }] },
  { name: 'RESOLVES', category: 'Work / issue / artifact', description: 'An entity resolves, fixes, or closes an issue or project.', domain: ALL_TYPES, range: issueProject, aliases: [{ name: 'FIXES' }, { name: 'FIXED_IN' }, { name: 'CLOSES' }, { name: 'CLOSED' }, { name: 'RESOLVED_BY', swap: true }] },
  { name: 'CREATED', category: 'Work / issue / artifact', description: 'An entity created, launched, built, announced, or produced another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'BUILT' }, { name: 'DEVELOPED' }, { name: 'LAUNCHED' }, { name: 'ANNOUNCED' }, { name: 'PRODUCED' }, { name: 'MANUFACTURED' }, { name: 'INVENTED' }, { name: 'CREATED_BY', swap: true }] },
  { name: 'AUTHORED', category: 'Work / issue / artifact', description: 'An entity authored, wrote, composed, or published an artifact or creative work.', domain: ['person', 'organization'], range: artifact, aliases: [{ name: 'WROTE' }, { name: 'COMPOSED' }, { name: 'PENNED' }, { name: 'PUBLISHED' }, { name: 'RELEASED' }, { name: 'WRITTEN_BY', swap: true }, { name: 'AUTHORED_BY', swap: true }, { name: 'COMPOSED_BY', swap: true }, { name: 'PUBLISHED_BY', swap: true }] },
  { name: 'SIGNED', category: 'Work / issue / artifact', description: 'An entity signed an artifact, agreement, contract, or policy.', domain: ALL_TYPES, range: ['artifact', 'law_regulation'], aliases: [{ name: 'SIGNED_BY', swap: true }] },
  { name: 'APPROVED', category: 'Work / issue / artifact', description: 'An entity approved an artifact, project, issue, or decision.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'APPROVED_BY', swap: true }] },
  { name: 'REFERENCES', category: 'Work / issue / artifact', description: 'An entity references another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'REFERS_TO' }, { name: 'CITES' }, { name: 'MENTIONS' }] },
  { name: 'DESCRIBES', category: 'Work / issue / artifact', description: 'An artifact, report, or entity describes another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'DESCRIBED' }, { name: 'DEPICTS' }, { name: 'PORTRAYS' }, { name: 'CHARACTERIZES' }, { name: 'REPORTED' }, { name: 'DOCUMENTED' }, { name: 'RECORDED' }] },
  { name: 'SUPPORTS', category: 'Work / issue / artifact', description: 'An entity supports, endorses, or enables another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'SUPPORTED' }, { name: 'ENDORSED' }, { name: 'ENABLES' }, { name: 'FACILITATES' }] },
  { name: 'OPPOSES', category: 'Work / issue / artifact', description: 'An entity opposes, criticizes, challenges, or contradicts another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'OPPOSED' }, { name: 'RESISTED' }, { name: 'CRITICIZED' }, { name: 'CHALLENGED' }, { name: 'CONTRADICTS' }, { name: 'CONFLICTS_WITH' }] },

  // Events, meetings, location, legal
  { name: 'ATTENDED', category: 'Event / meeting / location / legal', description: 'An entity attended an event or meeting.', domain: ALL_TYPES, range: eventMeeting, aliases: [{ name: 'PRESENT_AT' }] },
  { name: 'ORGANIZED', category: 'Event / meeting / location / legal', description: 'An entity organized an event, meeting, project, or activity.', domain: ALL_TYPES, range: ['event', 'meeting', 'project'], aliases: [{ name: 'ARRANGED' }, { name: 'COORDINATED' }] },
  { name: 'SPOKE_AT', category: 'Event / meeting / location / legal', description: 'A person or organization spoke or presented at an event or meeting.', domain: ['person', 'organization'], range: eventMeeting, aliases: [{ name: 'PRESENTED_AT' }, { name: 'ADDRESSED' }] },
  { name: 'OCCURRED_AT', category: 'Event / meeting / location / legal', description: 'An event or meeting occurred at a precise place, venue, or time point.', domain: eventMeeting, range: ['location', 'time_period'], aliases: [{ name: 'TOOK_PLACE_AT' }, { name: 'HAPPENED_AT' }] },
  { name: 'OCCURRED_IN', category: 'Event / meeting / location / legal', description: 'An event or meeting occurred in a broader place, time period, or context.', domain: eventMeeting, range: ['location', 'time_period'], aliases: [{ name: 'TOOK_PLACE_IN' }, { name: 'HAPPENED_IN' }] },
  { name: 'LOCATED_IN', category: 'Event / meeting / location / legal', description: 'An entity is located in a place.', domain: ALL_TYPES, range: loc, aliases: [{ name: 'SITUATED_IN' }, { name: 'LIVES_IN' }, { name: 'RESIDES_IN' }, { name: 'LIVED_IN', temporalStatus: 'former' }, { name: 'RESIDED_IN', temporalStatus: 'former' }, { name: 'BORN_IN' }, { name: 'DIED_IN' }] },
  { name: 'OPERATES_IN', category: 'Event / meeting / location / legal', description: 'An organization, product, or project operates in a market or location.', domain: ['organization', 'product', 'project'], range: loc, aliases: [{ name: 'ACTIVE_IN' }, { name: 'PRESENT_IN' }, { name: 'EXPANDED_TO' }, { name: 'WITHDREW_FROM', temporalStatus: 'former' }] },
  { name: 'HEADQUARTERED_IN', category: 'Event / meeting / location / legal', description: 'An organization is headquartered or based in a location.', domain: org, range: loc, aliases: [{ name: 'BASED_IN' }, { name: 'HQ_IN' }] },
  { name: 'GOVERNS', category: 'Event / meeting / location / legal', description: 'A law, regulation, policy, or organization governs an entity.', domain: ['law_regulation', 'organization'], range: ALL_TYPES, aliases: [{ name: 'CONTROLS' }] },
  { name: 'PROHIBITS', category: 'Event / meeting / location / legal', description: 'A law, regulation, policy, or rule prohibits something.', domain: legal, range: ALL_TYPES, aliases: [{ name: 'BANS' }, { name: 'FORBIDS' }] },
  { name: 'PERMITS', category: 'Event / meeting / location / legal', description: 'A law, regulation, policy, or rule permits something.', domain: legal, range: ALL_TYPES, aliases: [{ name: 'ALLOWS' }, { name: 'AUTHORIZES' }] },
  { name: 'AMENDS', category: 'Event / meeting / location / legal', description: 'A law, regulation, policy, or artifact amends another law, regulation, policy, or artifact.', domain: ['law_regulation', 'artifact'], range: ['law_regulation', 'artifact'], aliases: [{ name: 'AMENDED' }, { name: 'AMENDED_BY', swap: true }, { name: 'MODIFIED_BY', swap: true }, { name: 'REVISED_BY', swap: true }] },
  { name: 'REPEALS', category: 'Event / meeting / location / legal', description: 'A law, regulation, policy, or rule repeals another law, regulation, policy, or rule.', domain: legal, range: legal, aliases: [{ name: 'REPEALED' }, { name: 'REVOKED' }, { name: 'ANNULLED' }, { name: 'RESCINDED' }] },
  { name: 'CAUSED', category: 'Event / meeting / location / legal', description: 'An entity caused or triggered another entity or outcome.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'TRIGGERED' }, { name: 'RESULTED_IN' }, { name: 'LED_TO' }] },
  { name: 'PRECEDED', category: 'Event / meeting / location / legal', description: 'An entity came before another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'CAME_BEFORE' }, { name: 'PRIOR_TO' }, { name: 'SUCCEEDED_BY', swap: true }] },
  { name: 'FOLLOWED', category: 'Event / meeting / location / legal', description: 'An entity came after another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'CAME_AFTER' }, { name: 'SUCCEEDED' }] },

  // Historical / narrative
  { name: 'KILLED', category: 'Historical / narrative', description: 'A person or entity killed another person or entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'MURDERED' }, { name: 'ASSASSINATED' }, { name: 'SLAIN_BY', swap: true }, { name: 'KILLED_BY', swap: true }, { name: 'MURDERED_BY', swap: true }, { name: 'ASSASSINATED_BY', swap: true }] },
  { name: 'BETRAYED', category: 'Historical / narrative', description: 'An entity betrayed another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'DECEIVED' }, { name: 'BETRAYED_BY', swap: true }] },
  { name: 'RESCUED', category: 'Historical / narrative', description: 'An entity rescued, saved, or liberated another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'SAVED' }, { name: 'LIBERATED' }, { name: 'RESCUED_BY', swap: true }] },
  { name: 'EXILED_TO', category: 'Historical / narrative', description: 'A person or group was exiled, banished, or deported to a location.', domain: ALL_TYPES, range: loc, aliases: [{ name: 'BANISHED_TO' }, { name: 'DEPORTED_TO' }] },
  { name: 'RULED', category: 'Historical / narrative', description: 'A person or organization ruled or governed a location, organization, or group.', domain: ['person', 'organization'], range: ALL_TYPES, aliases: [{ name: 'GOVERNED' }, { name: 'REIGNED_OVER' }, { name: 'CONTROLLED' }] },
  { name: 'CONQUERED', category: 'Historical / narrative', description: 'An entity conquered, captured, or seized another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'CAPTURED' }, { name: 'SEIZED' }] },
  { name: 'IMPRISONED_IN', category: 'Historical / narrative', description: 'A person or group was imprisoned, jailed, or detained in a location.', domain: ALL_TYPES, range: loc, aliases: [{ name: 'JAILED_IN' }, { name: 'DETAINED_IN' }, { name: 'HELD_IN' }] },
  { name: 'FOUGHT_IN', category: 'Historical / narrative', description: 'An entity fought, served, or battled in an event or conflict.', domain: ALL_TYPES, range: eventMeeting, aliases: [{ name: 'SERVED_IN' }, { name: 'BATTLED_IN' }] },
]

export const VALID_ENTITY_TYPES = new Set<string>(ENTITY_TYPES)
export const ENTITY_TYPES_LIST = ENTITY_TYPES.join(', ')
export const ALL_PREDICATES = new Set(PREDICATE_SPECS.map(spec => spec.name))
export const PREDICATE_BY_NAME = new Map(PREDICATE_SPECS.map(spec => [spec.name, spec]))
export const SYMMETRIC_PREDICATES = new Set(PREDICATE_SPECS.filter(spec => spec.symmetric).map(spec => spec.name))

export const GENERIC_DISALLOWED_PREDICATES = new Set([
  'IS',
  'HAS',
  'HAS_A',
  'MENTIONED',
])

export const ALIAS_RELATION_CUES = new Set([
  'KNOWN_AS',
  'ALSO_CALLED',
  'ALIAS',
  'ALIAS_OF',
  'AKA',
  'CALLED',
  'NAMED_AFTER',
  'NAMED_FOR',
])

export const ALIAS_ASSIGNMENT_CUES = new Set([
  'KNOWN_AS',
  'ALSO_CALLED',
  'ALIAS',
  'ALIAS_OF',
  'AKA',
  'CALLED',
])

const PREDICATE_ALIAS_BY_NAME = buildPredicateAliasMap()

function buildPredicateAliasMap(): Map<string, { canonical: string; alias: PredicateAliasSpec }> {
  const map = new Map<string, { canonical: string; alias: PredicateAliasSpec }>()
  for (const spec of PREDICATE_SPECS) {
    map.set(sanitizePredicate(spec.name), { canonical: spec.name, alias: { name: spec.name } })
    for (const alias of spec.aliases ?? []) {
      const key = sanitizePredicate(alias.name)
      if (key === spec.name && alias.swap) {
        throw new Error(`Ontology alias ${alias.name} cannot self-map with swap`)
      }
      map.set(key, { canonical: spec.name, alias })
    }
  }
  return map
}

export function sanitizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
}

export function isSymmetricPredicate(predicate: string): boolean {
  return SYMMETRIC_PREDICATES.has(sanitizePredicate(predicate))
}

export function normalizePredicateWithDirection(predicate: string): PredicateNormalization {
  const original = sanitizePredicate(predicate)
  if (ALIAS_RELATION_CUES.has(original)) {
    return {
      original,
      predicate: original,
      valid: false,
      swapSubjectObject: false,
      symmetric: false,
    }
  }

  const resolved = PREDICATE_ALIAS_BY_NAME.get(original)
  const normalized = resolved?.canonical ?? original
  const valid = ALL_PREDICATES.has(normalized) && !GENERIC_DISALLOWED_PREDICATES.has(normalized)
  return {
    original,
    predicate: normalized,
    valid,
    swapSubjectObject: !!resolved?.alias.swap,
    symmetric: isSymmetricPredicate(normalized),
    ...(resolved?.alias.temporalStatus ? { temporalStatus: resolved.alias.temporalStatus } : {}),
  }
}

export function validatePredicateTypes(
  predicate: string,
  subjectType?: string | undefined,
  objectType?: string | undefined,
): PredicateTypeValidation {
  const normalized = normalizePredicateWithDirection(predicate)
  if (!normalized.valid) {
    return {
      valid: false,
      domainValid: false,
      rangeValid: false,
      reason: 'invalid-predicate',
    }
  }
  const spec = PREDICATE_BY_NAME.get(normalized.predicate)
  if (!spec) {
    return {
      valid: false,
      domainValid: false,
      rangeValid: false,
      reason: 'missing-predicate-spec',
    }
  }
  const domainValid = typeAllowed(spec.domain, subjectType)
  const rangeValid = typeAllowed(spec.range, objectType)
  return {
    valid: domainValid && rangeValid,
    domainValid,
    rangeValid,
    ...(!domainValid || !rangeValid ? { reason: 'domain-range-mismatch' } : {}),
  }
}

function typeAllowed(allowed: readonly EntityType[] | readonly ['*'], type?: string | undefined): boolean {
  if ((allowed as readonly string[]).includes('*')) return true
  if (!type) return true
  return (allowed as readonly string[]).includes(type)
}

/**
 * Get canonical predicates formatted for extraction and intent prompts.
 * Synonyms are intentionally omitted so the model emits a compact vocabulary.
 */
export function getPredicatesForPrompt(): string {
  const byCategory = new Map<string, PredicateSpec[]>()
  for (const spec of PREDICATE_SPECS) {
    const list = byCategory.get(spec.category) ?? []
    list.push(spec)
    byCategory.set(spec.category, list)
  }

  const lines = [...byCategory.entries()].map(([category, specs]) =>
    `${category}: ${specs.map(spec => spec.name).join(', ')}`
  )

  return `Predicate vocabulary (choose from this canonical list when applicable):

${lines.join('\n')}

Use ONLY predicates from this vocabulary. Do not invent new predicate names. Use aliases only to understand source phrasing, not as output predicate names.`
}
