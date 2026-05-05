import { z } from 'zod/v4-mini'
import type { LLMProvider } from '../types/llm-provider.js'
import type { GraphIntentParserMode, GraphQueryIntent, GraphQueryIntentPredicate, ParsedGraphQueryIntent } from '../types/graph-bridge.js'
import { ALL_PREDICATES, getPredicatesForPrompt } from '../index-engine/ontology.js'
import { PredicateNormalizer } from '../memory/extraction/predicate-normalizer.js'
import type { EmbeddingProvider } from '../embedding/provider.js'

const EMPTY_EMBEDDING: EmbeddingProvider = {
  model: 'predicate-normalizer-static',
  dimensions: 1,
  embed: async () => [0],
  embedBatch: async (values: string[]) => values.map(() => [0]),
}

const predicateNormalizer = new PredicateNormalizer(EMPTY_EMBEDDING)

const predicateSchema = z.object({
  name: z.string(),
  confidence: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
})

const intentSchema = z.object({
  sourceEntityQueries: z._default(z.array(z.string()).check(z.maxLength(12)), []),
  targetEntityQueries: z._default(z.array(z.string()).check(z.maxLength(12)), []),
  predicates: z._default(z.array(predicateSchema).check(z.maxLength(16)), []),
  subqueries: z._default(z.array(z.string()).check(z.maxLength(8)), []),
  mode: z._default(z.enum(['fact', 'relationship', 'summary', 'creative']), 'fact'),
  strictness: z._default(z.enum(['strict', 'soft', 'none']), 'strict'),
})

type IntentMode = GraphQueryIntent['mode']
type IntentStrictness = GraphQueryIntent['strictness']

interface PredicateNormalization {
  predicates: GraphQueryIntentPredicate[]
  rejectedPredicates: string[]
}

interface IntentDraft {
  sourceEntityQueries?: string[] | undefined
  targetEntityQueries?: string[] | undefined
  predicates?: Array<{ name: string; confidence?: number | undefined }> | undefined
  subqueries?: string[] | undefined
  mode?: IntentMode | undefined
  strictness?: IntentStrictness | undefined
  matchedPatterns?: string[] | undefined
}

const QUERY_WORDS = new Set([
  'who',
  'what',
  'where',
  'when',
  'why',
  'how',
  'which',
  'write',
  'imagine',
  'tell',
  'summarize',
  'compare',
])

const ENTITY_STOP_WORDS = new Set([
  'book',
  'books',
  'company',
  'city',
  'country',
  'diary',
  'entry',
  'father',
  'husband',
  'letter',
  'mother',
  'organization',
  'parent',
  'parents',
  'chunk',
  'chunks',
  'relationship',
  'sibling',
  'siblings',
  'sister',
  'son',
  'spouse',
  'temples',
  'wife',
])

