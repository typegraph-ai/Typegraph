import type { CompiledOntology } from '../types/ontology.js'
import { DEFAULT_ONTOLOGY, typesShareAffinity } from './ontology.js'

export interface CanonicalizableEntity {
  name: string
  type: string
  description?: string | undefined
  aliases?: string[] | undefined
}

const PERSON_TITLE_TOKENS = new Set([
  'captain', 'cousin', 'doctor', 'dr', 'judge', 'lady', 'lord', 'miss',
  'mr', 'mrs', 'ms', 'queen', 'saint', 'sir', 'st',
])

export function sanitizeEntityText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizeEntityText(value: string | undefined): string {
  return sanitizeEntityText(value)
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function canonicalizePhrasePrefixName(value: string): string {
  const trimmed = sanitizeEntityText(value)
  const match = trimmed.match(/^(?:according\s+to|per|as\s+(?:described|stated|noted|reported|recorded)\s+by|as\s+given\s+by|as\s+quoted\s+by)\s+(.+)$/i)
  if (!match) return trimmed
  const candidate = sanitizeEntityText(match[1])
  if (!candidate || candidate.length < 2) return trimmed
  if (!/^[A-Z0-9]/.test(candidate)) return trimmed
  if (candidate.length > 80) return trimmed
  return candidate
}

export function hasOcrEditorialNoise(value: string): boolean {
  return /\[(?:\s*(?:TN|T\.N\.|transcriber|transcription|translator|editor|ed\.|OCR|sic|note|corr\.?|correction)\b)[^\]]*\]/i.test(value)
    || /\b(?:transcriber'?s?\s+note|ocr\s+(?:note|correction|error)|editorial\s+note)\b/i.test(value)
}

function splitCoordinateParts(value: string): string[] {
  return sanitizeEntityText(value)
    .replace(/\s*[,;/]\s*(?:and\s+)?/gi, '|')
    .replace(/\s*&\s*/g, '|')
    .replace(/\s+\band\b\s+/gi, '|')
    .split('|')
    .map(part => sanitizeEntityText(part))
    .filter(Boolean)
}

export function isCoordinateListAlias(value: string, entityType?: string, ontology?: CompiledOntology): boolean {
  const active = ontology ?? DEFAULT_ONTOLOGY
  const typeKey = normalizeEntityText(entityType)
  const coordinateTypes = active.resolution.coordinateEntityTypes ?? []
  if (entityType && !coordinateTypes.includes(typeKey)) return false
  if (!/[,&;/]|\band\b/i.test(value)) return false

  const parts = splitCoordinateParts(value)
  if (parts.length < 2) return false

  const normalizedParts = parts.map(normalizeEntityText)
  const peerNames = active.resolution.coordinatePeerNames ?? []
  const qualifiedPlaceSecondParts = active.resolution.qualifiedPlaceSecondParts ?? []
  if (
    parts.length === 2
    && qualifiedPlaceSecondParts.includes(normalizedParts[1]!)
    && !peerNames.includes(normalizedParts[0]!)
  ) {
    return false
  }

  return parts.length > 2
    || normalizedParts.every(part => peerNames.includes(part))
    || /\band\b|&|;|\//i.test(value)
}

function entityFamily(type: string | undefined, ontology?: CompiledOntology): string {
  if (!type) return 'unknown'
  if (typesShareAffinity(type, 'location', ontology) || typesShareAffinity(type, 'place', ontology)) return 'place'
  if (typesShareAffinity(type, 'document', ontology) || typesShareAffinity(type, 'creative_work', ontology) || typesShareAffinity(type, 'publication', ontology)) return 'document-work'
  if (typesShareAffinity(type, 'organization', ontology)) return 'organization'
  if (typesShareAffinity(type, 'person', ontology) || typesShareAffinity(type, 'character', ontology)) return 'person'
  return type
}

function personNameTokens(value: string | undefined): string[] {
  const normalized = normalizeEntityText(value)
  return normalized ? normalized.split(/\s+/).filter(Boolean) : []
}

function stripPersonTitles(tokens: string[]): string[] {
  return tokens.filter(token => !PERSON_TITLE_TOKENS.has(token))
}

function isCompatibleGivenNameAlias(aliasToken: string, givenToken: string): boolean {
  if (!aliasToken || !givenToken) return false
  if (aliasToken === givenToken) return true
  if (aliasToken.length === 1) return givenToken.startsWith(aliasToken)
  return aliasToken.startsWith(givenToken) || givenToken.startsWith(aliasToken)
}

export function isPersonGivenNameAlias(alias: string, ownerName: string): boolean {
  const ownerTokens = stripPersonTitles(personNameTokens(ownerName))
  if (ownerTokens.length < 2) return false
  const ownerGivenTokens = ownerTokens.slice(0, -1)
  const aliasTokens = stripPersonTitles(personNameTokens(alias))
  if (aliasTokens.length !== 1) return false
  const aliasToken = aliasTokens[0]!
  return ownerGivenTokens.some(givenToken => isCompatibleGivenNameAlias(aliasToken, givenToken))
}

export function isCrossEntityAlias(
  alias: string,
  owner: CanonicalizableEntity,
  entities: readonly CanonicalizableEntity[],
  ontology?: CompiledOntology,
): boolean {
  const aliasKey = normalizeEntityText(alias)
  if (!aliasKey) return false
  const ownerKey = normalizeEntityText(owner.name)
  if (aliasKey === ownerKey) return true
  const ownerFamily = entityFamily(owner.type, ontology)
  return entities.some(entity =>
    entity !== owner
    && entityFamily(entity.type, ontology) === ownerFamily
    && normalizeEntityText(entity.name) === aliasKey
  )
}

export function isUnsafeEntityAlias(
  alias: string,
  owner: CanonicalizableEntity,
  entities: readonly CanonicalizableEntity[] = [],
  ontology?: CompiledOntology,
): boolean {
  const clean = sanitizeEntityText(alias)
  if (!clean) return true
  if (normalizeEntityText(clean) === normalizeEntityText(owner.name)) return true
  if (hasOcrEditorialNoise(clean)) return true
  if (canonicalizePhrasePrefixName(clean) !== clean) return true
  if (isCoordinateListAlias(clean, owner.type, ontology)) return true
  if (
    (typesShareAffinity(owner.type, 'person', ontology) || typesShareAffinity(owner.type, 'character', ontology))
    && isPersonGivenNameAlias(clean, owner.name)
  ) {
    return true
  }
  if (isCrossEntityAlias(clean, owner, entities, ontology)) return true
  return false
}

export function sanitizeEntityAliases<T extends CanonicalizableEntity>(
  entity: T,
  entities: readonly CanonicalizableEntity[] = [],
  ontology?: CompiledOntology,
): T {
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const alias of entity.aliases ?? []) {
    const clean = sanitizeEntityText(alias)
    const key = normalizeEntityText(clean)
    if (!key || seen.has(key)) continue
    if (isUnsafeEntityAlias(clean, entity, entities, ontology)) continue
    seen.add(key)
    aliases.push(clean)
  }
  return { ...entity, aliases }
}

export function canonicalizeEntityName<T extends CanonicalizableEntity>(entity: T): T | undefined {
  let name = canonicalizePhrasePrefixName(sanitizeEntityText(entity.name))
  if (!name || hasOcrEditorialNoise(name)) return undefined
  return { ...entity, name }
}

export function sanitizeEntityBatch<T extends CanonicalizableEntity>(
  entities: readonly T[],
  ontology?: CompiledOntology,
): T[] {
  const renamed = entities
    .map(entity => canonicalizeEntityName(entity))
    .filter((entity): entity is T => !!entity)
  return renamed.map(entity => sanitizeEntityAliases(entity, renamed, ontology))
}
