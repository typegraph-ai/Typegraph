/**
 * Central ontology registry for graph extraction, predicate normalization,
 * query-intent parsing, and graph write validation.
 *
 * Keep entity types, canonical predicates, aliases, inverse direction, symmetry,
 * prompt grouping, and soft domain/range metadata here. Other modules should
 * import the derived helpers instead of maintaining their own predicate lists.
 */

import type {
  CompiledOntology,
  OntologyConfig,
  OntologyEntityConfig,
  OntologyProfile,
  OntologyPromptConfig,
  OntologyRelationConfig,
  OntologyResolutionConfig,
  OntologyVocabularyRef,
} from '../types/ontology.js'
import { TYPEGRAPH_B2B_SAAS_ONTOLOGY } from './saas-ontology.js'

export const ENTITY_TYPES = [
  'person',
  'organization',
  'location',
  'place',
  'building',
  'character',
  'artifact',
  'product',
  'technology',
  'concept',
  'event',
  'meeting',
  'document',
  'project',
  'issue',
  'role',
  'law_regulation',
  'time_period',
  'creative_work',
  'publication',
  'condition',
  'symptom',
  'medication',
  'procedure',
  'test',
  'anatomy',
  'guideline',
  'recommendation',
  'party',
  'court',
  'jurisdiction',
  'statute',
  'regulation',
  'case',
  'contract',
  'clause',
  'obligation',
  'permission',
  'prohibition',
  'account',
  'feature',
  'ticket',
  'metric',
  'integration',
  'vendor',
] as const

export type EntityType = typeof ENTITY_TYPES[number]

export const DEFAULT_ENTITY_TYPE: EntityType = 'concept'

export interface EntityTypeSpec {
  name: string
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
  domain: readonly string[] | readonly ['*']
  range: readonly string[] | readonly ['*']
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

export interface TypeCandidate {
  type: string
  confidence: number
}

const ALL_TYPES = ['*'] as const

export const ENTITY_TYPE_SPECS: readonly EntityTypeSpec[] = [
  { name: 'person', description: 'A specific named human individual.', examples: ['Ada Lovelace', 'Pat Smith'] },
  { name: 'organization', description: 'A company, institution, agency, team, department, or formal group.', examples: ['OpenAI', 'Platform team'] },
  { name: 'location', description: 'A place, region, address, market, or jurisdiction.', examples: ['San Francisco', 'European Union'] },
  { name: 'product', description: 'A commercial product, service, package, SKU, or productized capability.', examples: ['Stripe Billing', 'iPhone 16'] },
  { name: 'technology', description: 'A technical system, framework, language, protocol, platform, or standard.', examples: ['PostgreSQL', 'React Native'] },
  { name: 'concept', description: 'A named idea, method, topic, category, metric, goal, or abstract domain object.', examples: ['Data retention', 'Zero trust'] },
  { name: 'event', description: 'A named occurrence with a time anchor.', examples: ['CES 2025', 'Q4 launch'] },
  { name: 'meeting', description: 'A call, demo, sync, review, interview, or transcript-backed event.', examples: ['weekly pipeline review', 'Acme demo'] },
  { name: 'document', description: 'An authored business material distinct from TypeGraph storage sources.', examples: ['RFP', 'contract', 'architecture spec'] },
  { name: 'project', description: 'A bounded initiative, deal, opportunity, migration, program, or body of work.', examples: ['SOC2 rollout', 'Acme renewal'] },
  { name: 'issue', description: 'A ticket, bug, request, story, incident, task, or blocker.', examples: ['AUTH-123', 'billing bug'] },
  { name: 'role', description: 'An abstract title, job, office, function, responsibility, audience, or stakeholder role.', examples: ['CTO', 'account owner'] },
  { name: 'law_regulation', description: 'A statute, policy, regulation, contract clause, or formal rule.', examples: ['GDPR', 'SOC2 policy'] },
  { name: 'time_period', description: 'A named period, fiscal window, era, version interval, or date range.', examples: ['Q1 2026', 'Series B stage'] },
  { name: 'creative_work', description: 'A standalone named artistic or intellectual work such as a novel, play, poem, song, film, artwork, essay, sermon, or titled collection.', examples: ['Fear and Loathing in Las Vegas', 'Moby Dick'] },
  { name: 'publication', description: 'A recurring or periodical published source such as a journal, newspaper, magazine, review, almanac, gazette, or periodical series.', examples: ['London Magazine', 'Berlinische Monatsschrift'] },
  { name: 'place', description: 'A named place, region, settlement, landmark, or setting.', examples: ['Cairo, Egypt', 'Meryton'] },
  { name: 'building', description: 'A named building, venue, estate, house, institution, or physical structure.', examples: ['Netherfield Park', 'the Governor’s house'] },
  { name: 'character', description: 'A named fictional or narrative character.', examples: ['Elizabeth Bennet', 'Sherlock Holmes'] },
  { name: 'artifact', description: 'A named object, artifact, vehicle, weapon, artwork, or physical item.', examples: ['the One Ring', 'HMS Beagle'] },
  { name: 'condition', description: 'A disease, disorder, syndrome, diagnosis, or clinical condition.', examples: ['breast cancer', 'hypertension'] },
  { name: 'symptom', description: 'A symptom, clinical sign, side effect, or presentation.', examples: ['fever', 'shortness of breath'] },
  { name: 'medication', description: 'A drug, biologic, therapy, vaccine, or named medication class.', examples: ['pembrolizumab', 'metformin'] },
  { name: 'procedure', description: 'A medical, surgical, diagnostic, or operational procedure.', examples: ['mastectomy', 'MRI'] },
  { name: 'test', description: 'A clinical test, lab, imaging study, score, or assay.', examples: ['HER2 test', 'complete blood count'] },
  { name: 'anatomy', description: 'A named body part, organ system, tissue, or anatomical structure.', examples: ['lung', 'left ventricle'] },
  { name: 'guideline', description: 'A clinical, legal, policy, or operational guideline.', examples: ['NCCN Breast Cancer Guidelines'] },
  { name: 'recommendation', description: 'A formal recommendation, requirement, instruction, or best-practice statement.', examples: ['annual screening recommendation'] },
  { name: 'party', description: 'A legal, contractual, or business party.', examples: ['licensor', 'customer'] },
  { name: 'court', description: 'A court, tribunal, judge panel, or adjudicating body.', examples: ['Supreme Court of Canada'] },
  { name: 'jurisdiction', description: 'A legal jurisdiction, territory, court system, or regulatory domain.', examples: ['California', 'European Union'] },
  { name: 'statute', description: 'A statute, act, code section, or legislative instrument.', examples: ['Clean Air Act'] },
  { name: 'regulation', description: 'A regulation, rule, standard, or administrative requirement.', examples: ['GDPR Article 6'] },
  { name: 'case', description: 'A legal case, matter, dispute, proceeding, or claim.', examples: ['Roe v. Wade'] },
  { name: 'contract', description: 'A contract, agreement, order form, license, or legal instrument.', examples: ['master services agreement'] },
  { name: 'clause', description: 'A clause, section, article, exhibit, or provision in a formal document.', examples: ['limitation of liability'] },
  { name: 'obligation', description: 'A required duty, covenant, or responsibility.', examples: ['payment obligation'] },
  { name: 'permission', description: 'A permitted right, authorization, license, or entitlement.', examples: ['redistribution right'] },
  { name: 'prohibition', description: 'A ban, restriction, exclusion, or forbidden action.', examples: ['reverse engineering restriction'] },
  { name: 'account', description: 'A customer account, workspace, tenant, opportunity, or CRM account.', examples: ['Acme account'] },
  { name: 'feature', description: 'A product feature, capability, module, or workflow.', examples: ['SSO', 'audit logs'] },
  { name: 'ticket', description: 'A support ticket, issue, bug, request, incident, or case.', examples: ['AUTH-123'] },
  { name: 'metric', description: 'A named business, product, or operational metric.', examples: ['ARR', 'churn rate'] },
  { name: 'integration', description: 'A named product integration, connector, webhook, or interoperability path.', examples: ['Okta SSO integration'] },
  { name: 'vendor', description: 'A vendor, supplier, partner, or third-party system.', examples: ['Salesforce', 'Okta'] },
]

const person = ['person', 'character'] as const
const personOrg = ['organization'] as const
const org = ['organization', 'vendor'] as const
const loc = ['location', 'place', 'building', 'jurisdiction'] as const
const role = ['role'] as const
const authoredWork = ['document', 'creative_work', 'publication', 'contract', 'guideline'] as const
const publishedWork = ['document', 'creative_work'] as const
const publishedContainer = ['publication', 'document', 'creative_work'] as const
const appearsInSubject = ['character'] as const
const appearsInContainer = ['creative_work', 'publication'] as const
const workObject = ['document', 'creative_work', 'publication', 'contract', 'guideline', 'product', 'technology', 'concept'] as const
const productTech = ['product', 'technology', 'feature', 'integration'] as const
const issueProject = ['issue', 'ticket', 'project'] as const
const eventMeeting = ['event', 'meeting'] as const
const legal = ['law_regulation', 'statute', 'regulation', 'contract', 'clause', 'obligation', 'permission', 'prohibition'] as const

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
      { name: 'EMPLOYED_AS' },
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