function cleanText(value: string): string {
  return value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function cleanQueries(values: string[]): string[] {
  return unique(values.map(cleanText).filter(value => value.length > 0 && value.length <= 140))
}

function relationToPhrase(relation: string): string {
  return relation.toLowerCase().replace(/_/g, ' ')
}

function normalizePredicates(values: Array<{ name: string; confidence?: number | undefined }>): PredicateNormalization {
  const byName = new Map<string, GraphQueryIntentPredicate>()
  const rejectedPredicates: string[] = []
  for (const value of values) {
    const normalized = predicateNormalizer.normalizeWithDirection(value.name)
    if (!normalized.valid || !(ALL_PREDICATES as ReadonlySet<string>).has(normalized.predicate)) {
      rejectedPredicates.push(value.name)
      continue
    }
    const confidence = typeof value.confidence === 'number'
      ? Math.max(0, Math.min(1, value.confidence))
      : 0.95
    const existing = byName.get(normalized.predicate)
    if (!existing || confidence > existing.confidence) {
      byName.set(normalized.predicate, {
        name: normalized.predicate,
        confidence,
        symmetric: normalized.symmetric,
      })
    }
  }
  return { predicates: [...byName.values()], rejectedPredicates: unique(rejectedPredicates) }
}

function emptyIntent(query: string): GraphQueryIntent {
  return {
    rawQuery: query,
    sourceEntityQueries: [],
    targetEntityQueries: [],
    predicates: [],
    subqueries: [],
    mode: 'fact',
    strictness: 'none',
  }
}

function parsedNone(query: string, parseMs?: number): ParsedGraphQueryIntent {
  return {
    parser: 'none',
    intent: emptyIntent(query),
    ...(typeof parseMs === 'number' ? { parseMs } : {}),
  }
}

function isIntentEmpty(intent: GraphQueryIntent): boolean {
  return (
    intent.sourceEntityQueries.length === 0 &&
    intent.targetEntityQueries.length === 0 &&
    intent.predicates.length === 0 &&
    intent.subqueries.length === 0 &&
    intent.strictness === 'none'
  )
}

function buildIntent(
  query: string,
  raw: z.infer<typeof intentSchema> | IntentDraft,
): { intent: GraphQueryIntent; rejectedPredicates: string[] } {
  const normalized = normalizePredicates(raw.predicates ?? [])
  const sourceEntityQueries = cleanQueries(raw.sourceEntityQueries ?? [])
  const targetEntityQueries = cleanQueries(raw.targetEntityQueries ?? [])
  const predicates = normalized.predicates
  const strictness = raw.strictness ?? (
    predicates.length > 0 && (sourceEntityQueries.length > 0 || targetEntityQueries.length > 0)
      ? 'strict'
      : (sourceEntityQueries.length > 0 || targetEntityQueries.length > 0 || cleanQueries(raw.subqueries ?? []).length > 0 ? 'soft' : 'none')
  )
  return {
    intent: {
      rawQuery: query,
      sourceEntityQueries,
      targetEntityQueries,
      predicates,
      subqueries: cleanQueries(raw.subqueries ?? []),
      mode: raw.mode ?? 'fact',
      strictness,
    },
    rejectedPredicates: normalized.rejectedPredicates,
  }
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[?!.,:;]+$/g, '').trim()
}

