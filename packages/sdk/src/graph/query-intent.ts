import { z } from 'zod/v4-mini'
import type { LLMProvider } from '../types/llm-provider.js'
import type { GraphQueryIntent, GraphQueryIntentPredicate, ParsedGraphQueryIntent } from '../types/graph-bridge.js'
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
  answerSide: z._default(z.enum(['source', 'target', 'either', 'none']), 'none'),
  subqueries: z._default(z.array(z.string()).check(z.maxLength(8)), []),
  mode: z._default(z.enum(['fact', 'relationship', 'summary', 'creative']), 'fact'),
})

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function cleanQueries(values: string[]): string[] {
  return unique(values.map(cleanText).filter(value => value.length > 0 && value.length <= 140))
}

function normalizePredicates(values: Array<{ name: string; confidence?: number | undefined }>): GraphQueryIntentPredicate[] {
  const byName = new Map<string, GraphQueryIntentPredicate>()
  for (const value of values) {
    const normalized = predicateNormalizer.normalizeWithDirection(value.name)
    if (!normalized.valid || !(ALL_PREDICATES as ReadonlySet<string>).has(normalized.predicate)) continue
    const confidence = typeof value.confidence === 'number'
      ? Math.max(0, Math.min(1, value.confidence))
      : 0.8
    const existing = byName.get(normalized.predicate)
    if (!existing || confidence > existing.confidence) {
      byName.set(normalized.predicate, {
        name: normalized.predicate,
        confidence,
        symmetric: normalized.symmetric,
      })
    }
  }
  return [...byName.values()]
}

function emptyIntent(query: string): GraphQueryIntent {
  return {
    rawQuery: query,
    sourceEntityQueries: [],
    targetEntityQueries: [],
    predicates: [],
    answerSide: 'none',
    subqueries: [],
    mode: 'fact',
  }
}

function parsedNone(query: string): ParsedGraphQueryIntent {
  return {
    parser: 'none',
    fallbackUsed: false,
    intent: emptyIntent(query),
  }
}

function buildIntent(query: string, raw: z.infer<typeof intentSchema>): GraphQueryIntent {
  return {
    rawQuery: query,
    sourceEntityQueries: cleanQueries(raw.sourceEntityQueries),
    targetEntityQueries: cleanQueries(raw.targetEntityQueries),
    predicates: normalizePredicates(raw.predicates),
    answerSide: raw.answerSide,
    subqueries: cleanQueries(raw.subqueries),
    mode: raw.mode,
  }
}

async function parseWithLlm(query: string, llm: LLMProvider): Promise<ParsedGraphQueryIntent> {
  const prompt = [
    'Parse this user query into graph-native retrieval intent.',
    '',
    `Query: ${query}`,
    '',
    'Return JSON only with this exact shape:',
    '{ "sourceEntityQueries": string[], "targetEntityQueries": string[], "predicates": [{ "name": string, "confidence": number }], "answerSide": "source" | "target" | "either" | "none", "subqueries": string[], "mode": "fact" | "relationship" | "summary" | "creative" }',
    '',
    'Definitions:',
    '- sourceEntityQueries: entity names expected on the stored edge source side.',
    '- targetEntityQueries: entity names expected on the stored edge target side.',
    '- predicates: ontology predicates the graph edge must match. Use canonical predicates only.',
    '- answerSide: which edge endpoint is being asked for. Use "source" when asking who/what points to a known target; "target" when asking who/what a known source points to; "either" for symmetric relationships; "none" when no endpoint answer is requested.',
    '- subqueries: short natural-language searches that can help retrieve supporting passages. Keep them grounded in the original question.',
    '- mode: fact for direct fact lookup, relationship for relationship listings, summary for summarization, creative for creative/genre tasks.',
    '',
    'Critical rules:',
    '- Do not infer extra predicates because nearby facts might exist. Only include predicates needed by the question.',
    '- Preserve edge direction. "Who killed Chaacmol?" means targetEntityQueries=["Chaacmol"], predicates=["KILLED"], answerSide="source".',
    '- Preserve active direction. "Who did Aac kill?" means sourceEntityQueries=["Aac"], predicates=["KILLED"], answerSide="target".',
    '- Spouse, husband, wife, and married questions use MARRIED, never HUSBAND_OF or WIFE_OF.',
    '- Parent/father/mother/ancestor questions use PARENT_OF when asking for parents of a known child.',
    '- Child/son/daughter questions use CHILD_OF when asking for children of a known parent.',
    '- Brother/sister/sibling questions use SIBLING_OF.',
    '- If the query does not specify a graph relationship, leave predicates empty and use source/target queries only if explicit entities are present.',
    '',
    'Examples:',
    '- "Who are Chaacmol parents?" -> {"sourceEntityQueries":[],"targetEntityQueries":["Chaacmol"],"predicates":[{"name":"PARENT_OF","confidence":0.98}],"answerSide":"source","subqueries":["Chaacmol parents","Chaacmol father mother ancestor"],"mode":"fact"}',
    '- "Who killed Chaacmol?" -> {"sourceEntityQueries":[],"targetEntityQueries":["Chaacmol"],"predicates":[{"name":"KILLED","confidence":0.98}],"answerSide":"source","subqueries":["who killed Chaacmol"],"mode":"fact"}',
    '- "Who did Aac kill?" -> {"sourceEntityQueries":["Aac"],"targetEntityQueries":[],"predicates":[{"name":"KILLED","confidence":0.98}],"answerSide":"target","subqueries":["Aac killed"],"mode":"fact"}',
    '- "Who is Chaacmol wife?" -> {"sourceEntityQueries":["Chaacmol"],"targetEntityQueries":[],"predicates":[{"name":"MARRIED","confidence":0.98}],"answerSide":"target","subqueries":["Chaacmol wife spouse married"],"mode":"fact"}',
    '- "Summarize the relationship between Aac and Chaacmol" -> {"sourceEntityQueries":["Aac"],"targetEntityQueries":["Chaacmol"],"predicates":[],"answerSide":"either","subqueries":["Aac Chaacmol relationship"],"mode":"summary"}',
    '',
    'Valid predicate vocabulary:',
    getPredicatesForPrompt(),
  ].join('\n')

  const raw = await llm.generateJSON<z.infer<typeof intentSchema>>(prompt, undefined, {
    schema: intentSchema,
    maxOutputTokens: 1024,
  })
  const parsed = intentSchema.parse(raw)
  const intent = buildIntent(query, parsed)
  if (
    intent.sourceEntityQueries.length === 0 &&
    intent.targetEntityQueries.length === 0 &&
    intent.predicates.length === 0 &&
    intent.subqueries.length === 0
  ) {
    return parsedNone(query)
  }

  return {
    parser: 'llm',
    fallbackUsed: false,
    intent,
  }
}

export async function parseGraphQueryIntent(input: {
  query: string
  llm?: LLMProvider | undefined
}): Promise<ParsedGraphQueryIntent> {
  if (!input.llm) return parsedNone(input.query)
  try {
    return await parseWithLlm(input.query, input.llm)
  } catch {
    return parsedNone(input.query)
  }
}

export const parseGraphExploreIntent = parseGraphQueryIntent