  // Work / project / issue / document
  { name: 'ASSIGNED_TO', category: 'Work / issue / document', description: 'A project, issue, task, account, or document is assigned to an owner.', domain: issueProject, range: ['person', 'organization', 'role'], aliases: [{ name: 'OWNER_ASSIGNED' }, { name: 'CLOSED_BY' }, { name: 'REPORTED_BY', swap: true }] },
  { name: 'BLOCKS', category: 'Work / issue / document', description: 'An issue, project, or dependency blocks another work item.', domain: issueProject, range: issueProject, aliases: [{ name: 'BLOCKED_BY', swap: true }] },
  { name: 'DUPLICATES', category: 'Work / issue / document', description: 'An issue duplicates another issue.', domain: ['issue'], range: ['issue'], aliases: [{ name: 'DUPLICATE_OF' }] },
  { name: 'RESOLVES', category: 'Work / issue / document', description: 'An entity resolves, fixes, or closes an issue or project.', domain: ALL_TYPES, range: issueProject, aliases: [{ name: 'FIXES' }, { name: 'FIXED_IN' }, { name: 'CLOSES' }, { name: 'CLOSED' }, { name: 'RESOLVED_BY', swap: true }] },
  { name: 'CREATED', category: 'Work / issue / document', description: 'An entity created, launched, built, announced, or produced another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'BUILT' }, { name: 'DEVELOPED' }, { name: 'LAUNCHED' }, { name: 'ANNOUNCED' }, { name: 'PRODUCED' }, { name: 'MANUFACTURED' }, { name: 'INVENTED' }, { name: 'CREATED_BY', swap: true }] },
  { name: 'AUTHORED', category: 'Work / issue / document', description: 'An entity authored, wrote, composed, or created a document, creative work, or publication.', domain: ['person', 'organization'], range: authoredWork, aliases: [{ name: 'WROTE' }, { name: 'COMPOSED' }, { name: 'PENNED' }, { name: 'RELEASED' }, { name: 'WRITTEN_BY', swap: true }, { name: 'AUTHORED_BY', swap: true }, { name: 'COMPOSED_BY', swap: true }] },
  { name: 'PUBLISHED_IN', category: 'Work / issue / document', description: 'A document or creative work was published, printed, or appeared in a publication, document, or larger work.', domain: publishedWork, range: publishedContainer, aliases: [{ name: 'APPEARED_IN' }, { name: 'PRINTED_IN' }, { name: 'PUBLISHED_IN' }] },
  { name: 'SIGNED', category: 'Work / issue / document', description: 'An entity signed a document, agreement, contract, or policy.', domain: ALL_TYPES, range: ['document', 'law_regulation'], aliases: [{ name: 'SIGNED_BY', swap: true }] },
  { name: 'APPROVED', category: 'Work / issue / document', description: 'An entity approved a document, project, issue, or decision.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'APPROVED_BY', swap: true }] },
  { name: 'REFERENCES', category: 'Work / issue / document', description: 'An entity references another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'REFERS_TO' }, { name: 'CITES' }, { name: 'MENTIONS' }] },
  { name: 'DESCRIBES', category: 'Work / issue / document', description: 'A document, report, or entity describes another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'DESCRIBED' }, { name: 'DEPICTS' }, { name: 'PORTRAYS' }, { name: 'CHARACTERIZES' }, { name: 'REPORTED' }, { name: 'DOCUMENTED' }, { name: 'RECORDED' }] },
  { name: 'SUPPORTS', category: 'Work / issue / document', description: 'An entity supports, endorses, or enables another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'SUPPORTED' }, { name: 'ENDORSED' }, { name: 'ENABLES' }, { name: 'FACILITATES' }] },
  { name: 'OPPOSES', category: 'Work / issue / document', description: 'An entity opposes, criticizes, challenges, or contradicts another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'OPPOSED' }, { name: 'RESISTED' }, { name: 'CRITICIZED' }, { name: 'CHALLENGED' }, { name: 'CONTRADICTS' }, { name: 'CONFLICTS_WITH' }] },

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
  { name: 'AMENDS', category: 'Event / meeting / location / legal', description: 'A law, regulation, policy, or document amends another law, regulation, policy, or document.', domain: ['law_regulation', 'document'], range: ['law_regulation', 'document'], aliases: [{ name: 'AMENDED' }, { name: 'AMENDED_BY', swap: true }, { name: 'MODIFIED_BY', swap: true }, { name: 'REVISED_BY', swap: true }] },
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
  { name: 'CONFLICT_WITH', category: 'Historical / narrative', description: 'Two entities are in war, rivalry, conflict, opposition, or hostility.', domain: ALL_TYPES, range: ALL_TYPES, symmetric: true, aliases: [{ name: 'AT_WAR_WITH' }, { name: 'WAGED_WAR_AGAINST' }, { name: 'FOUGHT_AGAINST' }, { name: 'IN_CONFLICT_WITH' }] },
  { name: 'APPEARS_IN', category: 'Historical / narrative', description: 'A fictional or narrative character meaningfully appears in a named creative work or publication.', domain: appearsInSubject, range: appearsInContainer, aliases: [{ name: 'FEATURED_IN' }] },
  { name: 'LIVES_AT', category: 'Historical / narrative', description: 'A person or character lives, stays, resides, or is based at a place or building.', domain: person, range: loc, aliases: [{ name: 'RESIDES_AT' }, { name: 'STAYS_AT' }] },
  { name: 'TRADES_THROUGH', category: 'Historical / narrative', description: 'An entity trades, exchanges, imports, exports, or routes goods through a place or entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'TRADES_WITH' }, { name: 'EXPORTS_TO' }, { name: 'IMPORTS_FROM' }] },

  // Medical
  { name: 'TREATS', category: 'Medical', description: 'A medication, procedure, or recommendation treats a condition.', domain: ['medication', 'procedure', 'recommendation'], range: ['condition', 'symptom'], aliases: [{ name: 'USED_TO_TREAT' }, { name: 'THERAPY_FOR' }] },
  { name: 'DIAGNOSED_WITH', category: 'Medical', description: 'A person, patient group, or clinical case is diagnosed with a condition.', domain: ALL_TYPES, range: ['condition'], aliases: [{ name: 'HAS_DIAGNOSIS' }] },
  { name: 'HAS_SYMPTOM', category: 'Medical', description: 'A condition, case, or person has a symptom or clinical finding.', domain: ALL_TYPES, range: ['symptom'], aliases: [{ name: 'PRESENTS_WITH' }] },
  { name: 'INDICATED_FOR', category: 'Medical', description: 'A medication, procedure, test, or recommendation is indicated for a condition or patient group.', domain: ['medication', 'procedure', 'test', 'recommendation'], range: ALL_TYPES, aliases: [{ name: 'RECOMMENDED_FOR' }] },
  { name: 'CONTRAINDICATED_WITH', category: 'Medical', description: 'A medication, procedure, or recommendation should not be used with an entity or condition.', domain: ['medication', 'procedure', 'recommendation'], range: ALL_TYPES, aliases: [{ name: 'AVOID_WITH' }] },
  { name: 'MEASURED_BY', category: 'Medical', description: 'A condition, symptom, metric, or clinical status is measured by a test or assay.', domain: ALL_TYPES, range: ['test', 'metric'], aliases: [{ name: 'ASSESSED_BY' }, { name: 'TESTED_BY' }] },
  { name: 'AFFECTS', category: 'Medical', description: 'An entity affects, impacts, or is associated with another entity.', domain: ALL_TYPES, range: ALL_TYPES, aliases: [{ name: 'IMPACTS' }] },
  { name: 'RECOMMENDS', category: 'Medical', description: 'A guideline, recommendation, law, policy, or organization recommends an action or entity.', domain: ['guideline', 'recommendation', 'organization', 'law_regulation'], range: ALL_TYPES, aliases: [{ name: 'ADVISES_USE_OF' }] },

  // Legal
  { name: 'APPLIES_TO', category: 'Legal', description: 'A law, rule, clause, guideline, or recommendation applies to an entity, party, conduct, or jurisdiction.', domain: legal, range: ALL_TYPES, aliases: [{ name: 'COVERS' }] },
  { name: 'ASSIGNS_OBLIGATION_TO', category: 'Legal', description: 'A contract, clause, regulation, or policy assigns a duty or obligation to a party.', domain: legal, range: ['party', 'person', 'organization'], aliases: [{ name: 'OBLIGATES' }, { name: 'REQUIRES_OF' }] },
  { name: 'HAS_CLAUSE', category: 'Legal', description: 'A contract, statute, or legal document contains a clause or provision.', domain: ['contract', 'document', 'law_regulation', 'statute', 'regulation'], range: ['clause', 'obligation', 'permission', 'prohibition'], aliases: [{ name: 'CONTAINS_CLAUSE' }] },
  { name: 'GRANTS_PERMISSION', category: 'Legal', description: 'A legal instrument grants, licenses, permits, or authorizes a right or permission.', domain: legal, range: ['permission', 'party', 'person', 'organization'], aliases: [{ name: 'LICENSES' }, { name: 'AUTHORIZES' }] },

  // SaaS / customer operations
  { name: 'REQUESTED', category: 'SaaS', description: 'A customer, user, account, organization, or named person requested a feature, support action, or change.', domain: ['account', 'organization', 'person'], range: ['feature', 'ticket', 'project', 'product', 'technology'], aliases: [{ name: 'ASKED_FOR' }] },
  { name: 'REPORTED', category: 'SaaS', description: 'A customer, user, account, organization, or named person reported an issue, ticket, symptom, or event.', domain: ['account', 'organization', 'person'], range: ['ticket', 'issue', 'event'], aliases: [{ name: 'FILED' }] },
  { name: 'RENEWING', category: 'SaaS', description: 'An account, customer, or organization is renewing, expanding, or contracting for a product or service.', domain: ['account', 'organization'], range: ['product', 'project', 'contract'], aliases: [{ name: 'RENEWS' }, { name: 'EXPANDING' }] },
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

const TYPE_AFFINITY_GROUPS: readonly (readonly EntityType[])[] = [
  ['organization', 'product', 'technology', 'vendor', 'account', 'integration', 'feature'],
  ['project', 'issue', 'ticket'],
  ['event', 'meeting'],
  ['document', 'creative_work', 'publication', 'contract', 'guideline', 'case'],
  ['location', 'place', 'building', 'jurisdiction'],
  ['law_regulation', 'statute', 'regulation', 'contract', 'clause', 'obligation', 'permission', 'prohibition'],
  ['condition', 'symptom', 'medication', 'procedure', 'test', 'anatomy', 'guideline', 'recommendation'],
  ['person', 'character'],
]

export const ONTOLOGY_PROFILES = ['general', 'literary', 'medical', 'legal', 'saas'] as const satisfies readonly OntologyProfile[]

function vocab(
  vocabulary: string,
  id: string | undefined,
  label: string,
  uri: string | undefined,
  match: OntologyVocabularyRef['match'] = 'close',
): OntologyVocabularyRef {
  return {
    vocabulary,
    ...(id ? { id } : {}),
    label,
    ...(uri ? { uri } : {}),
    match,
  }
}

export const ONTOLOGY_VOCABULARY_SOURCES = {
  schemaOrg: 'schema.org',
  wikidata: 'Wikidata',
  dbpedia: 'DBpedia Ontology',
  cidocCrm: 'CIDOC CRM',
  bibframe: 'BIBFRAME',
  fhir: 'HL7 FHIR',
  snomedCt: 'SNOMED CT',
  loinc: 'LOINC',
  rxNorm: 'RxNorm',
  mesh: 'MeSH',
  hpo: 'Human Phenotype Ontology',
  mondo: 'Mondo Disease Ontology',
  ncit: 'NCI Thesaurus',
  eli: 'European Legislation Identifier',
  akomaNtoso: 'Akoma Ntoso',
  legalRuleMl: 'LegalRuleML',
  openTelemetry: 'OpenTelemetry Semantic Conventions',
  tmForumSid: 'TM Forum SID',
  itil: 'ITIL',
} as const

export const BUILT_IN_ENTITY_VOCABULARY: Record<string, readonly OntologyVocabularyRef[]> = {
  person: [
    vocab('schema.org', 'Person', 'Person', 'https://schema.org/Person', 'exact'),
    vocab('Wikidata', 'Q5', 'human', 'https://www.wikidata.org/wiki/Q5', 'close'),
  ],
  organization: [
    vocab('schema.org', 'Organization', 'Organization', 'https://schema.org/Organization', 'exact'),
    vocab('Wikidata', 'Q43229', 'organization', 'https://www.wikidata.org/wiki/Q43229', 'close'),
  ],
  location: [
    vocab('schema.org', 'Place', 'Place', 'https://schema.org/Place', 'broad'),
  ],
  place: [
    vocab('schema.org', 'Place', 'Place', 'https://schema.org/Place', 'exact'),
    vocab('Wikidata', 'Q17334923', 'location', 'https://www.wikidata.org/wiki/Q17334923', 'broad'),
  ],
  building: [
    vocab('schema.org', 'Place', 'Place', 'https://schema.org/Place', 'broad'),
    vocab('CIDOC CRM', 'E24', 'Physical Human-Made Thing', 'https://cidoc-crm.org/Entity/e24-physical-human-made-thing/version-7.1.3', 'broad'),
  ],
  product: [
    vocab('schema.org', 'Product', 'Product', 'https://schema.org/Product', 'exact'),
  ],
  technology: [
    vocab('schema.org', 'SoftwareApplication', 'SoftwareApplication', 'https://schema.org/SoftwareApplication', 'close'),
  ],
  event: [
    vocab('schema.org', 'Event', 'Event', 'https://schema.org/Event', 'exact'),
    vocab('CIDOC CRM', 'E5', 'Event', 'https://cidoc-crm.org/Entity/e5-event/version-7.1.3', 'close'),
  ],
  document: [
    vocab('schema.org', 'CreativeWork', 'CreativeWork', 'https://schema.org/CreativeWork', 'broad'),
    vocab('BIBFRAME', 'Work', 'Work', 'https://id.loc.gov/ontologies/bibframe/Work', 'close'),
  ],
  creative_work: [
    vocab('schema.org', 'CreativeWork', 'CreativeWork', 'https://schema.org/CreativeWork', 'exact'),
    vocab('BIBFRAME', 'Work', 'Work', 'https://id.loc.gov/ontologies/bibframe/Work', 'close'),
  ],
  publication: [
    vocab('schema.org', 'Periodical', 'Periodical', 'https://schema.org/Periodical', 'exact'),
    vocab('BIBFRAME', 'Serial', 'Serial', 'https://id.loc.gov/ontologies/bibframe/Serial', 'close'),
    vocab('Wikidata', 'Q1002697', 'periodical literature', 'https://www.wikidata.org/wiki/Q1002697', 'close'),
  ],
  character: [
    vocab('schema.org', 'Person', 'Person', 'https://schema.org/Person', 'close'),
    vocab('CIDOC CRM', 'E21', 'Person', 'https://cidoc-crm.org/Entity/e21-person/version-7.1.3', 'close'),
  ],
  artifact: [
    vocab('CIDOC CRM', 'E22', 'Human-Made Object', 'https://cidoc-crm.org/Entity/e22-human-made-object/version-7.1.3', 'close'),
    vocab('schema.org', 'Thing', 'Thing', 'https://schema.org/Thing', 'broad'),
  ],
  condition: [
    vocab('schema.org', 'MedicalCondition', 'MedicalCondition', 'https://schema.org/MedicalCondition', 'close'),
    vocab('HL7 FHIR', 'Condition', 'Condition resource', 'https://hl7.org/fhir/condition.html', 'close'),
    vocab('SNOMED CT', '64572001', 'Disease', undefined, 'broad'),
    vocab('Mondo Disease Ontology', 'MONDO:0000001', 'disease or disorder', 'https://purl.obolibrary.org/obo/MONDO_0000001', 'broad'),
  ],
  symptom: [
    vocab('SNOMED CT', '404684003', 'Clinical finding', undefined, 'broad'),
    vocab('Human Phenotype Ontology', 'HP:0000118', 'Phenotypic abnormality', 'https://purl.obolibrary.org/obo/HP_0000118', 'broad'),
  ],
  medication: [
    vocab('schema.org', 'Drug', 'Drug', 'https://schema.org/Drug', 'close'),
    vocab('HL7 FHIR', 'Medication', 'Medication resource', 'https://hl7.org/fhir/medication.html', 'close'),
    vocab('SNOMED CT', '373873005', 'Pharmaceutical / biologic product', undefined, 'broad'),
    vocab('RxNorm', undefined, 'Normalized drug vocabulary', 'https://www.nlm.nih.gov/research/umls/rxnorm/index.html', 'related'),
  ],
  procedure: [
    vocab('schema.org', 'MedicalProcedure', 'MedicalProcedure', 'https://schema.org/MedicalProcedure', 'close'),
    vocab('HL7 FHIR', 'Procedure', 'Procedure resource', 'https://hl7.org/fhir/procedure.html', 'close'),
    vocab('SNOMED CT', '71388002', 'Procedure', undefined, 'broad'),
  ],
  test: [
    vocab('schema.org', 'MedicalTest', 'MedicalTest', 'https://schema.org/MedicalTest', 'close'),
    vocab('HL7 FHIR', 'Observation', 'Observation resource', 'https://hl7.org/fhir/observation.html', 'close'),
    vocab('LOINC', undefined, 'Laboratory and clinical observation vocabulary', 'https://loinc.org/', 'related'),
  ],
  anatomy: [
    vocab('schema.org', 'AnatomicalStructure', 'AnatomicalStructure', 'https://schema.org/AnatomicalStructure', 'close'),
    vocab('HL7 FHIR', 'BodyStructure', 'BodyStructure resource', 'https://hl7.org/fhir/bodystructure.html', 'close'),
    vocab('SNOMED CT', '123037004', 'Body structure', undefined, 'broad'),
  ],
  guideline: [
    vocab('HL7 FHIR', 'PlanDefinition', 'PlanDefinition resource', 'https://hl7.org/fhir/plandefinition.html', 'close'),
    vocab('NCI Thesaurus', undefined, 'Clinical guideline vocabulary', 'https://ncit.nci.nih.gov/', 'related'),
  ],
  recommendation: [
    vocab('HL7 FHIR', 'CarePlan', 'CarePlan resource', 'https://hl7.org/fhir/careplan.html', 'close'),
  ],
  jurisdiction: [
    vocab('European Legislation Identifier', 'Jurisdiction', 'Jurisdiction', 'http://data.europa.eu/eli/ontology#jurisdiction', 'close'),
  ],
  statute: [
    vocab('European Legislation Identifier', 'LegalResource', 'LegalResource', 'http://data.europa.eu/eli/ontology#LegalResource', 'close'),
    vocab('Akoma Ntoso', 'act', 'act', 'http://docs.oasis-open.org/legaldocml/ns/akn/3.0', 'close'),
  ],
  regulation: [
    vocab('European Legislation Identifier', 'LegalResource', 'LegalResource', 'http://data.europa.eu/eli/ontology#LegalResource', 'close'),
  ],
  case: [
    vocab('Akoma Ntoso', 'judgment', 'judgment', 'http://docs.oasis-open.org/legaldocml/ns/akn/3.0', 'close'),
  ],
  contract: [
    vocab('schema.org', 'CreativeWork', 'CreativeWork', 'https://schema.org/CreativeWork', 'broad'),
    vocab('Akoma Ntoso', 'documentCollection', 'documentCollection', 'http://docs.oasis-open.org/legaldocml/ns/akn/3.0', 'related'),
  ],
  clause: [
    vocab('European Legislation Identifier', 'LegalResourceSubdivision', 'LegalResourceSubdivision', 'http://data.europa.eu/eli/ontology#LegalResourceSubdivision', 'close'),
    vocab('Akoma Ntoso', 'article', 'article / provision', 'http://docs.oasis-open.org/legaldocml/ns/akn/3.0', 'close'),
  ],
  obligation: [
    vocab('LegalRuleML', 'Obligation', 'Obligation', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  permission: [
    vocab('LegalRuleML', 'Permission', 'Permission', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  prohibition: [
    vocab('LegalRuleML', 'Prohibition', 'Prohibition', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  account: [
    vocab('schema.org', 'Organization', 'Organization', 'https://schema.org/Organization', 'close'),
    vocab('TM Forum SID', 'Customer', 'Customer / customer account', undefined, 'close'),
  ],
  feature: [
    vocab('schema.org', 'SoftwareApplication', 'SoftwareApplication', 'https://schema.org/SoftwareApplication', 'related'),
  ],
  ticket: [
    vocab('ITIL', 'Incident', 'Incident / service request', undefined, 'close'),
  ],
  metric: [
    vocab('OpenTelemetry Semantic Conventions', 'metric', 'Metric', 'https://opentelemetry.io/docs/specs/semconv/general/metrics/', 'related'),
  ],
  integration: [
    vocab('schema.org', 'SoftwareApplication', 'SoftwareApplication', 'https://schema.org/SoftwareApplication', 'related'),
  ],
  vendor: [
    vocab('schema.org', 'Organization', 'Organization', 'https://schema.org/Organization', 'close'),
    vocab('TM Forum SID', 'Supplier', 'Supplier / partner', undefined, 'close'),
  ],
}

export const BUILT_IN_RELATION_VOCABULARY: Record<string, readonly OntologyVocabularyRef[]> = {
  IS_A: [
    vocab('RDF', 'type', 'rdf:type', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'close'),
    vocab('Wikidata', 'P31', 'instance of', 'https://www.wikidata.org/wiki/Property:P31', 'close'),
  ],
  PART_OF: [
    vocab('Wikidata', 'P361', 'part of', 'https://www.wikidata.org/wiki/Property:P361', 'close'),
  ],
  CONTAINS: [
    vocab('Wikidata', 'P527', 'has part(s)', 'https://www.wikidata.org/wiki/Property:P527', 'close'),
  ],
  EQUIVALENT_TO: [
    vocab('OWL', 'sameAs', 'owl:sameAs', 'http://www.w3.org/2002/07/owl#sameAs', 'close'),
    vocab('SKOS', 'exactMatch', 'skos:exactMatch', 'http://www.w3.org/2004/02/skos/core#exactMatch', 'close'),
  ],
  AUTHORED: [
    vocab('schema.org', 'author', 'author', 'https://schema.org/author', 'close'),
    vocab('Wikidata', 'P50', 'author', 'https://www.wikidata.org/wiki/Property:P50', 'close'),
  ],
  PUBLISHED_IN: [
    vocab('schema.org', 'isPartOf', 'is part of', 'https://schema.org/isPartOf', 'close'),
    vocab('Wikidata', 'P1433', 'published in', 'https://www.wikidata.org/wiki/Property:P1433', 'exact'),
  ],
  LOCATED_IN: [
    vocab('schema.org', 'location', 'location', 'https://schema.org/location', 'close'),
    vocab('Wikidata', 'P131', 'located in the administrative territorial entity', 'https://www.wikidata.org/wiki/Property:P131', 'related'),
  ],
  WORKS_FOR: [
    vocab('schema.org', 'worksFor', 'worksFor', 'https://schema.org/worksFor', 'close'),
    vocab('Wikidata', 'P108', 'employer', 'https://www.wikidata.org/wiki/Property:P108', 'close'),
  ],
  MARRIED: [
    vocab('schema.org', 'spouse', 'spouse', 'https://schema.org/spouse', 'close'),
    vocab('Wikidata', 'P26', 'spouse', 'https://www.wikidata.org/wiki/Property:P26', 'close'),
  ],
  PARENT_OF: [
    vocab('schema.org', 'parent', 'parent', 'https://schema.org/parent', 'close'),
  ],
  APPEARS_IN: [
    vocab('Wikidata', 'P1441', 'present in work', 'https://www.wikidata.org/wiki/Property:P1441', 'close'),
  ],
  TREATS: [
    vocab('schema.org', 'Drug', 'drug / medical therapy relation', 'https://schema.org/Drug', 'related'),
    vocab('HL7 FHIR', 'ClinicalUseDefinition', 'clinical use', 'https://hl7.org/fhir/clinicalusedefinition.html', 'related'),
  ],
  DIAGNOSED_WITH: [
    vocab('HL7 FHIR', 'Condition.subject', 'condition on subject', 'https://hl7.org/fhir/condition-definitions.html#Condition.subject', 'close'),
  ],
  HAS_SYMPTOM: [
    vocab('SNOMED CT', '404684003', 'Clinical finding', undefined, 'broad'),
  ],
  INDICATED_FOR: [
    vocab('HL7 FHIR', 'ClinicalUseDefinition.indication', 'clinical indication', 'https://hl7.org/fhir/clinicalusedefinition.html', 'close'),
  ],
  CONTRAINDICATED_WITH: [
    vocab('HL7 FHIR', 'ClinicalUseDefinition.contraindication', 'contraindication', 'https://hl7.org/fhir/clinicalusedefinition.html', 'close'),
  ],
  MEASURED_BY: [
    vocab('HL7 FHIR', 'Observation.code', 'observation code', 'https://hl7.org/fhir/observation-definitions.html#Observation.code', 'related'),
    vocab('LOINC', undefined, 'clinical observation coding', 'https://loinc.org/', 'related'),
  ],
  APPLIES_TO: [
    vocab('European Legislation Identifier', 'relevant_for', 'relevant for', 'http://data.europa.eu/eli/ontology#relevant_for', 'related'),
  ],
  ASSIGNS_OBLIGATION_TO: [
    vocab('LegalRuleML', 'Obligation', 'deontic obligation', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  GRANTS_PERMISSION: [
    vocab('LegalRuleML', 'Permission', 'deontic permission', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  PROHIBITS: [
    vocab('LegalRuleML', 'Prohibition', 'deontic prohibition', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  PERMITS: [
    vocab('LegalRuleML', 'Permission', 'deontic permission', 'http://docs.oasis-open.org/legalruleml/ns/v1.0/', 'close'),
  ],
  REQUESTED: [
    vocab('ITIL', 'ServiceRequest', 'service request', undefined, 'close'),
  ],
  REPORTED: [
    vocab('ITIL', 'Incident', 'incident', undefined, 'close'),
  ],
  INTEGRATES_WITH: [
    vocab('OpenTelemetry Semantic Conventions', 'service', 'service dependency / telemetry relation', 'https://opentelemetry.io/docs/specs/semconv/resource/', 'related'),
  ],
}

const PROFILE_ENTITY_TYPES: Record<OntologyProfile, readonly string[]> = {
  general: [
    'person', 'organization', 'location', 'product', 'technology', 'concept', 'event',
    'meeting', 'document', 'project', 'issue', 'role', 'law_regulation', 'time_period',
    'creative_work', 'publication',
  ],
  literary: [
    'person', 'character', 'organization', 'location', 'place', 'building', 'artifact',
    'concept', 'event', 'document', 'creative_work', 'publication', 'role', 'time_period',
  ],
  medical: [
    'person', 'organization', 'location', 'concept', 'document', 'condition', 'symptom',
    'medication', 'procedure', 'test', 'anatomy', 'guideline', 'recommendation', 'time_period',
  ],
  legal: [
    'person', 'organization', 'location', 'jurisdiction', 'document', 'law_regulation',
    'statute', 'regulation', 'case', 'contract', 'clause', 'party', 'court', 'obligation',
    'permission', 'prohibition', 'concept', 'time_period',
  ],
  saas: [
    'person', 'organization', 'account', 'role', 'product', 'technology', 'feature',
    'ticket', 'issue', 'project', 'meeting', 'document', 'contract', 'metric', 'integration',
    'vendor', 'concept', 'time_period',
  ],
}

const PROFILE_PREDICATE_CATEGORIES: Record<OntologyProfile, readonly string[]> = {
  general: [
    'Core / taxonomy',
    'People / roles / orgs',
    'People / personal',
    'Business / organization',
    'Product / technical',
    'Work / issue / document',
    'Event / meeting / location / legal',
    'Historical / narrative',
  ],
  literary: [
    'Core / taxonomy',
    'People / roles / orgs',
    'People / personal',
    'Work / issue / document',
    'Event / meeting / location / legal',
    'Historical / narrative',
  ],
  medical: ['Core / taxonomy', 'Event / meeting / location / legal', 'Work / issue / document', 'Medical'],
  legal: ['Core / taxonomy', 'People / roles / orgs', 'Business / organization', 'Event / meeting / location / legal', 'Legal'],
  saas: [
    'Core / taxonomy',
    'People / roles / orgs',
    'Business / organization',
    'Product / technical',
    'Work / issue / document',
    'Event / meeting / location / legal',
    'SaaS',
  ],
}

const DEFAULT_RESOLUTION: Required<OntologyResolutionConfig> = {
  genericAliasBlocklist: [
    'indians', 'whites', 'the indians', 'the whites', 'natives', 'foreigners',
    'men', 'women', 'people', 'citizens', 'inhabitants', 'soldiers', 'troops',
  ],
  coordinateEntityTypes: ['location', 'place', 'building', 'jurisdiction'],
  coordinatePeerNames: [
    'mexico', 'guatemala', 'france', 'germany', 'belize', 'honduras',
    'uxmal', 'mayapan', 'chichen itza', 'chichen-itza',
  ],
  qualifiedPlaceSecondParts: [
    'egypt', 'kentucky', 'yucatan', 'yucatán', 'massachusetts', 'california',
    'texas', 'new york', 'england', 'france', 'germany', 'italy', 'spain',
    'guatemala', 'mexico', 'canada',
  ],
}

const PROFILE_PROMPT_GUIDELINES: Record<OntologyProfile, { entityGuidelines: string[]; relationGuidelines: string[] }> = {
  general: { entityGuidelines: [], relationGuidelines: [] },
  literary: {
    entityGuidelines: [
      'For literary or historical text, extract named characters, titled people, named places, buildings, artifacts, events, standalone creative works, and publications.',
      'Use creative_work only for independent named works such as novels, plays, poems, songs, films, artworks, essays, sermons, or titled collections. Use publication for journals, newspapers, magazines, reviews, almanacs, gazettes, and periodicals.',
      'Do not extract the current source document, generated source/chunk labels, unnamed chapters, structural headings, or storage labels as creative works or publications.',
      'Only extract a creative work or publication when it is named and materially participates in a fact. Omit title-like items that appear only in footnotes, lists, citations, or as minor context with no useful relationship.',
      'Do not treat broad ethnic, racial, class, or nationality labels as aliases for named entities unless the text gives a proper group name.',
      'Split peer coordinate lists such as "Mexico, Guatemala" or "Uxmal, Mayapan, and Chichen-Itza" into separate entities, but preserve qualified places such as "Cairo, Egypt".',
    ],
    relationGuidelines: [
      'Use CONFLICT_WITH for wars, hostilities, rivalries, or named conflicts between two entities.',
      'Use APPEARS_IN only for meaningful narrative membership: a character appearing in a named creative work or publication. Do not use it for ordinary document/chunk mentions or for real people, places, organizations, buildings, or artifacts merely mentioned in a work.',
      'Use PUBLISHED_IN when a document or creative work appears in a journal, newspaper, magazine, review, almanac, gazette, periodical, document, or larger work.',
    ],
  },
  medical: {
    entityGuidelines: ['Prefer precise clinical entities: condition, symptom, medication, procedure, test, anatomy, guideline, and recommendation.'],
    relationGuidelines: ['Use TREATS, INDICATED_FOR, CONTRAINDICATED_WITH, MEASURED_BY, HAS_SYMPTOM, and RECOMMENDS for clinical guideline facts.'],
  },
  legal: {
    entityGuidelines: ['Prefer legal entities: party, court, jurisdiction, statute, regulation, case, contract, clause, obligation, permission, and prohibition.'],
    relationGuidelines: ['Use APPLIES_TO, ASSIGNS_OBLIGATION_TO, HAS_CLAUSE, GRANTS_PERMISSION, PROHIBITS, PERMITS, AMENDS, and REPEALS for legal facts.'],
  },
  saas: {
    entityGuidelines: ['Prefer SaaS entities: account, person, role, feature, ticket, metric, integration, vendor, product, project, and meeting.'],
    relationGuidelines: ['Use REQUESTED, REPORTED, RENEWING, USES, INTEGRATES_WITH, ASSIGNED_TO, RESOLVES, BLOCKS, and DESCRIBES for customer/product facts.'],
  },
}

const BUILT_IN_PROFILE_ONTOLOGIES: Partial<Record<OntologyProfile, OntologyConfig>> = {
  saas: TYPEGRAPH_B2B_SAAS_ONTOLOGY,
}

function normalizeProfile(value: unknown): OntologyProfile | undefined {
  return typeof value === 'string' && (ONTOLOGY_PROFILES as readonly string[]).includes(value)
    ? value as OntologyProfile
    : undefined
}

function stableOntologyStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableOntologyStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableOntologyStringify(obj[key])}`).join(',')}}`
}

function stableHash(value: unknown): string {
  const input = stableOntologyStringify(value)
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function vocabularyKey(ref: OntologyVocabularyRef): string {
  return [
    ref.vocabulary.trim().toLowerCase(),
    ref.id?.trim().toLowerCase() ?? '',
    ref.uri?.trim().toLowerCase() ?? '',
    ref.label?.trim().toLowerCase() ?? '',
  ].join('|')
}

function dedupeVocabularyRefs(refs: readonly OntologyVocabularyRef[]): OntologyVocabularyRef[] {
  const byKey = new Map<string, OntologyVocabularyRef>()
  for (const ref of refs) {
    const vocabulary = ref.vocabulary.trim()
    if (!vocabulary) continue
    const normalized: OntologyVocabularyRef = {
      vocabulary,
      ...(ref.id?.trim() ? { id: ref.id.trim() } : {}),
      ...(ref.uri?.trim() ? { uri: ref.uri.trim() } : {}),
      ...(ref.label?.trim() ? { label: ref.label.trim() } : {}),
      ...(ref.match ? { match: ref.match } : {}),
    }
    byKey.set(vocabularyKey(normalized), normalized)
  }
  return [...byKey.values()]
}

function mergeEntityConfigs(
  base?: Record<string, OntologyEntityConfig> | undefined,
  override?: Record<string, OntologyEntityConfig> | undefined,
): Record<string, OntologyEntityConfig> | undefined {
  const merged = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(override ?? {})) {
    merged[key] = { ...(merged[key] ?? {}), ...value }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function mergeRelationConfigs(
  base?: Record<string, OntologyRelationConfig> | undefined,
  override?: Record<string, OntologyRelationConfig> | undefined,
): Record<string, OntologyRelationConfig> | undefined {
  const merged = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(override ?? {})) {
    const existing = merged[key]
    merged[key] = {
      ...(existing ?? {}),
      ...value,
      ...(existing?.aliases || value.aliases
        ? { aliases: [...new Set([...(existing?.aliases ?? []), ...(value.aliases ?? [])])] }
        : {}),
      ...(existing?.vocabulary || value.vocabulary
        ? { vocabulary: dedupeVocabularyRefs([...(existing?.vocabulary ?? []), ...(value.vocabulary ?? [])]) }
        : {}),
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function mergeResolutionConfigs(
  base?: OntologyResolutionConfig | undefined,
  override?: OntologyResolutionConfig | undefined,
): OntologyResolutionConfig | undefined {
  const merged: OntologyResolutionConfig = {}
  const mergeList = (key: keyof OntologyResolutionConfig) => {
    const values = [
      ...((base?.[key] as string[] | undefined) ?? []),
      ...((override?.[key] as string[] | undefined) ?? []),
    ]
    if (values.length > 0) merged[key] = [...new Set(values)]
  }
  mergeList('genericAliasBlocklist')
  mergeList('coordinateEntityTypes')
  mergeList('coordinatePeerNames')
  mergeList('qualifiedPlaceSecondParts')
  return Object.keys(merged).length > 0 ? merged : undefined
}

function mergePromptConfigs(
  base?: OntologyPromptConfig | undefined,
  override?: OntologyPromptConfig | undefined,
): OntologyPromptConfig | undefined {
  const entityGuidelines = [...new Set([...(base?.entityGuidelines ?? []), ...(override?.entityGuidelines ?? [])])]
  const relationGuidelines = [...new Set([...(base?.relationGuidelines ?? []), ...(override?.relationGuidelines ?? [])])]
  return {
    ...(entityGuidelines.length > 0 ? { entityGuidelines } : {}),
    ...(relationGuidelines.length > 0 ? { relationGuidelines } : {}),
  }
}

function mergeOntologyConfigs(base: OntologyConfig, override: OntologyConfig): OntologyConfig {
  return {
    version: override.version || base.version,
    mode: override.mode ?? base.mode,
    profiles: override.profiles ?? base.profiles,
    entities: mergeEntityConfigs(base.entities, override.entities),
    relations: mergeRelationConfigs(base.relations, override.relations),
    resolution: mergeResolutionConfigs(base.resolution, override.resolution),
    prompt: mergePromptConfigs(base.prompt, override.prompt),
    metadata: { ...(base.metadata ?? {}), ...(override.metadata ?? {}) },
  }
}

function builtInOntologyForProfiles(profiles: readonly OntologyProfile[]): OntologyConfig | undefined {
  let merged: OntologyConfig | undefined
  for (const profile of profiles) {
    const profileOntology = BUILT_IN_PROFILE_ONTOLOGIES[profile]
    if (!profileOntology) continue
    merged = merged ? mergeOntologyConfigs(merged, profileOntology) : profileOntology
  }
  return merged
}

export function compileOntology(config?: OntologyConfig): CompiledOntology {
  const strict = config?.mode === 'strict'
  const profiles = (config?.profiles ?? ['general'])
    .map(normalizeProfile)
    .filter((profile): profile is OntologyProfile => !!profile)
  const activeProfiles = profiles.length > 0 ? [...new Set(profiles)] : ['general' as const]
  const builtInConfig = strict ? undefined : builtInOntologyForProfiles(activeProfiles)
  const effectiveConfig = builtInConfig && config
    ? mergeOntologyConfigs(builtInConfig, config)
    : builtInConfig ?? config

  const entityTypes = new Set<string>()
  if (!strict) {
    for (const profile of activeProfiles) {
      for (const type of PROFILE_ENTITY_TYPES[profile]) entityTypes.add(type)
    }
  }
  for (const [type, entity] of Object.entries(effectiveConfig?.entities ?? {})) {
    const normalized = type.trim()
    if (!normalized) continue
    entityTypes.add(normalized)
    if (!strict && entity.extends) entityTypes.add(entity.extends)
  }

  const categories = new Set(strict ? [] : activeProfiles.flatMap(profile => PROFILE_PREDICATE_CATEGORIES[profile]))
  const relationSpecs = new Map<string, PredicateSpec>()
  for (const spec of PREDICATE_SPECS) {
    if (categories.has(spec.category)) relationSpecs.set(spec.name, spec)
  }
  for (const [name, relation] of Object.entries(effectiveConfig?.relations ?? {})) {
    const normalized = sanitizePredicate(name)
    if (!normalized) continue
    relationSpecs.set(normalized, {
      name: normalized,
      category: 'Custom',
      description: relation.description ?? normalized.toLowerCase().replace(/_/g, ' '),
      domain: relation.from ?? ALL_TYPES,
      range: relation.to ?? ALL_TYPES,
      symmetric: relation.symmetric,
      inverse: relation.inverse,
      aliases: relation.aliases?.map(alias => ({ name: alias })),
    })
  }

  const resolution: Required<OntologyResolutionConfig> = {
    genericAliasBlocklist: [...new Set([
      ...(DEFAULT_RESOLUTION.genericAliasBlocklist ?? []),
      ...(effectiveConfig?.resolution?.genericAliasBlocklist ?? []),
    ].map(normalizeOntologyToken).filter(Boolean))],
    coordinateEntityTypes: [...new Set([
      ...(DEFAULT_RESOLUTION.coordinateEntityTypes ?? []),
      ...(effectiveConfig?.resolution?.coordinateEntityTypes ?? []),
    ].map(normalizeOntologyToken).filter(Boolean))],
    coordinatePeerNames: [...new Set([
      ...(DEFAULT_RESOLUTION.coordinatePeerNames ?? []),
      ...(effectiveConfig?.resolution?.coordinatePeerNames ?? []),
    ].map(normalizeOntologyToken).filter(Boolean))],
    qualifiedPlaceSecondParts: [...new Set([
      ...(DEFAULT_RESOLUTION.qualifiedPlaceSecondParts ?? []),
      ...(effectiveConfig?.resolution?.qualifiedPlaceSecondParts ?? []),
    ].map(normalizeOntologyToken).filter(Boolean))],
  }

  const prompt = {
    entityGuidelines: [...new Set([
      ...(strict ? [] : activeProfiles.flatMap(profile => PROFILE_PROMPT_GUIDELINES[profile].entityGuidelines)),
      ...(effectiveConfig?.prompt?.entityGuidelines ?? []),
    ].map(item => item.trim()).filter(Boolean))],
    relationGuidelines: [...new Set([
      ...(strict ? [] : activeProfiles.flatMap(profile => PROFILE_PROMPT_GUIDELINES[profile].relationGuidelines)),
      ...(effectiveConfig?.prompt?.relationGuidelines ?? []),
    ].map(item => item.trim()).filter(Boolean))],
  }

  const compiledConfig: OntologyConfig = {
    version: effectiveConfig?.version ?? activeProfiles.join('+'),
    ...(effectiveConfig?.mode ? { mode: effectiveConfig.mode } : {}),
    profiles: activeProfiles,
    ...(effectiveConfig?.entities ? { entities: effectiveConfig.entities } : {}),
    ...(effectiveConfig?.relations ? { relations: effectiveConfig.relations } : {}),
    ...(effectiveConfig?.resolution ? { resolution: effectiveConfig.resolution } : {}),
    ...(effectiveConfig?.prompt ? { prompt: effectiveConfig.prompt } : {}),
    ...(effectiveConfig?.metadata ? { metadata: effectiveConfig.metadata } : {}),
  }

  const relationNames = [...relationSpecs.keys()]
  const relationAliases: Record<string, string> = {}
  for (const spec of relationSpecs.values()) {
    relationAliases[sanitizePredicate(spec.name)] = spec.name
    for (const alias of spec.aliases ?? []) relationAliases[sanitizePredicate(alias.name)] = spec.name
  }

  const entityVocabulary: Record<string, OntologyVocabularyRef[]> = {}
  const sortedEntityTypes = [...entityTypes].sort()
  for (const type of sortedEntityTypes) {
    const custom = effectiveConfig?.entities?.[type]
    const inheritedType = custom?.extends?.trim()
    const refs = dedupeVocabularyRefs([
      ...(inheritedType ? BUILT_IN_ENTITY_VOCABULARY[inheritedType] ?? [] : []),
      ...(BUILT_IN_ENTITY_VOCABULARY[type] ?? []),
      ...(custom?.vocabulary ?? []),
    ])
    if (refs.length > 0) entityVocabulary[type] = refs
  }

  const customRelationsByName = new Map(
    Object.entries(effectiveConfig?.relations ?? {})
      .map(([name, relation]) => [sanitizePredicate(name), relation] as const),
  )
  const relationVocabulary: Record<string, OntologyVocabularyRef[]> = {}
  const sortedRelationNames = [...relationNames].sort()
  for (const name of sortedRelationNames) {
    const refs = dedupeVocabularyRefs([
      ...(BUILT_IN_RELATION_VOCABULARY[name] ?? []),
      ...(customRelationsByName.get(name)?.vocabulary ?? []),
    ])
    if (refs.length > 0) relationVocabulary[name] = refs
  }

  const vocabulary = {
    entities: entityVocabulary,
    relations: relationVocabulary,
  }

  return {
    version: compiledConfig.version,
    hash: stableHash({ config: compiledConfig, relationNames: sortedRelationNames, entityTypes: sortedEntityTypes, vocabulary }),
    config: compiledConfig,
    profiles: activeProfiles,
    entityTypes: sortedEntityTypes,
    relationNames: sortedRelationNames,
    relationAliases,
    vocabulary,
    resolution,
    prompt,
    compiledAt: new Date(),
  }
}

export function validateOntologyConfig(config: OntologyConfig): CompiledOntology {
  const issues: string[] = []
  if (!config || typeof config !== 'object') {
    issues.push('ontology config must be an object')
  }
  if (!config?.version?.trim()) {
    issues.push('ontology.version is required')
  }
  if (config?.mode && !['extend', 'strict'].includes(config.mode)) {
    issues.push('ontology.mode must be "extend" or "strict"')
  }
  if (config?.mode === 'strict' && Object.keys(config.entities ?? {}).length === 0) {
    issues.push('strict ontology requires at least one entity type')
  }

  const compiled = compileOntology(config)
  const entityTypes = new Set(compiled.entityTypes)
  for (const [relationName, relation] of Object.entries(config?.relations ?? {})) {
    const normalized = sanitizePredicate(relationName)
    if (!normalized) {
      issues.push(`relation "${relationName}" has an empty canonical name`)
    }
    for (const direction of ['from', 'to'] as const) {
      for (const type of relation[direction] ?? []) {
        if (type === '*') continue
        if (!entityTypes.has(type)) {
          issues.push(`relation "${relationName}" ${direction} references unknown entity type "${type}"`)
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid ontology config: ${issues.join('; ')}`)
  }
  return compiled
}

export const DEFAULT_ONTOLOGY = compileOntology()

function normalizeOntologyToken(value: string): string {
  return value
    .trim()
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function ontologyEntityTypeSet(ontology?: CompiledOntology): Set<string> {
  return new Set((ontology ?? DEFAULT_ONTOLOGY).entityTypes)
}

function ontologyPredicateSpecs(ontology?: CompiledOntology): PredicateSpec[] {
  if (!ontology) return [...PREDICATE_SPECS]
  const active = new Set(ontology.relationNames)
  return PREDICATE_SPECS.filter(spec => active.has(spec.name))
    .concat(Object.entries(ontology.config.relations ?? {})
      .map(([name, relation]) => ({
        name: sanitizePredicate(name),
        category: 'Custom',
        description: relation.description ?? sanitizePredicate(name).toLowerCase().replace(/_/g, ' '),
        domain: relation.from ?? ALL_TYPES,
        range: relation.to ?? ALL_TYPES,
        symmetric: relation.symmetric,
        inverse: relation.inverse,
        aliases: relation.aliases?.map(alias => ({ name: alias })),
      })))
}

export function typeAffinityGroup(type: string | undefined, ontology?: CompiledOntology): readonly string[] | undefined {
  if (!type) return undefined
  if (ontology && !ontologyEntityTypeSet(ontology).has(type)) return undefined
  return TYPE_AFFINITY_GROUPS.find(group => (group as readonly string[]).includes(type))
}

export function typesShareAffinity(a: string | undefined, b: string | undefined, ontology?: CompiledOntology): boolean {
  if (!a || !b || a === b) return true
  const group = typeAffinityGroup(a, ontology)
  return !!group && group.includes(b)
}

export function normalizeTypeCandidates(
  primaryType: string | undefined,
  candidates?: TypeCandidate[] | undefined,
  ontology?: CompiledOntology,
): TypeCandidate[] {
  const allowed = ontologyEntityTypeSet(ontology)
  const byType = new Map<string, number>()
  const add = (type: string | undefined, confidence: number) => {
    if (!type || !allowed.has(type)) return
    const current = byType.get(type) ?? 0
    byType.set(type, Math.max(current, Math.max(0, Math.min(1, confidence))))
  }
  add(primaryType, 1)
  for (const candidate of candidates ?? []) {
    add(candidate.type, candidate.confidence)
  }
  return [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, confidence]) => ({ type, confidence }))
}

export function effectiveEntityTypes(
  primaryType: string | undefined,
  candidates?: TypeCandidate[] | undefined,
  minConfidence = 0.6,
  ontology?: CompiledOntology,
): string[] {
  const allowed = ontologyEntityTypeSet(ontology)
  const normalized = normalizeTypeCandidates(primaryType, candidates, ontology)
  const types = normalized
    .filter(candidate => candidate.type === primaryType || candidate.confidence >= minConfidence)
    .map(candidate => candidate.type)
  return [...new Set(types.length > 0 ? types : [primaryType ?? DEFAULT_ENTITY_TYPE])]
    .filter(type => allowed.has(type))
}

const PREDICATE_ALIAS_BY_NAME = buildPredicateAliasMap(PREDICATE_SPECS)

function buildPredicateAliasMap(specs: readonly PredicateSpec[]): Map<string, { canonical: string; alias: PredicateAliasSpec }> {
  const map = new Map<string, { canonical: string; alias: PredicateAliasSpec }>()
  for (const spec of specs) {
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

function predicateAliasMap(ontology?: CompiledOntology): Map<string, { canonical: string; alias: PredicateAliasSpec }> {
  return ontology ? buildPredicateAliasMap(ontologyPredicateSpecs(ontology)) : PREDICATE_ALIAS_BY_NAME
}

export function sanitizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
}

export function isSymmetricPredicate(predicate: string, ontology?: CompiledOntology): boolean {
  const normalized = sanitizePredicate(predicate)
  if (!ontology) return SYMMETRIC_PREDICATES.has(normalized)
  return ontologyPredicateSpecs(ontology).some(spec => spec.name === normalized && !!spec.symmetric)
}

export function normalizePredicateWithDirection(predicate: string, ontology?: CompiledOntology): PredicateNormalization {
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

  const resolved = predicateAliasMap(ontology).get(original)
  const normalized = resolved?.canonical ?? original
  const activePredicates = ontology ? new Set(ontology.relationNames) : ALL_PREDICATES
  const valid = activePredicates.has(normalized) && !GENERIC_DISALLOWED_PREDICATES.has(normalized)
  return {
    original,
    predicate: normalized,
    valid,
    swapSubjectObject: !!resolved?.alias.swap,
    symmetric: isSymmetricPredicate(normalized, ontology),
    ...(resolved?.alias.temporalStatus ? { temporalStatus: resolved.alias.temporalStatus } : {}),
  }
}

export function validatePredicateTypes(
  predicate: string,
  subjectType?: string | undefined,
  objectType?: string | undefined,
  ontology?: CompiledOntology,
): PredicateTypeValidation {
  const normalized = normalizePredicateWithDirection(predicate, ontology)
  if (!normalized.valid) {
    return {
      valid: false,
      domainValid: false,
      rangeValid: false,
      reason: 'invalid-predicate',
    }
  }
  const spec = ontologyPredicateSpecs(ontology).find(item => item.name === normalized.predicate)
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

export function validatePredicateEffectiveTypes(
  predicate: string,
  subjectTypes: readonly string[],
  objectTypes: readonly string[],
  ontology?: CompiledOntology,
): PredicateTypeValidation {
  const source = subjectTypes.length > 0 ? subjectTypes : [DEFAULT_ENTITY_TYPE]
  const target = objectTypes.length > 0 ? objectTypes : [DEFAULT_ENTITY_TYPE]
  let lastValidation: PredicateTypeValidation | undefined
  for (const subjectType of source) {
    for (const objectType of target) {
      const validation = validatePredicateTypes(predicate, subjectType, objectType, ontology)
      if (validation.valid) return validation
      lastValidation = validation
    }
  }
  return lastValidation ?? validatePredicateTypes(predicate, source[0], target[0], ontology)
}

function typeAllowed(allowed: readonly string[] | readonly ['*'], type?: string | undefined): boolean {
  if ((allowed as readonly string[]).includes('*')) return true
  if (!type) return true
  return (allowed as readonly string[]).includes(type)
}

/**
 * Get canonical predicates formatted for extraction and intent prompts.
 * Synonyms are intentionally omitted so the model emits a compact vocabulary.
 */
export function getPredicatesForPrompt(ontology?: CompiledOntology): string {
  const byCategory = new Map<string, PredicateSpec[]>()
  for (const spec of ontologyPredicateSpecs(ontology)) {
    if (spec.name === 'RELATED_TO') continue
    const list = byCategory.get(spec.category) ?? []
    list.push(spec)
    byCategory.set(spec.category, list)
  }

  const formatTypes = (types: readonly string[] | readonly ['*']) =>
    (types as readonly string[]).includes('*') ? 'any' : (types as readonly string[]).join(' | ')

  const lines = [...byCategory.entries()].map(([category, specs]) =>
    `${category}:\n${specs.map(spec =>
      `- ${spec.name}: ${spec.description} Subject: ${formatTypes(spec.domain)}. Object: ${formatTypes(spec.range)}.`
    ).join('\n')}`
  )

  return `Predicate vocabulary (choose from these canonical predicate cards only when a specific fact is supported):

${lines.join('\n')}

Use ONLY predicates from this vocabulary. Do not invent new predicate names. Use aliases only to understand source phrasing, not as output predicate names. If no card fits, omit the relationship.`
}

export function getEntityTypesForPrompt(ontology?: CompiledOntology): string {
  return (ontology?.entityTypes ?? ENTITY_TYPES).join(', ')
}

export function getOntologyPromptGuidelines(ontology?: CompiledOntology): string {
  const active = ontology ?? DEFAULT_ONTOLOGY
  const lines = [
    ...(active.prompt.entityGuidelines ?? []).map(line => `- ${line}`),
    ...(active.prompt.relationGuidelines ?? []).map(line => `- ${line}`),
  ]
  return lines.length > 0 ? lines.join('\n') : ''
}