function cleanEntity(value: string): string {
  const original = cleanText(stripTerminalPunctuation(value))
  const quoted = /^["'`].*["'`]$/.test(original)
  let entity = original.replace(/^["'`]+|["'`]+$/g, '').trim()
  entity = entity.replace(/\s+(?:is|are|was|were)$/i, '').trim()
  entity = entity.replace(/^(.+?)['’]s\s+.+$/i, '$1').replace(/^(.+?)['’]\s+.+$/i, '$1').trim()
  entity = entity.replace(/['’]s$/i, '').replace(/['’]$/i, '').trim()
  entity = stripTerminalPunctuation(entity)
  if (!quoted) entity = entity.replace(/^(?:the|a|an)\s+/i, '').trim()
  return entity
}

function validEntity(value: string): boolean {
  const normalized = value.toLowerCase()
  if (!normalized || normalized.length < 2) return false
  if (QUERY_WORDS.has(normalized) || ENTITY_STOP_WORDS.has(normalized)) return false
  return true
}

function entity(value: string | undefined): string[] {
  if (!value) return []
  const cleaned = cleanEntity(value)
  return validEntity(cleaned) ? [cleaned] : []
}

function predicate(name: string, confidence = 1): Array<{ name: string; confidence: number }> {
  return [{ name, confidence }]
}

function subquery(entities: string[], predicateName?: string): string[] {
  const parts = cleanQueries([...entities])
  if (parts.length === 0) return []
  return [predicateName ? `${parts.join(' ')} ${relationToPhrase(predicateName)}` : parts.join(' ')]
}

function draft(input: IntentDraft): IntentDraft {
  const sourceEntityQueries = cleanQueries(input.sourceEntityQueries ?? [])
  const targetEntityQueries = cleanQueries(input.targetEntityQueries ?? [])
  const firstPredicate = input.predicates?.[0]?.name
  return {
    ...input,
    sourceEntityQueries,
    targetEntityQueries,
    subqueries: input.subqueries ?? subquery([...sourceEntityQueries, ...targetEntityQueries], firstPredicate),
  }
}

function matchOne(query: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = query.match(pattern)
    if (match) return match
  }
  return null
}

function extractNamedEntities(query: string): string[] {
  const names: string[] = []
  const quoted = query.matchAll(/["']([^"']{2,120})["']/g)
  for (const match of quoted) names.push(...entity(match[1]))

  const titleCase = query.matchAll(/\b(?:[A-Z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*|[A-Z]{2,})(?:(?:\s+|,\s*)(?:[A-Z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*|[A-Z]{2,}|Mass\.|D\.C\.))*\.?/g)
  for (const match of titleCase) {
    const candidate = cleanEntity(match[0])
    if (!validEntity(candidate)) continue
    const first = candidate.split(/\s+/)[0]?.toLowerCase()
    if (first && QUERY_WORDS.has(first)) continue
    names.push(candidate)
  }

  return cleanQueries(names)
}

function parseDirectFact(query: string): IntentDraft | null {
  let match = matchOne(query, [
    /^who\s+(?:killed|murdered|assassinated|slew|slayed|stabbed)\s+(.+?)\??$/i,
    /^who\s+was\s+(.+?)\s+(?:killed|murdered|assassinated|slain|stabbed)\s+by\??$/i,
    /^(.+?)\s+was\s+(?:killed|murdered|assassinated|slain|stabbed)\s+by\s+whom\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    return draft({ targetEntityQueries, predicates: predicate('KILLED'), mode: 'fact', strictness: 'strict', matchedPatterns: ['killed-target'] })
  }

  match = query.match(/^who\s+did\s+(.+?)\s+(?:kill|murder|assassinate|slay|stab)\??$/i)
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('KILLED'), mode: 'fact', strictness: 'strict', matchedPatterns: ['killed-source'] })
  }

  match = matchOne(query, [
    /^who\s+(?:is|was|are|were)\s+(.+?)['’]s\s+(?:wife|husband|spouse)\??$/i,
    /^who\s+(?:is|was|are|were)\s+(.+?)\s+(?:wife|husband|spouse)\??$/i,
    /^who\s+(?:is|was)\s+(?:the\s+)?(?:wife|husband|spouse)\s+of\s+(.+?)\??$/i,
    /^who\s+(?:was|is)\s+(.+?)\s+married\s+to\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('MARRIED'), mode: 'fact', strictness: 'strict', matchedPatterns: ['spouse'] })
  }

  match = matchOne(query, [
    /^who\s+(?:are|is|was|were)\s+(.+?)['’]s\s+(?:parents?|father|mother|ancestors?)\??$/i,
    /^who\s+(?:is|are|was|were)\s+(?:the\s+)?(?:parents?|father|mother|ancestors?)\s+of\s+(.+?)\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    return draft({ targetEntityQueries, predicates: predicate('PARENT_OF'), mode: 'fact', strictness: 'strict', matchedPatterns: ['parent-target'] })
  }

  match = query.match(/^who\s+did\s+(.+?)\s+father\??$/i)
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('PARENT_OF'), mode: 'fact', strictness: 'strict', matchedPatterns: ['parent-source'] })
  }

  match = matchOne(query, [
    /^who\s+(?:are|is|was|were)\s+(.+?)['’]s\s+(?:children|child|sons?|daughters?|offspring)\??$/i,
    /^who\s+(?:is|are|was|were)\s+(?:the\s+)?(?:children|child|sons?|daughters?|offspring)\s+of\s+(.+?)\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    return draft({ targetEntityQueries, predicates: predicate('CHILD_OF'), mode: 'fact', strictness: 'strict', matchedPatterns: ['child-target'] })
  }

  match = matchOne(query, [
    /^who\s+(?:is|are|was|were)\s+(.+?)['’]s\s+(?:brother|sister|siblings?|sibling)\??$/i,
    /^who\s+(?:is|are|was|were)\s+(?:the\s+)?(?:brother|sister|siblings?|sibling)\s+of\s+(.+?)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('SIBLING_OF'), mode: 'fact', strictness: 'strict', matchedPatterns: ['sibling'] })
  }

  match = matchOne(query, [
    /^who\s+(?:wrote|authored|composed)\s+(.+?)\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    const verb = query.match(/\b(authored|composed)\b/i)?.[1]?.toUpperCase() ?? 'WROTE'
    return draft({ targetEntityQueries, predicates: predicate(verb), mode: 'fact', strictness: 'strict', matchedPatterns: ['work-target'] })
  }

  match = matchOne(query, [
    /^what\s+(?:books?|works?|novels?|plays?|poems?)?\s*did\s+(.+?)\s+(?:write|author|compose)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('WROTE'), mode: 'fact', strictness: 'strict', matchedPatterns: ['work-source'] })
  }

  match = matchOne(query, [
    /^who\s+(?:founded|established)\s+(.+?)\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    return draft({ targetEntityQueries, predicates: predicate('FOUNDED'), mode: 'fact', strictness: 'strict', matchedPatterns: ['founded-target'] })
  }

  match = matchOne(query, [
    /^what\s+(?:company|organization|org|institution|project)?\s*did\s+(.+?)\s+(co[-\s]?found|found|establish)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    const predicateName = /co[-\s]?found/i.test(match[2] ?? '') ? 'CO_FOUNDED' : 'FOUNDED'
    return draft({ sourceEntityQueries, predicates: predicate(predicateName), mode: 'fact', strictness: 'strict', matchedPatterns: ['founded-source'] })
  }

  match = matchOne(query, [
    /^where\s+was\s+(.+?)\s+born\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('BORN_IN'), mode: 'fact', strictness: 'strict', matchedPatterns: ['born-in'] })
  }

  match = matchOne(query, [
    /^where\s+did\s+(.+?)\s+die\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('DIED_IN'), mode: 'fact', strictness: 'strict', matchedPatterns: ['died-in'] })
  }

  match = matchOne(query, [
    /^where\s+(?:is|was)\s+(.+?)\s+headquartered\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('HEADQUARTERED_IN'), mode: 'fact', strictness: 'strict', matchedPatterns: ['headquartered-in'] })
  }

  match = matchOne(query, [
    /^(?:what\s+(?:city|country|place|location)\s+)?(?:is|was)\s+(.+?)\s+located\s+in\??$/i,
    /^where\s+(?:is|was)\s+(.+?)\s+located\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('LOCATED_IN'), mode: 'fact', strictness: 'strict', matchedPatterns: ['located-in'] })
  }

  match = matchOne(query, [
    /^who\s+leads\s+(.+?)\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    return draft({ targetEntityQueries, predicates: predicate('LEADS'), mode: 'fact', strictness: 'strict', matchedPatterns: ['leads-target'] })
  }

  match = matchOne(query, [
    /^what\s+(?:organization|company|org|institution)\s+does\s+(.+?)\s+lead\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('LEADS'), mode: 'fact', strictness: 'strict', matchedPatterns: ['leads-source'] })
  }

  match = matchOne(query, [
    /^who\s+works\s+for\s+(.+?)\??$/i,
  ])
  if (match) {
    const targetEntityQueries = entity(match[1])
    return draft({ targetEntityQueries, predicates: predicate('WORKS_FOR'), mode: 'fact', strictness: 'strict', matchedPatterns: ['works-for-target'] })
  }

  match = matchOne(query, [
    /^where\s+does\s+(.+?)\s+work\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    return draft({ sourceEntityQueries, predicates: predicate('WORKS_FOR'), mode: 'fact', strictness: 'strict', matchedPatterns: ['works-for-source'] })
  }

  return null
}

function parseSoftIntent(query: string): IntentDraft | null {
  let match = matchOne(query, [
    /^summarize\s+(?:the\s+)?relationship\s+between\s+(.+?)\s+and\s+(.+?)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    const targetEntityQueries = entity(match[2])
    return draft({ sourceEntityQueries, targetEntityQueries, mode: 'summary', strictness: 'soft', subqueries: [`${sourceEntityQueries[0] ?? ''} ${targetEntityQueries[0] ?? ''} relationship`], matchedPatterns: ['relationship-between-summary'] })
  }

  match = matchOne(query, [
    /^how\s+(?:are|is)\s+(.+?)\s+and\s+(.+?)\s+(?:related|connected|linked)\??$/i,
    /^what\s+connects\s+(.+?)\s+and\s+(.+?)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    const targetEntityQueries = entity(match[2])
    return draft({ sourceEntityQueries, targetEntityQueries, mode: 'relationship', strictness: 'soft', subqueries: [`${sourceEntityQueries[0] ?? ''} ${targetEntityQueries[0] ?? ''} relationship`], matchedPatterns: ['relationship-between'] })
  }

  match = matchOne(query, [
    /^write\b.*?\bfrom\s+(.+?)['’]s\s+perspective\s+about\s+(.+?)\??$/i,
    /^imagine\b.*?\bfrom\s+(.+?)\s+to\s+(.+?)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = cleanQueries([...entity(match[1]), ...entity(match[2])])
    return draft({ sourceEntityQueries, mode: 'creative', strictness: 'soft', subqueries: sourceEntityQueries, matchedPatterns: ['creative-anchors'] })
  }

  if (/\b(write|imagine|compose|draft)\b/i.test(query)) {
    const sourceEntityQueries = extractNamedEntities(query)
    if (sourceEntityQueries.length > 0) {
      return draft({ sourceEntityQueries, mode: 'creative', strictness: 'soft', subqueries: sourceEntityQueries, matchedPatterns: ['creative-named-entities'] })
    }
  }

  match = matchOne(query, [
    /^tell\s+me\s+about\s+(.+?)\??$/i,
    /^what\s+do\s+we\s+know\s+about\s+(.+?)\??$/i,
    /^summarize\s+(.+?)\??$/i,
  ])
  if (match) {
    const sourceEntityQueries = entity(match[1])
    if (sourceEntityQueries.length > 0 && !/^(?:this|it|that|these|those)$/i.test(sourceEntityQueries[0]!)) {
      return draft({ sourceEntityQueries, mode: 'summary', strictness: 'soft', subqueries: sourceEntityQueries, matchedPatterns: ['anchor-summary'] })
    }
  }

  match = query.match(/\babout\s+(.+?)['’]\s+/i)
  if (match) {
    const sourceEntityQueries = entity(match[1])
    if (sourceEntityQueries.length > 0) {
      return draft({ sourceEntityQueries, mode: 'summary', strictness: 'soft', subqueries: sourceEntityQueries, matchedPatterns: ['possessive-anchor'] })
    }
  }

  const namedEntities = extractNamedEntities(query)
  if (namedEntities.length > 0 && !/^(?:who|what|where|when|why|how|which)\b/i.test(query)) {
    return draft({ sourceEntityQueries: namedEntities, mode: 'summary', strictness: 'soft', subqueries: namedEntities, matchedPatterns: ['named-entity-anchor'] })
  }

  return null
}

function parseDeterministic(query: string): ParsedGraphQueryIntent {
  const startedAt = Date.now()
  const cleaned = cleanText(query)
  const raw = parseDirectFact(cleaned) ?? parseSoftIntent(cleaned)
  if (!raw) return parsedNone(query, Date.now() - startedAt)

  const parsed = buildIntent(query, raw)
  if (isIntentEmpty(parsed.intent)) return parsedNone(query, Date.now() - startedAt)

  return {
    parser: 'deterministic',
    intent: parsed.intent,
    matchedPatterns: raw.matchedPatterns ?? [],
    rejectedPredicates: parsed.rejectedPredicates,
    parseMs: Date.now() - startedAt,
  }
}

async function parseWithLlm(query: string, llm: LLMProvider): Promise<ParsedGraphQueryIntent> {
  const startedAt = Date.now()
  const prompt = [
    'Parse this user query into graph retrieval intent.',
    '',
    `Query: ${query}`,
    '',
    'Return JSON only with this exact shape:',
    '{ "sourceEntityQueries": string[], "targetEntityQueries": string[], "predicates": [{ "name": string, "confidence": number }], "subqueries": string[], "mode": "fact" | "relationship" | "summary" | "creative", "strictness": "strict" | "soft" | "none" }',
    '',
    'Field contract:',
    '- sourceEntityQueries: known entities expected on stored edge source side.',
    '- targetEntityQueries: known entities expected on stored edge target side.',
    '- predicates: canonical ontology predicates required or useful for the query.',
    '- subqueries: at most two short searches grounded in the original question.',
    '- mode: fact for direct lookup, relationship for relationship questions, summary for summarization, creative for creative/genre tasks.',
    '- strictness: strict only for explicit fact lookups with clear entity direction and predicate; soft for summaries, creative tasks, relationship exploration, or ambiguous direction; none when no graph intent exists.',
    '',
    'Rules:',
    '- Direction is represented only by sourceEntityQueries and targetEntityQueries.',
    '- Do not emit answerSide.',
    '- Do not infer extra predicates because nearby facts might exist.',
    '- Do not force predicates for summary or creative queries.',
    '- Spouse, husband, wife, and married questions use MARRIED.',
    '- Passive voice must preserve logical edge direction.',
    '',
    'Examples:',
    '- "Who founded Stripe?" -> {"sourceEntityQueries":[],"targetEntityQueries":["Stripe"],"predicates":[{"name":"FOUNDED","confidence":0.98}],"subqueries":["Stripe founded"],"mode":"fact","strictness":"strict"}',
    '- "What did Ada Lovelace write?" -> {"sourceEntityQueries":["Ada Lovelace"],"targetEntityQueries":[],"predicates":[{"name":"WROTE","confidence":0.98}],"subqueries":["Ada Lovelace wrote"],"mode":"fact","strictness":"strict"}',
    '- "Who wrote Frankenstein?" -> {"sourceEntityQueries":[],"targetEntityQueries":["Frankenstein"],"predicates":[{"name":"WROTE","confidence":0.98}],"subqueries":["Frankenstein wrote"],"mode":"fact","strictness":"strict"}',
    '- "Where was Marie Curie born?" -> {"sourceEntityQueries":["Marie Curie"],"targetEntityQueries":[],"predicates":[{"name":"BORN_IN","confidence":0.98}],"subqueries":["Marie Curie born in"],"mode":"fact","strictness":"strict"}',
    '- "Who was Hamlet killed by?" -> {"sourceEntityQueries":[],"targetEntityQueries":["Hamlet"],"predicates":[{"name":"KILLED","confidence":0.98}],"subqueries":["Hamlet killed"],"mode":"fact","strictness":"strict"}',
    '- "Summarize the relationship between Tesla and Edison" -> {"sourceEntityQueries":["Tesla"],"targetEntityQueries":["Edison"],"predicates":[],"subqueries":["Tesla Edison relationship"],"mode":"summary","strictness":"soft"}',
    '- "How are Kubernetes and Docker related?" -> {"sourceEntityQueries":["Kubernetes"],"targetEntityQueries":["Docker"],"predicates":[],"subqueries":["Kubernetes Docker relationship"],"mode":"relationship","strictness":"soft"}',
    '- "Write a diary entry from Elizabeth Bennet\'s perspective about Darcy" -> {"sourceEntityQueries":["Elizabeth Bennet","Darcy"],"targetEntityQueries":[],"predicates":[],"subqueries":["Elizabeth Bennet","Darcy"],"mode":"creative","strictness":"soft"}',
    '',
    'Valid predicate vocabulary:',
    getPredicatesForPrompt(),
  ].join('\n')

  const raw = await llm.generateJSON<z.infer<typeof intentSchema>>(prompt, undefined, {
    schema: intentSchema,
    maxOutputTokens: 768,
  })
  const parsed = intentSchema.parse(raw)
  const intent = buildIntent(query, parsed)
  if (isIntentEmpty(intent.intent)) return parsedNone(query, Date.now() - startedAt)

  return {
    parser: 'llm',
    intent: intent.intent,
    rejectedPredicates: intent.rejectedPredicates,
    parseMs: Date.now() - startedAt,
  }
}

export async function parseGraphQueryIntent(input: {
  query: string
  mode?: GraphIntentParserMode | undefined
  llm?: LLMProvider | undefined
}): Promise<ParsedGraphQueryIntent> {
  const mode = input.mode ?? 'deterministic'
  if (mode === 'none') return parsedNone(input.query, 0)
  if (mode === 'deterministic') return parseDeterministic(input.query)
  if (!input.llm) return parsedNone(input.query, 0)
  try {
    return await parseWithLlm(input.query, input.llm)
  } catch {
    return parsedNone(input.query)
  }
}

export const parseGraphExploreIntent = parseGraphQueryIntent
