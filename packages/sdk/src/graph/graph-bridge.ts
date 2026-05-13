import { createHash } from 'crypto'
import type { Embedder } from '../embedding/provider.js'
import { embedText, embedTexts } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { AccessScope, typegraphIdentity } from '../types/identity.js'
import type { EmbeddingConfig } from '../types/bucket.js'
import type { LLMConfig, LLMProvider } from '../types/llm-provider.js'
import type { CompiledOntology } from '../types/ontology.js'
import type { KnowledgeGraphBridge, EntityDetail, EntityResult, EdgeResult, FactChainResult, FactRelevanceFilter, FactResult, InternalFactSearchOpts, InternalGraphExploreOpts, GraphExploreResult, GraphExploreTrace, GraphBackfillOpts, GraphBackfillResult, InternalGraphExplainOpts, GraphSearchOpts, GraphSearchResult, GraphSearchTrace, ChunkResult, SubgraphOpts, SubgraphResult, GraphStats, GraphQueryIntent, GraphEntityRef, UpsertGraphEdgeInput, UpsertGraphEntityInput, UpsertGraphFactInput, EntityScopeResolution, KnowledgeSearchOpts, KnowledgeSearchResult, MergeGraphEntitiesInput, MergeGraphEntitiesResult, DeleteGraphEntityOpts, DeleteGraphEntityResult } from '../types/graph-bridge.js'
import { resolveEmbedder, resolveLLMProvider } from '../typegraph.js'
import type { ExternalId, MemoryStoreAdapter, SemanticEdge, SemanticEntity, SemanticEntityMention, SemanticEntityChunkEdge, SemanticFactRecord, SemanticGraphEdge } from '../memory/types/index.js'
import type { ChunkRef } from '../types/chunk.js'
import { ConfigError, GraphSelfEdgeError } from '../types/errors.js'
import { EntityResolver, createTemporal } from '../memory/index.js'
import { EmbeddedGraph } from './graph/embedded-graph.js'
import { parseGraphQueryIntent } from './query-intent.js'
import { generateId } from '../utils/id.js'
import {
  buildFactSearchText,
  formatFactEvidence,
} from './retrieval-primitives.js'
import { optionalCompactObject, requiredObject } from '../utils/input.js'
import { isSymmetricPredicate } from '../memory/extraction/predicate-normalizer.js'
import {
  ALIAS_ASSIGNMENT_CUES,
  DEFAULT_ONTOLOGY,
  DEFAULT_ENTITY_TYPE,
  GENERIC_DISALLOWED_PREDICATES,
  effectiveEntityTypes,
  normalizePredicateWithDirection,
  normalizeTypeCandidates,
  sanitizePredicate,
  validatePredicateEffectiveTypes,
  type PredicateTemporalStatus,
  type TypeCandidate,
} from '../index-engine/ontology.js'

type ScopedGraphEntityInput = UpsertGraphEntityInput & typegraphIdentity & { accessScope?: AccessScope | undefined }
type ScopedGraphEntityRef = GraphEntityRef & typegraphIdentity & { accessScope?: AccessScope | undefined }
type ScopedGraphEdgeInput = UpsertGraphEdgeInput & typegraphIdentity & { accessScope?: AccessScope | undefined }
type ScopedGraphFactInput = UpsertGraphFactInput & typegraphIdentity & { accessScope?: AccessScope | undefined }

// ── Config ──

export interface CreateKnowledgeGraphBridgeConfig {
  memoryStore: MemoryStoreAdapter
  /** Embedder — pass a resolved Embedder or an AI SDK embedding input ({ model, dimensions }). */
  embedding: EmbeddingConfig
  /** Default scope for addTriple (which has no per-call identity). */
  scope?: typegraphIdentity
  /**
   * Resolves an embedding model key to the Postgres chunks table that holds
   * its embeddings. Required for heterogeneous graph retrieval over chunks.
   * Typically wired to `vectorAdapter.getTable(model)`.
   */
  resolveChunksTable?: (model: string) => string | Promise<string>
  factRelevanceFilter?: FactRelevanceFilter | undefined
  explorationLlm?: LLMConfig | undefined
  resolveOntology?: (graphId?: string) => CompiledOntology
}

function normalizeSurfaceText(value: string): string {
  return value
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function stableGraphId(prefix: string, parts: Array<string | number | undefined>): string {
  const hash = createHash('sha256')
    .update(parts.map(part => part ?? '').join('\u001f'))
    .digest('hex')
    .slice(0, 32)
  return `${prefix}_${hash}`
}

function mergeScope(defaultScope: typegraphIdentity, override?: typegraphIdentity): typegraphIdentity {
  return {
    tenantId: override?.tenantId ?? defaultScope.tenantId,
    organizationId: override?.organizationId ?? defaultScope.organizationId,
    groupId: override?.groupId ?? defaultScope.groupId,
    userId: override?.userId ?? defaultScope.userId,
    agentId: override?.agentId ?? defaultScope.agentId,
    threadId: override?.threadId ?? defaultScope.threadId,
    graphId: override?.graphId ?? defaultScope.graphId,
    graphIds: override?.graphIds ?? defaultScope.graphIds,
  }
}

function chunkNodeIdFor(input: ChunkRef): string {
  return input.chunkId ?? stableGraphId('chunk', [
    input.bucketId,
    input.documentId,
    input.chunkIndex,
    input.embeddingModel,
  ])
}

function relationToPhrase(relation: string): string {
  return relation.toLowerCase().replace(/_/g, ' ')
}

function factTextFor(sourceName: string, relation: string, targetName: string): string {
  return `${sourceName} ${relationToPhrase(relation)} ${targetName}`
}

function cleanOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned : undefined
}

function isGraphSelfEdgeError(error: unknown): error is GraphSelfEdgeError {
  return error instanceof GraphSelfEdgeError
    || (error instanceof Error && (error as { code?: unknown }).code === 'GRAPH_SELF_EDGE')
}

function describeEntityRef(ref: GraphEntityRef | string): Record<string, unknown> {
  if (typeof ref === 'string') return { id: ref }
  return optionalCompactObject({
    id: ref.id,
    name: ref.name,
    entityType: ref.entityType,
    externalId: ref.externalId,
    externalIds: ref.externalIds,
  }, 'graph.selfEdge.ref') as Record<string, unknown>
}

function isAliasAssignmentRelation(predicate: string): boolean {
  return ALIAS_ASSIGNMENT_CUES.has(sanitizePredicate(predicate))
}

function propertyString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return cleanOptionalText(metadata?.[key])
}

function typeCandidatesFromMetadata(metadata: Record<string, unknown> | undefined): TypeCandidate[] {
  const raw = metadata?.typeCandidates ?? metadata?.semanticTypes
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => {
      if (!item || typeof item !== 'object') return undefined
      const candidate = item as Record<string, unknown>
      if (typeof candidate.type !== 'string' || typeof candidate.confidence !== 'number') return undefined
      return { type: candidate.type, confidence: candidate.confidence }
    })
    .filter((item): item is TypeCandidate => !!item)
}

function effectiveTypesForEntity(entity: SemanticEntity, ontology?: CompiledOntology): string[] {
  return effectiveEntityTypes(entity.entityType, typeCandidatesFromMetadata(entity.metadata), 0.6, ontology)
}

function factSentenceForProfile(
  entityName: string,
  relatedName: string,
  relation: string,
  direction: 'out' | 'in',
): string {
  const sentence = direction === 'out'
    ? factTextFor(entityName, relation, relatedName)
    : factTextFor(relatedName, relation, entityName)
  return sentence.endsWith('.') ? sentence : `${sentence}.`
}

function normalizeSeedScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function buildEntityMentions(input: {
  tenantId?: string | undefined
  graphId?: string | undefined
  organizationId?: string | undefined
  entityId: string
  documentId: string
  chunkIndex: number
  bucketId: string
  mentionType: SemanticEntityMention['mentionType']
  confidence?: number | undefined
  names: string[]
  aliases: string[]
}): SemanticEntityMention[] {
  const rows: SemanticEntityMention[] = []
  const seen = new Set<string>()

  const add = (surfaceText: string, mentionType: SemanticEntityMention['mentionType']) => {
    const trimmed = surfaceText.trim()
    if (!trimmed) return
    const normalizedSurfaceText = normalizeSurfaceText(trimmed)
    const key = `${mentionType}:${normalizedSurfaceText}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      tenantId: input.tenantId,
      graphId: input.graphId,
      organizationId: input.organizationId,
      entityId: input.entityId,
      documentId: input.documentId,
      chunkIndex: input.chunkIndex,
      bucketId: input.bucketId,
      mentionType,
      surfaceText: trimmed,
      normalizedSurfaceText,
      confidence: input.confidence,
    })
  }

  for (const name of input.names) add(name, input.mentionType)
  for (const alias of input.aliases) add(alias, 'alias')
  return rows
}

function buildEntityChunkGraphEdge(input: {
  entityId: string
  chunkRef: ChunkRef
  relation?: string | undefined
  weight: number
  mentionCount: number
  confidence?: number | undefined
  surfaceTexts: string[]
  mentionTypes: SemanticEntityMention['mentionType'][]
  scope: typegraphIdentity
  accessScope?: AccessScope | undefined
}): SemanticGraphEdge {
  const chunkId = chunkNodeIdFor(input.chunkRef)
  return {
    id: stableGraphId('edge', ['entity', input.entityId, input.relation ?? 'MENTIONED_IN', 'chunk', chunkId]),
    sourceType: 'entity',
    sourceId: input.entityId,
    targetType: 'chunk',
    targetId: chunkId,
    relation: input.relation ?? 'MENTIONED_IN',
    weight: input.weight,
    metadata: {
      mentionCount: input.mentionCount,
      confidence: input.confidence,
      surfaceTexts: input.surfaceTexts,
      mentionTypes: input.mentionTypes,
    },
    scope: input.scope,
    accessScope: input.accessScope,
    temporal: createTemporal(),
    evidence: [],
    targetChunkRef: input.chunkRef,
  }
}

// ── Knowledge Graph Bridge Factory ──

/**
 * Create a KnowledgeGraphBridge for entity-relationship graph storage and PPR-based retrieval.
 * Independent of conversational memory — does not create TypegraphMemory instances.
 */
export function createKnowledgeGraphBridge(config: CreateKnowledgeGraphBridgeConfig): KnowledgeGraphBridge {
  const { memoryStore } = config
  const embedding: Embedder = resolveEmbedder(config.embedding)
  const explorationLlm: LLMProvider | undefined = config.explorationLlm
    ? resolveLLMProvider(config.explorationLlm)
    : undefined
  const defaultScope: typegraphIdentity = config.scope ?? { agentId: 'typegraph-graph' }

  const graph = new EmbeddedGraph(memoryStore)
  const resolver = new EntityResolver({ store: memoryStore, embedding })

  function ontologyForGraph(graphId?: string): CompiledOntology {
    return config.resolveOntology?.(graphId) ?? DEFAULT_ONTOLOGY
  }

  function uniqueIds(ids: string[]): string[] {
    return [...new Set(ids)]
  }

  const QUERY_STOP_WORDS = new Set([
    'the', 'and', 'that', 'this', 'with', 'from', 'into', 'about', 'what', 'which',
    'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'did', 'does', 'are',
    'was', 'were', 'is', 'in', 'on', 'of', 'to', 'for', 'by', 'as', 'a', 'an',
    'including', 'include', 'relation', 'relationship', 'novel', 'narrative',
  ])

  function queryTokens(query: string): Set<string> {
    const normalized = normalizeSurfaceText(query)
    return new Set(normalized.split(/\s+/).filter(token => token.length >= 3 && !QUERY_STOP_WORDS.has(token)))
  }

  function tokenOverlapScore(queryTokenSet: Set<string>, text: string): number {
    if (queryTokenSet.size === 0) return 0
    const textTokens = new Set(normalizeSurfaceText(text).split(/\s+/).filter(Boolean))
    let hits = 0
    for (const token of queryTokenSet) {
      if (textTokens.has(token)) hits++
    }
    return hits / Math.max(1, queryTokenSet.size)
  }

  function entityAnchorScore(queryTokenSet: Set<string>, fact: SemanticFactRecord, entityNameById: Map<string, string>): number {
    const sourceName = entityNameById.get(fact.sourceEntityId) ?? ''
    const targetName = entityNameById.get(fact.targetEntityId) ?? ''
    return Math.max(
      tokenOverlapScore(queryTokenSet, sourceName),
      tokenOverlapScore(queryTokenSet, targetName),
    )
  }

  function relationRelevanceScore(queryTokenSet: Set<string>, relation: string): number {
    return tokenOverlapScore(queryTokenSet, relationToPhrase(relation))
  }

  function rerankFactRecords(
    facts: SemanticFactRecord[],
    query: string,
    entityNameById: Map<string, string>,
  ): SemanticFactRecord[] {
    const tokens = queryTokens(query)
    const seenCanonical = new Map<string, number>()
    return facts
      .map((fact, index) => {
        const searchableText = fact.description ?? fact.evidenceText ?? ''
        const lexical = tokenOverlapScore(tokens, searchableText)
        const entityAnchor = entityAnchorScore(tokens, fact, entityNameById)
        const relation = relationRelevanceScore(tokens, fact.relation)
        const semantic = normalizeSeedScore(fact.similarity ?? 0)
        const canonical = normalizeSurfaceText(`${fact.sourceEntityId}:${fact.relation}:${fact.targetEntityId}:${searchableText}`)
        const duplicateCount = seenCanonical.get(canonical) ?? 0
        seenCanonical.set(canonical, duplicateCount + 1)
        const duplicatePenalty = duplicateCount * 0.2
        const score =
          semantic * 0.45 +
          lexical * 0.28 +
          entityAnchor * 0.22 +
          relation * 0.05 -
          duplicatePenalty
        return { fact, index, score }
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => ({
        ...item.fact,
        metadata: {
          ...(item.fact as unknown as { metadata?: Record<string, unknown> }).metadata,
          relevanceScore: item.score,
        },
      }) as SemanticFactRecord)
  }

  function buildFactChains(facts: FactResult[], limit: number): FactChainResult[] {
    if (facts.length < 2 || limit <= 0) return []
    const candidates: FactChainResult[] = []
    const top = facts.slice(0, 16)
    for (let i = 0; i < top.length; i++) {
      for (let j = 0; j < top.length; j++) {
        if (i === j) continue
        const a = top[i]!
        const b = top[j]!
        const shared = sharedFactEntity(a, b)
        if (!shared) continue
        candidates.push({
          facts: [a, b],
          content: `${formatFactEvidence(a)}; ${formatFactEvidence(b)}`,
          score: factResultScore(a) + factResultScore(b) + shared.bonus,
          entityIds: uniqueIds([a.sourceEntityId, a.targetEntityId, b.sourceEntityId, b.targetEntityId]),
        })
      }
    }
    const seen = new Set<string>()
    return candidates
      .sort((a, b) => b.score - a.score)
      .filter(chain => {
        const key = normalizeSurfaceText(chain.content)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, limit)
  }

  function sharedFactEntity(a: FactResult, b: FactResult): { id: string; bonus: number } | null {
    const checks: Array<[string, string, number]> = [
      [a.targetEntityId, b.sourceEntityId, 1.5],
      [a.sourceEntityId, b.targetEntityId, 1.25],
      [a.sourceEntityId, b.sourceEntityId, 0.5],
      [a.targetEntityId, b.targetEntityId, 0.5],
    ]
    for (const [left, right, bonus] of checks) {
      if (left === right) return { id: left, bonus }
    }
    return null
  }

  function factResultScore(fact: FactResult): number {
    const relevance = fact.metadata?.relevanceScore
    if (typeof relevance === 'number' && Number.isFinite(relevance)) return relevance
    if (typeof fact.similarity === 'number' && Number.isFinite(fact.similarity)) return fact.similarity
    const explore = fact.metadata?.exploreScore
    if (typeof explore === 'number' && Number.isFinite(explore)) return explore
    return fact.weight
  }

  function textMentionsDirectionalContradiction(input: {
    relation: string
    sourceName: string
    targetName: string
    description?: string | undefined
    evidenceText?: string | undefined
  }): boolean {
    const text = normalizeSurfaceText([input.description, input.evidenceText].filter(Boolean).join(' '))
    if (!text) return false
    const source = normalizeSurfaceText(input.sourceName)
    const target = normalizeSurfaceText(input.targetName)
    if (!source || !target) return false

    if (input.relation === 'KILLED') {
      const targetKilledBySource = new RegExp(`\\b${target}\\b.{0,40}\\b(?:killed|murdered|assassinated|stabbed|slain)\\b.{0,20}\\bby\\b.{0,40}\\b${source}\\b`)
      if (targetKilledBySource.test(text)) return false
      const targetKilledSource = new RegExp(`\\b${target}\\b.{0,40}\\b(?:killed|murdered|assassinated|stabbed|slew|slain)\\b.{0,40}\\b${source}\\b`)
      const sourceKilledByTarget = new RegExp(`\\b${source}\\b.{0,40}\\b(?:killed|murdered|assassinated|stabbed|slain)\\b.{0,20}\\bby\\b.{0,40}\\b${target}\\b`)
      return targetKilledSource.test(text) || sourceKilledByTarget.test(text)
    }

    if (input.relation === 'PARENT_OF') {
      const sourceChildOfTarget = new RegExp(`\\b${source}\\b.{0,30}\\b(?:child|son|daughter|born)\\b.{0,20}\\b(?:of|to)\\b.{0,30}\\b${target}\\b`)
      return sourceChildOfTarget.test(text)
    }

    if (input.relation === 'CHILD_OF') {
      const sourceParentOfTarget = new RegExp(`\\b${source}\\b.{0,30}\\b(?:parent|father|mother)\\b.{0,20}\\bof\\b.{0,30}\\b${target}\\b`)
      return sourceParentOfTarget.test(text)
    }

    return false
  }

  function requestedLimit(value: number | undefined): number | undefined {
    return value === undefined ? undefined : Math.max(0, value)
  }

  function applyRequestedLimit<T>(items: T[], limit: number | undefined): T[] {
    return limit === undefined ? items : items.slice(0, limit)
  }

  function intentPredicateSet(intent: GraphQueryIntent): Set<string> {
    return new Set(intent.predicates.map(predicate => predicate.name))
  }

  function intentAnchorQueries(intent: GraphQueryIntent): string[] {
    return uniqueIds([
      ...intent.sourceEntityQueries,
      ...intent.targetEntityQueries,
    ].map(query => query.trim()).filter(Boolean))
  }

  function intentSearchText(intent: GraphQueryIntent, fallbackQuery: string): string {
    return uniqueIds([
      fallbackQuery,
      ...intent.subqueries,
      ...intent.sourceEntityQueries,
      ...intent.targetEntityQueries,
      ...intent.predicates.map(predicate => relationToPhrase(predicate.name)),
    ]).join('\n')
  }

  function chunkIntentSearchText(intent: GraphQueryIntent, fallbackQuery: string): string {
    return uniqueIds([
      fallbackQuery,
      ...intent.sourceEntityQueries,
      ...intent.targetEntityQueries,
    ]).join('\n')
  }

  function graphIntentIsEmpty(intent: GraphQueryIntent): boolean {
    return (
      intent.sourceEntityQueries.length === 0 &&
      intent.targetEntityQueries.length === 0 &&
      intent.predicates.length === 0 &&
      intent.subqueries.length === 0 &&
      intent.strictness === 'none'
    )
  }

  function uniqueEntityResults(entities: EntityResult[]): EntityResult[] {
    const byId = new Map<string, EntityResult>()
    for (const entity of entities) {
      const existing = byId.get(entity.id)
      if (!existing || (entity.similarity ?? 0) > (existing.similarity ?? 0)) {
        byId.set(entity.id, entity)
      }
    }
    return [...byId.values()]
  }

  async function resolveIntentAnchors(
    intent: GraphQueryIntent,
    identity: typegraphIdentity,
    limit: number,
  ): Promise<{
    sourceAnchors: EntityResult[]
    targetAnchors: EntityResult[]
    anchors: EntityResult[]
    sourceAnchorIds: Set<string>
    targetAnchorIds: Set<string>
  }> {
    const [sourceAnchors, targetAnchors] = await Promise.all([
      collectEntityCandidates(intent.sourceEntityQueries, identity, limit, { stopOnStrongMatch: true }),
      collectEntityCandidates(intent.targetEntityQueries, identity, limit, { stopOnStrongMatch: true }),
    ])
    const anchors = uniqueEntityResults([...sourceAnchors, ...targetAnchors])
    return {
      sourceAnchors,
      targetAnchors,
      anchors,
      sourceAnchorIds: new Set(sourceAnchors.map(anchor => anchor.id)),
      targetAnchorIds: new Set(targetAnchors.map(anchor => anchor.id)),
    }
  }

  function edgeMatchesIntent(input: {
    sourceEntityId: string
    targetEntityId: string
    relation: string
    intent: GraphQueryIntent
    sourceAnchorIds: Set<string>
    targetAnchorIds: Set<string>
  }): { match: boolean; reason?: 'predicate' | 'direction' | undefined } {
    const selectedPredicates = intentPredicateSet(input.intent)
    if (selectedPredicates.size > 0 && !selectedPredicates.has(input.relation)) {
      return { match: false, reason: 'predicate' }
    }

    const hasSourceAnchors = input.sourceAnchorIds.size > 0
    const hasTargetAnchors = input.targetAnchorIds.size > 0
    if (!hasSourceAnchors && !hasTargetAnchors) {
      return { match: false, reason: 'direction' }
    }

    const symmetric = isSymmetricPredicate(input.relation)
    const sourceMatchesSource = input.sourceAnchorIds.has(input.sourceEntityId)
    const targetMatchesSource = input.sourceAnchorIds.has(input.targetEntityId)
    const sourceMatchesTarget = input.targetAnchorIds.has(input.sourceEntityId)
    const targetMatchesTarget = input.targetAnchorIds.has(input.targetEntityId)

    if (hasSourceAnchors && hasTargetAnchors) {
      if (symmetric) {
        const direct = sourceMatchesSource && targetMatchesTarget
        const reverse = targetMatchesSource && sourceMatchesTarget
        return direct || reverse ? { match: true } : { match: false, reason: 'direction' }
      }
      return sourceMatchesSource && targetMatchesTarget
        ? { match: true }
        : { match: false, reason: 'direction' }
    }

    if (hasSourceAnchors) {
      return symmetric
        ? (sourceMatchesSource || targetMatchesSource ? { match: true } : { match: false, reason: 'direction' })
        : (sourceMatchesSource ? { match: true } : { match: false, reason: 'direction' })
    }

    return symmetric
      ? (sourceMatchesTarget || targetMatchesTarget ? { match: true } : { match: false, reason: 'direction' })
      : (targetMatchesTarget ? { match: true } : { match: false, reason: 'direction' })
  }

  function factMatchesIntent(fact: SemanticFactRecord, input: {
    intent: GraphQueryIntent
    sourceAnchorIds: Set<string>
    targetAnchorIds: Set<string>
  }): { match: boolean; reason?: 'predicate' | 'direction' | undefined } {
    return edgeMatchesIntent({
      sourceEntityId: fact.sourceEntityId,
      targetEntityId: fact.targetEntityId,
      relation: fact.relation,
      intent: input.intent,
      sourceAnchorIds: input.sourceAnchorIds,
      targetAnchorIds: input.targetAnchorIds,
    })
  }

  async function hydrateEntityResults(
    semanticEntities: SemanticEntity[],
    similarityById?: Map<string, number>,
    identity?: typegraphIdentity,
  ): Promise<EntityResult[]> {
    const resultIds = uniqueIds(semanticEntities.map(entity => entity.id))
    const edgeIdsByEntity = new Map<string, Set<string>>()
    for (const id of resultIds) edgeIdsByEntity.set(id, new Set())

    if (resultIds.length > 0) {
      const edges = await graph.getEdgesBatch(resultIds, 'both', identity)
      for (const edge of edges) {
        edgeIdsByEntity.get(edge.sourceEntityId)?.add(edge.id)
        edgeIdsByEntity.get(edge.targetEntityId)?.add(edge.id)
      }
    }

    return semanticEntities.map(entity => {
      const metadata = { ...entity.metadata }
      const inlineSimilarity = typeof metadata._similarity === 'number' ? metadata._similarity : undefined
      delete metadata._similarity

      return {
        id: entity.id,
        name: entity.name,
        entityType: entity.entityType,
        aliases: entity.aliases,
        externalIds: entity.externalIds,
        ...(typeof (similarityById?.get(entity.id) ?? inlineSimilarity) === 'number'
          ? { similarity: similarityById?.get(entity.id) ?? inlineSimilarity }
          : {}),
        edgeCount: edgeIdsByEntity.get(entity.id)?.size ?? 0,
        metadata,
      }
    })
  }

  async function hydrateEntityResultsById(
    entityIds: string[],
    similarityById?: Map<string, number>,
    identity?: typegraphIdentity,
  ): Promise<EntityResult[]> {
    if (entityIds.length === 0) return []
    const entities = await graph.getEntitiesBatch(uniqueIds(entityIds), identity)
    return hydrateEntityResults(entities, similarityById, identity)
  }

  function edgeResultFromSemanticEdge(edge: SemanticEdge, nameMap: Map<string, string>): EdgeResult {
    return {
      id: edge.id,
      sourceEntityId: edge.sourceEntityId,
      sourceEntityName: nameMap.get(edge.sourceEntityId) ?? edge.sourceEntityId,
      targetEntityId: edge.targetEntityId,
      targetEntityName: nameMap.get(edge.targetEntityId) ?? edge.targetEntityId,
      relation: edge.relation,
      weight: edge.weight,
      metadata: edge.metadata,
    }
  }

  function factResultFromEdge(
    edge: SemanticEdge,
    nameMap: Map<string, string>,
    score: number,
  ): FactResult {
    const sourceEntityName = nameMap.get(edge.sourceEntityId) ?? edge.sourceEntityId
    const targetEntityName = nameMap.get(edge.targetEntityId) ?? edge.targetEntityId
    const fallbackDescription = factTextFor(sourceEntityName, edge.relation, targetEntityName)
    const relationshipDescription = propertyString(edge.metadata, 'relationshipDescription')
      ?? propertyString(edge.metadata, 'description')
      ?? fallbackDescription
    const evidenceText = propertyString(edge.metadata, 'evidenceText')
    const description = buildFactSearchText({ description: relationshipDescription, evidenceText })
    return {
      id: stableGraphId('fact', [edge.sourceEntityId, edge.relation, edge.targetEntityId]),
      edgeId: edge.id,
      sourceEntityId: edge.sourceEntityId,
      sourceEntityName,
      targetEntityId: edge.targetEntityId,
      targetEntityName,
      relation: edge.relation,
      description: description || relationshipDescription,
      evidenceText,
      chunkId: propertyString(edge.metadata, 'chunkId'),
      weight: edge.weight,
      metadata: {
        ...(score > 0 ? { exploreScore: score } : {}),
      },
    }
  }

  // Track entities per chunk for co-occurrence edge creation
  const chunkEntityMap = new Map<string, Set<string>>()
  const directEdgePairs = new Set<string>()

  function scopeFrom(input?: typegraphIdentity): typegraphIdentity {
    return mergeScope(defaultScope, {
      tenantId: input?.tenantId,
      organizationId: input?.organizationId,
      groupId: input?.groupId,
      userId: input?.userId,
      agentId: input?.agentId,
      threadId: input?.threadId,
      graphId: input?.graphId,
      graphIds: input?.graphIds,
    })
  }

  function mergeSeedScope(parent: typegraphIdentity | undefined, child?: typegraphIdentity): typegraphIdentity {
    return mergeScope(parent ? scopeFrom(parent) : defaultScope, {
      tenantId: child?.tenantId,
      organizationId: child?.organizationId,
      groupId: child?.groupId,
      userId: child?.userId,
      agentId: child?.agentId,
      threadId: child?.threadId,
      graphId: child?.graphId,
      graphIds: child?.graphIds,
    })
  }

  function normalizeExternalId(input: ExternalId | null | undefined): ExternalId | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    if (typeof input.type !== 'string' || typeof input.id !== 'string') return undefined
    const type = input.type.trim().toLowerCase()
    const id = normalizeExternalIdValue(input.id, type, input.encoding ?? 'none')
    if (!id || !type) return undefined
    return {
      ...input,
      id,
      type,
      encoding: input.encoding ?? 'none',
    }
  }

  function normalizeExternalIdValue(id: string, type: string, encoding: ExternalId['encoding']): string {
    const trimmed = id.trim()
    if (encoding === 'sha256') return trimmed.toLowerCase()
    if (type === 'email' || type.endsWith('_email') || type === 'github_handle') return trimmed.toLowerCase()
    if (type === 'phone') return trimmed.replace(/[^\d+]/g, '')
    return trimmed
  }

  function externalIdKey(externalId: ExternalId): string {
    return [
      externalId.type.trim().toLowerCase(),
      externalId.id.trim(),
      externalId.encoding ?? 'none',
    ].join('|')
  }

  function normalizeExternalIds(externalIds: Array<ExternalId | null | undefined> | undefined): ExternalId[] {
    const byKey = new Map<string, ExternalId>()
    for (const externalId of externalIds ?? []) {
      const normalized = normalizeExternalId(externalId)
      if (!normalized) continue
      byKey.set(externalIdKey(normalized), normalized)
    }
    return [...byKey.values()]
  }

  function mergeExternalIds(
    existing: ExternalId[] | undefined,
    incoming: ExternalId[] | undefined,
  ): ExternalId[] | undefined {
    const merged = new Map<string, ExternalId>()
    for (const externalId of normalizeExternalIds(existing)) {
      merged.set(externalIdKey(externalId), externalId)
    }
    for (const externalId of normalizeExternalIds(incoming)) {
      merged.set(externalIdKey(externalId), externalId)
    }
    return merged.size > 0 ? [...merged.values()] : undefined
  }

  function refExternalIds(ref: GraphEntityRef): ExternalId[] {
    return normalizeExternalIds([
      ...(ref.externalId ? [ref.externalId] : []),
      ...(ref.externalIds ?? []),
    ])
  }

  async function findEntityByExternalIds(
    externalIds: ExternalId[],
    scope: typegraphIdentity,
  ): Promise<SemanticEntity | undefined> {
    if (!memoryStore.findEntityByExternalId || externalIds.length === 0) return undefined
    let found: SemanticEntity | undefined
    for (const externalId of externalIds) {
      const entity = await memoryStore.findEntityByExternalId(externalId, scope)
      if (!entity) continue
      if (found && found.id !== entity.id) {
        throw new Error(`External IDs resolve to multiple entities: ${found.id} and ${entity.id}`)
      }
      found = entity
    }
    return found
  }

  async function linkExternalIdsToEntity(
    entityId: string,
    externalIds: ExternalId[],
    scope: typegraphIdentity,
  ): Promise<void> {
    const normalized = normalizeExternalIds(externalIds)
    if (normalized.length === 0) return
    if (!memoryStore.upsertEntityExternalIds) {
      throw new Error('MemoryStoreAdapter does not support deterministic entity external IDs')
    }
    if (memoryStore.findEntityByExternalId) {
      for (const externalId of normalized) {
        const existing = await memoryStore.findEntityByExternalId(externalId, scope)
        if (existing && existing.id !== entityId) {
          throw new Error(
            `External ID ${externalId.type}:${externalId.id} is already linked to entity ${existing.id}`,
          )
        }
      }
    }
    await memoryStore.upsertEntityExternalIds(entityId, normalized, scope)
  }

  function entityResultFromSemanticEntity(entity: SemanticEntity, edgeCount: number): EntityDetail {
    return {
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
      aliases: entity.aliases,
      externalIds: entity.externalIds,
      edgeCount,
      metadata: entity.metadata,
      description: entity.metadata.description as string | undefined,
      createdAt: entity.temporal.createdAt,
      validAt: entity.temporal.validAt,
      invalidAt: entity.temporal.invalidAt,
      topEdges: [],
    }
  }

  async function upsertSeedEntity(input: UpsertGraphEntityInput): Promise<SemanticEntity> {
    const scopedInput = input as ScopedGraphEntityInput
    if (!input.name?.trim()) throw new Error('upsertEntity requires a non-empty name')
    const scope = scopeFrom(scopedInput)
    const externalIds = normalizeExternalIds(input.externalIds)
    let entity: SemanticEntity | undefined

    if (input.id) {
      entity = await graph.getEntity(input.id, scope) ?? undefined
      const externalMatch = await findEntityByExternalIds(externalIds, scope)
      if (externalMatch && externalMatch.id !== input.id) {
        throw new Error(`External IDs resolve to entity ${externalMatch.id}, not requested entity ${input.id}`)
      }
      entity = entity ?? externalMatch
    } else {
      entity = await findEntityByExternalIds(externalIds, scope)
    }

    if (entity) {
      entity = await resolver.merge(entity, {
        name: input.name,
        entityType: input.entityType ?? DEFAULT_ENTITY_TYPE,
        typeCandidates: input.typeCandidates,
        aliases: input.aliases ?? [],
        description: input.description,
        externalIds,
      })
    } else if (input.id || externalIds.length > 0) {
      const embeddingVector = await embedText(embedding, input.name)
      const descriptionEmbedding = input.description
        ? await embedText(embedding, input.description)
        : undefined
      entity = {
        id: input.id ?? generateId('ent'),
        name: input.name,
        entityType: input.entityType ?? DEFAULT_ENTITY_TYPE,
        aliases: input.aliases ?? [],
        externalIds,
        metadata: {
          ...(input.description ? { description: input.description } : {}),
          ...((input.typeCandidates?.length ?? 0) > 0 ? { typeCandidates: normalizeTypeCandidates(input.entityType, input.typeCandidates) } : {}),
        },
        embedding: embeddingVector,
        descriptionEmbedding,
        scope,
        accessScope: scopedInput.accessScope,
        temporal: createTemporal(),
      }
    } else {
      const resolved = await resolver.resolve(
        input.name,
        input.entityType ?? DEFAULT_ENTITY_TYPE,
        input.aliases ?? [],
        scope,
        input.description,
        scopedInput.accessScope,
        externalIds,
        input.typeCandidates,
      )
      entity = resolved.entity
    }

    entity = {
      ...entity,
      externalIds: mergeExternalIds(entity.externalIds, externalIds),
      metadata: {
        ...entity.metadata,
        ...((input.typeCandidates?.length ?? 0) > 0
          ? { typeCandidates: normalizeTypeCandidates(entity.entityType, [
            ...typeCandidatesFromMetadata(entity.metadata),
            ...input.typeCandidates!,
          ]) }
          : {}),
        ...(input.metadata ?? {}),
      },
      scope,
      accessScope: scopedInput.accessScope ?? entity.accessScope,
    }
    if (input.description && !entity.metadata.description) {
      entity.metadata.description = input.description
    }

    await graph.addEntity(entity)
    await linkExternalIdsToEntity(entity.id, externalIds, scope)
    return entity
  }

  async function resolveEntityForRead(
    ref: GraphEntityRef | string,
    identity?: typegraphIdentity,
  ): Promise<SemanticEntity | null> {
    const scope = scopeFrom(identity)
    if (typeof ref === 'string') return graph.getEntity(ref, scope)
    const refScope = mergeSeedScope(scope, ref as ScopedGraphEntityRef)
    if (ref.id) {
      const byId = await graph.getEntity(ref.id, refScope)
      if (byId) return byId
    }
    const byExternalId = await findEntityByExternalIds(refExternalIds(ref), refScope)
    if (byExternalId) return byExternalId
    if (!ref.name?.trim()) return null
    if (memoryStore.findEntities) {
      const candidates = await memoryStore.findEntities(ref.name, refScope, 10)
      return candidates.find(candidate =>
        candidate.name.toLowerCase() === ref.name!.toLowerCase()
        && (!ref.entityType || candidate.entityType === ref.entityType)
      ) ?? null
    }
    return null
  }

  async function resolveEntityForWrite(
    ref: GraphEntityRef | string,
    parentScope: typegraphIdentity,
    accessScope?: AccessScope,
  ): Promise<SemanticEntity> {
    if (typeof ref === 'string') {
      const entity = await graph.getEntity(ref, parentScope)
      if (entity) return entity
      return upsertSeedEntity({
        name: ref,
        entityType: DEFAULT_ENTITY_TYPE,
        tenantId: parentScope.tenantId,
        groupId: parentScope.groupId,
        userId: parentScope.userId,
        agentId: parentScope.agentId,
        threadId: parentScope.threadId,
        accessScope,
      } as ScopedGraphEntityInput)
    }
    const scopedRef = ref as ScopedGraphEntityRef
    const refScope = mergeSeedScope(parentScope, scopedRef)
    if (ref.id && !ref.name) {
      const existing = await graph.getEntity(ref.id, refScope)
      if (!existing) throw new Error(`Entity not found: ${ref.id}`)
      const externalIds = refExternalIds(ref)
      await linkExternalIdsToEntity(existing.id, externalIds, refScope)
      return { ...existing, externalIds: mergeExternalIds(existing.externalIds, externalIds) }
    }
    if (!ref.name?.trim()) {
      const resolved = await resolveEntityForRead(ref, refScope)
      if (!resolved) throw new Error('Entity reference requires id, externalId, or name')
      return resolved
    }
    return upsertSeedEntity({
      id: ref.id,
      name: ref.name,
      entityType: ref.entityType,
      typeCandidates: ref.typeCandidates,
      aliases: ref.aliases,
      description: ref.description,
      metadata: ref.metadata,
      externalIds: refExternalIds(ref),
      tenantId: refScope.tenantId,
      groupId: refScope.groupId,
      userId: refScope.userId,
      agentId: refScope.agentId,
      threadId: refScope.threadId,
      accessScope: scopedRef.accessScope ?? accessScope,
    } as ScopedGraphEntityInput)
  }

  async function upsertRelation(input: {
    source: GraphEntityRef | string
    target: GraphEntityRef | string
    relation: string
    scope: typegraphIdentity
    accessScope?: AccessScope | undefined
    weight?: number | undefined
    metadata?: Record<string, unknown> | undefined
    description?: string | undefined
    evidenceText?: string | undefined
    chunkId?: string | undefined
    temporalStatus?: PredicateTemporalStatus | undefined
    validFrom?: string | undefined
    validTo?: string | undefined
  }): Promise<{ edge: SemanticEdge; fact?: SemanticFactRecord | undefined; source: SemanticEntity; target: SemanticEntity }> {
    const ontology = ontologyForGraph(input.scope.graphId)
    const normalizedRelation = normalizePredicateWithDirection(input.relation, ontology)
    if (!normalizedRelation.valid || GENERIC_DISALLOWED_PREDICATES.has(normalizedRelation.predicate)) {
      throw new Error(`Invalid or too-generic graph relation: ${input.relation}`)
    }

    let sourceRef = input.source
    let targetRef = input.target
    if (normalizedRelation.swapSubjectObject) {
      ;[sourceRef, targetRef] = [targetRef, sourceRef]
    }
    let source = await resolveEntityForWrite(sourceRef, input.scope, input.accessScope)
    let target = await resolveEntityForWrite(targetRef, input.scope, input.accessScope)
    if (source.id === target.id) {
      throw new GraphSelfEdgeError({
        entityId: source.id,
        entityName: source.name,
        relation: normalizedRelation.predicate,
        sourceRef: describeEntityRef(sourceRef),
        targetRef: describeEntityRef(targetRef),
      })
    }

    const relation = normalizedRelation.predicate
    const typeValidation = validatePredicateEffectiveTypes(
      relation,
      effectiveTypesForEntity(source, ontology),
      effectiveTypesForEntity(target, ontology),
      ontology,
    )
    if (normalizedRelation.symmetric) {
      const sourceKey = normalizeSurfaceText(source.id || source.name)
      const targetKey = normalizeSurfaceText(target.id || target.name)
      if (sourceKey > targetKey) {
        ;[source, target] = [target, source]
      }
    }

    const relationshipDescription = cleanOptionalText(input.description)
    const evidenceText = cleanOptionalText(input.evidenceText)
    const chunkId = cleanOptionalText(input.chunkId)
    const temporalStatus = input.temporalStatus ?? normalizedRelation.temporalStatus
    const validFrom = cleanOptionalText(input.validFrom)
    const validTo = cleanOptionalText(input.validTo)
    const weight = (input.weight ?? 1) * (typeValidation.valid ? 1 : 0.85)
    const edge: SemanticEdge = {
      id: stableGraphId('edge', [source.id, relation, target.id]),
      sourceEntityId: source.id,
      targetEntityId: target.id,
      relation,
      weight,
      metadata: {
        ...(relationshipDescription ? { relationshipDescription } : {}),
        ...(evidenceText ? { evidenceText } : {}),
        ...(chunkId ? { chunkId } : {}),
        ...(temporalStatus ? { temporalStatus } : {}),
        ...(validFrom ? { validFrom } : {}),
        ...(validTo ? { validTo } : {}),
        ...(!typeValidation.valid ? { predicateValidation: typeValidation } : {}),
        ...(input.metadata ?? {}),
      },
      scope: input.scope,
      accessScope: input.accessScope,
      temporal: createTemporal(),
      evidence: [],
    }

    const storedEdge = await graph.addEdge(edge)
    let storedFact: SemanticFactRecord | undefined
    if (memoryStore.upsertFactRecord) {
      const fallbackDescription = cleanOptionalText(input.description) ?? factTextFor(source.name, relation, target.name)
      const description = buildFactSearchText({
        description: relationshipDescription ?? fallbackDescription,
        evidenceText,
      }) || fallbackDescription
      const factEmbedding = await embedText(embedding, description)
      storedFact = await memoryStore.upsertFactRecord({
        id: stableGraphId('fact', [storedEdge.sourceEntityId, storedEdge.relation, storedEdge.targetEntityId]),
        edgeId: storedEdge.id,
        sourceEntityId: storedEdge.sourceEntityId,
        targetEntityId: storedEdge.targetEntityId,
        relation: storedEdge.relation,
        description,
        evidenceText,
        chunkId,
        weight: storedEdge.weight,
        embedding: factEmbedding,
        scope: input.scope,
        accessScope: storedEdge.accessScope,
        createdAt: storedEdge.temporal.createdAt,
        updatedAt: new Date(),
        ...(storedEdge.temporal.invalidAt ? { invalidAt: storedEdge.temporal.invalidAt } : {}),
      })
    }

    if (memoryStore.upsertEntity) {
      await updateProfilesFromFact(source, target, storedEdge.relation, storedEdge.weight)
    }

    return { edge: storedEdge, fact: storedFact, source, target }
  }

  async function updateProfilesFromFact(
    source: SemanticEntity,
    target: SemanticEntity,
    relation: string,
    weight: number,
  ): Promise<void> {
    if (!memoryStore.upsertEntity) return

    const updateOne = async (
      entity: SemanticEntity,
      related: SemanticEntity,
      direction: 'out' | 'in',
    ) => {
      const metadata = { ...entity.metadata }
      const existingProfile = (typeof metadata.profile === 'object' && metadata.profile !== null)
        ? metadata.profile as Record<string, unknown>
        : {}
      const evidence = Array.isArray(existingProfile.evidence)
        ? existingProfile.evidence as Array<Record<string, unknown>>
        : []
      const nextEvidence = [
        {
          relation,
          relatedEntityId: related.id,
          relatedEntityName: related.name,
          relatedEntityType: related.entityType,
          direction,
          weight,
        },
        ...evidence.filter(item =>
          item.relation !== relation ||
          item.relatedEntityId !== related.id ||
          item.direction !== direction
        ),
      ].slice(0, 25)
      const relationPhrases = [...new Set(nextEvidence.map(item => relationToPhrase(String(item.relation))).filter(Boolean))]
      const summarySentences = [...new Set(nextEvidence.map(item =>
        factSentenceForProfile(
          entity.name,
          String(item.relatedEntityName),
          String(item.relation),
          String(item.direction) === 'in' ? 'in' : 'out',
        ),
      ))].slice(0, 2)

      metadata.profile = {
        ...existingProfile,
        summary: summarySentences.length > 0
          ? summarySentences.join(' ')
          : existingProfile.summary,
        domains: Array.isArray(existingProfile.domains) ? existingProfile.domains : [],
        recurringActivities: relationPhrases.slice(0, 10),
        evidenceCount: Math.max(Number(existingProfile.evidenceCount ?? 0), nextEvidence.length),
        confidence: Math.max(Number(existingProfile.confidence ?? 0), Math.min(1, weight)),
        updatedAt: new Date().toISOString(),
        evidence: nextEvidence,
      }

      if (!metadata.description && (metadata.profile as Record<string, unknown>).summary) {
        metadata.description = (metadata.profile as Record<string, unknown>).summary
      }

      await memoryStore.upsertEntity!({
        ...entity,
        metadata,
      })
    }

    await updateOne(source, target, 'out')
    await updateOne(target, source, 'in')
  }

  async function resolveAndStoreEntity(input: {
    name: string
    type?: string | undefined
    typeCandidates?: TypeCandidate[] | undefined
    aliases?: string[] | undefined
    description?: string | undefined
    bucketId: string
    documentId?: string | undefined
    chunkIndex?: number | undefined
    tenantId?: string | undefined
    organizationId?: string | undefined
    graphId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    threadId?: string | undefined
    accessScope?: AccessScope | undefined
    confidence?: number | undefined
    mentionType: SemanticEntityMention['mentionType']
  }): Promise<SemanticEntity> {
    const scope = mergeScope(defaultScope, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      graphId: input.graphId,
      groupId: input.groupId,
      userId: input.userId,
      agentId: input.agentId,
      threadId: input.threadId,
    })
    const ontology = ontologyForGraph(scope.graphId)
    const result = await resolver.resolve(
      input.name,
      input.type ?? DEFAULT_ENTITY_TYPE,
      input.aliases ?? [],
      scope,
      input.description,
      input.accessScope,
      [],
      input.typeCandidates,
      ontology,
    )

    await graph.addEntity(result.entity)

    if (memoryStore.upsertEntityChunkMentions && input.documentId && input.chunkIndex !== undefined) {
      const mentions = buildEntityMentions({
        tenantId: result.entity.scope.tenantId ?? 'public',
        graphId: result.entity.graphId ?? result.entity.scope.graphId ?? 'public',
        organizationId: result.entity.scope.organizationId,
        entityId: result.entity.id,
        documentId: input.documentId,
        chunkIndex: input.chunkIndex,
        bucketId: input.bucketId,
        mentionType: input.mentionType,
        confidence: input.confidence,
        names: [input.name, result.entity.name],
        aliases: input.aliases ?? [],
      })
      if (mentions.length > 0) await memoryStore.upsertEntityChunkMentions(mentions)
    }

    if (memoryStore.upsertGraphEdges && input.documentId && input.chunkIndex !== undefined) {
      const surfaceTexts = [input.name, result.entity.name, ...(input.aliases ?? [])]
        .map(value => value.trim())
        .filter(Boolean)
      const uniqueSurfaceTexts = [...new Map(surfaceTexts.map(value => [normalizeSurfaceText(value), value])).values()]
      await memoryStore.upsertGraphEdges([buildEntityChunkGraphEdge({
        entityId: result.entity.id,
        chunkRef: {
          bucketId: input.bucketId,
          documentId: input.documentId,
          chunkIndex: input.chunkIndex,
          embeddingModel: embeddingModelKey(embedding),
        },
        weight: Math.min(2, 0.5 + (input.confidence ?? 0.75)),
        mentionCount: Math.max(1, uniqueSurfaceTexts.length),
        confidence: input.confidence,
        surfaceTexts: uniqueSurfaceTexts,
        mentionTypes: [input.mentionType],
        scope,
        accessScope: input.accessScope,
      })])
    }

    return result.entity
  }

  async function addEntityMentions(mentions: Array<{
    name: string
    type?: string | undefined
    typeCandidates?: TypeCandidate[] | undefined
    aliases?: string[] | undefined
    description?: string | undefined
    content: string
    bucketId: string
    chunkIndex?: number | undefined
    documentId?: string | undefined
    tenantId?: string | undefined
    organizationId?: string | undefined
    graphId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    threadId?: string | undefined
    accessScope?: AccessScope | undefined
    metadata?: Record<string, unknown> | undefined
    confidence?: number | undefined
  }>): Promise<void> {
    for (const mention of mentions) {
      if (!mention.name?.trim()) continue
      await resolveAndStoreEntity({
        name: mention.name,
        type: mention.type,
        typeCandidates: mention.typeCandidates,
        aliases: mention.aliases,
        description: mention.description,
        bucketId: mention.bucketId,
        documentId: mention.documentId,
        chunkIndex: mention.chunkIndex,
        tenantId: mention.tenantId,
        organizationId: mention.organizationId,
        graphId: mention.graphId,
        groupId: mention.groupId,
        userId: mention.userId,
        agentId: mention.agentId,
        threadId: mention.threadId,
        accessScope: mention.accessScope,
        confidence: mention.confidence,
        mentionType: 'entity',
      })
    }
  }

  async function addTriple(triple: {
    subject: string
    subjectType?: string
    subjectTypeCandidates?: TypeCandidate[] | undefined
    subjectAliases?: string[]
    subjectDescription?: string | undefined
    predicate: string
    object: string
    objectType?: string
    objectTypeCandidates?: TypeCandidate[] | undefined
    objectAliases?: string[]
    objectDescription?: string | undefined
    relationshipDescription?: string | undefined
    evidenceText?: string | undefined
    temporalStatus?: PredicateTemporalStatus | undefined
    validFrom?: string | undefined
    validTo?: string | undefined
    chunkId?: string | undefined
    confidence?: number | undefined
    content: string
    bucketId: string
    chunkIndex?: number
    documentId?: string
    tenantId?: string | undefined
    organizationId?: string | undefined
    graphId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    threadId?: string | undefined
    accessScope?: AccessScope | undefined
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const scope = mergeScope(defaultScope, {
      tenantId: triple.tenantId,
      organizationId: triple.organizationId,
      graphId: triple.graphId,
      groupId: triple.groupId,
      userId: triple.userId,
      agentId: triple.agentId,
      threadId: triple.threadId,
    })

    if (isAliasAssignmentRelation(triple.predicate)) {
      const alias = cleanOptionalText(triple.object)
      const aliases = [...new Map([
        ...(triple.subjectAliases ?? []),
        ...(alias && normalizeSurfaceText(alias) !== normalizeSurfaceText(triple.subject) ? [alias] : []),
        ...(triple.objectAliases ?? []),
      ].map(value => [normalizeSurfaceText(value), value])).values()]
      await resolveAndStoreEntity({
        name: triple.subject,
        type: triple.subjectType,
        typeCandidates: triple.subjectTypeCandidates,
        aliases,
        description: triple.subjectDescription,
        bucketId: triple.bucketId,
        documentId: triple.documentId,
        chunkIndex: triple.chunkIndex,
        tenantId: triple.tenantId,
        organizationId: triple.organizationId,
        graphId: triple.graphId,
        groupId: triple.groupId,
        userId: triple.userId,
        agentId: triple.agentId,
        threadId: triple.threadId,
        accessScope: triple.accessScope,
        confidence: triple.confidence,
        mentionType: 'entity',
      })
      return
    }

    const ontology = ontologyForGraph(triple.graphId)
    const normalizedRelation = normalizePredicateWithDirection(triple.predicate, ontology)
    if (!normalizedRelation.valid || GENERIC_DISALLOWED_PREDICATES.has(normalizedRelation.predicate)) return

    let sourceInput = {
      name: triple.subject,
      type: triple.subjectType,
      typeCandidates: triple.subjectTypeCandidates,
      aliases: triple.subjectAliases,
      description: triple.subjectDescription,
    }
    let targetInput = {
      name: triple.object,
      type: triple.objectType,
      typeCandidates: triple.objectTypeCandidates,
      aliases: triple.objectAliases,
      description: triple.objectDescription,
    }
    if (normalizedRelation.swapSubjectObject) {
      ;[sourceInput, targetInput] = [targetInput, sourceInput]
    }

    let sourceEntity = await resolveAndStoreEntity({
      name: sourceInput.name,
      type: sourceInput.type,
      typeCandidates: sourceInput.typeCandidates,
      aliases: sourceInput.aliases,
      description: sourceInput.description,
      bucketId: triple.bucketId,
      documentId: triple.documentId,
      chunkIndex: triple.chunkIndex,
      tenantId: triple.tenantId,
      organizationId: triple.organizationId,
      graphId: triple.graphId,
      groupId: triple.groupId,
      userId: triple.userId,
      agentId: triple.agentId,
      threadId: triple.threadId,
      accessScope: triple.accessScope,
      confidence: triple.confidence,
      mentionType: 'subject',
    })
    let targetEntity = await resolveAndStoreEntity({
      name: targetInput.name,
      type: targetInput.type,
      typeCandidates: targetInput.typeCandidates,
      aliases: targetInput.aliases,
      description: targetInput.description,
      bucketId: triple.bucketId,
      documentId: triple.documentId,
      chunkIndex: triple.chunkIndex,
      tenantId: triple.tenantId,
      organizationId: triple.organizationId,
      graphId: triple.graphId,
      groupId: triple.groupId,
      userId: triple.userId,
      agentId: triple.agentId,
      threadId: triple.threadId,
      accessScope: triple.accessScope,
      confidence: triple.confidence,
      mentionType: 'object',
    })

    // Dedupe may resolve subject and object to the same canonical entity. A
    // self-edge carries no traversal value and corrupts relation semantics.
    if (sourceEntity.id === targetEntity.id) return

    const relation = normalizedRelation.predicate
    const typeValidation = validatePredicateEffectiveTypes(
      relation,
      effectiveTypesForEntity(sourceEntity, ontology),
      effectiveTypesForEntity(targetEntity, ontology),
      ontology,
    )
    const weight = (triple.confidence ?? 1.0) * (typeValidation.valid ? 1 : 0.85)
    const relationshipDescription = cleanOptionalText(triple.relationshipDescription)
    const evidenceText = cleanOptionalText(triple.evidenceText)
    const chunkId = cleanOptionalText(triple.chunkId)
    const temporalStatus = triple.temporalStatus ?? normalizedRelation.temporalStatus
    const validFrom = cleanOptionalText(triple.validFrom)
    const validTo = cleanOptionalText(triple.validTo)

    if (textMentionsDirectionalContradiction({
      relation,
      sourceName: sourceEntity.name,
      targetName: targetEntity.name,
      description: relationshipDescription,
      evidenceText,
    })) return

    if (normalizedRelation.symmetric) {
      const sourceKey = normalizeSurfaceText(sourceEntity.id || sourceEntity.name)
      const targetKey = normalizeSurfaceText(targetEntity.id || targetEntity.name)
      if (sourceKey > targetKey) {
        ;[sourceEntity, targetEntity] = [targetEntity, sourceEntity]
      }
    }

    // Edges are deduplicated on (source, target, relation) at storage; chunk text
    // and provenance move to the entity↔chunk junction. Keep triple metadata in
    // metadata only if the caller supplied it (not auto-generated content).
    const edge: SemanticEdge = {
      id: generateId('edge'),
      sourceEntityId: sourceEntity.id,
      targetEntityId: targetEntity.id,
      relation,
      weight,
      metadata: {
        ...(relationshipDescription ? { relationshipDescription } : {}),
        ...(evidenceText ? { evidenceText } : {}),
        ...(chunkId ? { chunkId } : {}),
        ...(temporalStatus ? { temporalStatus } : {}),
        ...(validFrom ? { validFrom } : {}),
        ...(validTo ? { validTo } : {}),
        ...(!typeValidation.valid ? { predicateValidation: typeValidation } : {}),
        ...(triple.metadata ? { metadata: triple.metadata } : {}),
      },
      scope,
      accessScope: triple.accessScope,
      temporal: createTemporal(),
      evidence: [],
    }

    const storedEdge = await graph.addEdge(edge)

    if (memoryStore.upsertFactRecord) {
      const fallbackDescription = factTextFor(sourceEntity.name, relation, targetEntity.name)
      const description = buildFactSearchText({
        description: relationshipDescription ?? fallbackDescription,
        evidenceText,
      }) || fallbackDescription
      const factEmbedding = await embedText(embedding, description)
      await memoryStore.upsertFactRecord({
        id: stableGraphId('fact', [storedEdge.sourceEntityId, storedEdge.relation, storedEdge.targetEntityId]),
        edgeId: storedEdge.id,
        sourceEntityId: storedEdge.sourceEntityId,
        targetEntityId: storedEdge.targetEntityId,
        relation: storedEdge.relation,
        description,
        evidenceText,
        chunkId,
        weight: storedEdge.weight,
        embedding: factEmbedding,
        scope,
        accessScope: storedEdge.accessScope,
        createdAt: storedEdge.temporal.createdAt,
        updatedAt: new Date(),
        ...(storedEdge.temporal.invalidAt ? { invalidAt: storedEdge.temporal.invalidAt } : {}),
      })
    }

    if (memoryStore.upsertEntity) {
      await updateProfilesFromFact(sourceEntity, targetEntity, relation, weight)
    }

    const pairKey = [sourceEntity.id, targetEntity.id].sort().join(':')
    directEdgePairs.add(pairKey)

    // CO_OCCURS edges for disconnected entities
    const chunkKey = `${triple.bucketId}:${triple.documentId ?? ''}:${triple.chunkIndex ?? 0}`
    let chunkEntities = chunkEntityMap.get(chunkKey)
    if (!chunkEntities) {
      chunkEntities = new Set()
      chunkEntityMap.set(chunkKey, chunkEntities)
    }
    const newEntityIds = [sourceEntity.id, targetEntity.id]
    for (const newId of newEntityIds) {
      if (chunkEntities.has(newId)) continue

      const hasDirectEdges = [...directEdgePairs].some(pair => pair.split(':').includes(newId))
      if (!hasDirectEdges) {
        const existingIds = [...chunkEntities]
        if (existingIds.length > 0) {
          const linkTo = existingIds[0]!
          const coKey = [newId, linkTo].sort().join(':')
          if (!directEdgePairs.has(coKey)) {
            await graph.addEdge({
              id: generateId('edge'),
              sourceEntityId: newId,
              targetEntityId: linkTo,
              relation: 'CO_OCCURS',
              weight: 0.3,
              metadata: {},
              scope,
              accessScope: triple.accessScope,
              temporal: createTemporal(),
              evidence: [],
            })
            // Record the co-occurrence mention on the newly-linked entity
            if (memoryStore.upsertEntityChunkMentions && triple.documentId && triple.chunkIndex !== undefined) {
              await memoryStore.upsertEntityChunkMentions([{
                tenantId: scope.tenantId ?? 'public',
                graphId: scope.graphId ?? 'public',
                organizationId: scope.organizationId,
                entityId: newId,
                documentId: triple.documentId,
                chunkIndex: triple.chunkIndex,
                bucketId: triple.bucketId,
                mentionType: 'co_occurrence',
                normalizedSurfaceText: '',
              }])
            }
          }
        }
      }
      chunkEntities.add(newId)
    }
  }

  async function upsertEntity(input: UpsertGraphEntityInput): Promise<EntityDetail> {
    const entity = await upsertSeedEntity(input)
    return await getEntity(entity.id, scopeFrom(input as ScopedGraphEntityInput))
      ?? entityResultFromSemanticEntity(entity, 0)
  }

  async function upsertEntities(inputs: UpsertGraphEntityInput[]): Promise<EntityDetail[]> {
    const results: EntityDetail[] = []
    for (const input of inputs) {
      results.push(await upsertEntity(input))
    }
    return results
  }

  async function resolveEntity(
    ref: GraphEntityRef | string,
    identity?: typegraphIdentity,
  ): Promise<EntityDetail | null> {
    const entity = await resolveEntityForRead(ref, identity)
    if (!entity) return null
    return await getEntity(entity.id, scopeFrom(identity))
      ?? entityResultFromSemanticEntity(entity, 0)
  }

  async function linkExternalIds(
    entityId: string,
    externalIds: ExternalId[],
    identity?: typegraphIdentity,
  ): Promise<EntityDetail> {
    const scope = scopeFrom(identity)
    const entity = await graph.getEntity(entityId, scope)
    if (!entity) throw new Error(`Entity not found: ${entityId}`)
    const normalized = normalizeExternalIds(externalIds)
    await linkExternalIdsToEntity(entityId, normalized, scope)
    const updated: SemanticEntity = {
      ...entity,
      externalIds: mergeExternalIds(entity.externalIds, normalized),
    }
    await graph.addEntity(updated)
    return await getEntity(entityId, scope)
      ?? entityResultFromSemanticEntity(updated, 0)
  }

  async function upsertEdge(input: UpsertGraphEdgeInput): Promise<EdgeResult> {
    const scopedInput = input as ScopedGraphEdgeInput
    const scope = scopeFrom(scopedInput)
    const result = await upsertRelation({
      source: input.source,
      target: input.target,
      relation: input.relation,
      scope,
      accessScope: scopedInput.accessScope,
      weight: input.weight,
      metadata: input.metadata,
      description: input.description,
      evidenceText: input.evidenceText,
      chunkId: input.chunkId,
      temporalStatus: input.temporalStatus,
      validFrom: input.validFrom,
      validTo: input.validTo,
    })
    return edgeResultFromSemanticEdge(
      result.edge,
      new Map([
        [result.source.id, result.source.name],
        [result.target.id, result.target.name],
      ]),
    )
  }

  async function upsertEdges(inputs: UpsertGraphEdgeInput[]): Promise<EdgeResult[]> {
    const results: EdgeResult[] = []
    for (const input of inputs) {
      try {
        results.push(await upsertEdge(input))
      } catch (error) {
        if (isGraphSelfEdgeError(error)) continue
        throw error
      }
    }
    return results
  }

  async function upsertFact(input: UpsertGraphFactInput): Promise<FactResult> {
    const scopedInput = input as ScopedGraphFactInput
    const scope = scopeFrom(scopedInput)
    const result = await upsertRelation({
      source: input.source,
      target: input.target,
      relation: input.relation,
      scope,
      accessScope: scopedInput.accessScope,
      weight: input.confidence,
      metadata: input.metadata,
      description: input.description,
      evidenceText: input.evidenceText,
      chunkId: input.chunkId,
      temporalStatus: input.temporalStatus,
      validFrom: input.validFrom,
      validTo: input.validTo,
    })
    if (result.fact) {
      const [fact] = await hydrateFacts([result.fact], scope)
      if (fact) return fact
    }
    return factResultFromEdge(
      result.edge,
      new Map([
        [result.source.id, result.source.name],
        [result.target.id, result.target.name],
      ]),
      0,
    )
  }

  async function upsertFacts(inputs: UpsertGraphFactInput[]): Promise<FactResult[]> {
    const results: FactResult[] = []
    for (const input of inputs) {
      try {
        results.push(await upsertFact(input))
      } catch (error) {
        if (isGraphSelfEdgeError(error)) continue
        throw error
      }
    }
    return results
  }

  async function searchEntities(
    query: string,
    identity: typegraphIdentity,
    limit: number = 10,
  ): Promise<EntityResult[]> {
    if (!memoryStore.searchEntities && !memoryStore.searchEntitiesHybrid) return []

    const searchEmbedding = await embedText(embedding, query)
    const entities = memoryStore.searchEntitiesHybrid
      ? await memoryStore.searchEntitiesHybrid(query, searchEmbedding, identity, limit)
      : await memoryStore.searchEntities!(searchEmbedding, identity, limit)
    const similarityById = new Map<string, number>()
    for (const entity of entities) {
      const similarity = entity.metadata?._similarity
      if (typeof similarity === 'number') similarityById.set(entity.id, similarity)
    }

    return hydrateEntityResults(entities, similarityById, identity)
  }

  async function collectEntityCandidates(
    queries: string[],
    identity: typegraphIdentity,
    limit: number,
    opts: { stopOnStrongMatch?: boolean } = {},
  ): Promise<EntityResult[]> {
    const byId = new Map<string, EntityResult>()
    for (const query of queries) {
      const trimmed = query.trim()
      if (!trimmed) continue
      const matches = await searchEntities(trimmed, identity, limit)
      let strongMatches = 0
      for (const match of matches) {
        const similarity = match.similarity ?? 0
        if (similarity >= 0.95) strongMatches++
        const existing = byId.get(match.id)
        if (!existing || similarity > (existing.similarity ?? 0)) {
          byId.set(match.id, match)
        }
      }
      if (opts.stopOnStrongMatch && strongMatches > 0) break
      if (byId.size >= limit * 3) break
    }
    return [...byId.values()]
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, limit)
  }

  async function getAdjacencyList(
    entityIds: string[],
    identity?: typegraphIdentity,
  ): Promise<Map<string, Array<{ target: string; weight: number }>>> {
    const adjacency = new Map<string, Array<{ target: string; weight: number }>>()

    function addEdgeToAdjacency(from: string, to: string, weight: number) {
      let list = adjacency.get(from)
      if (!list) {
        list = []
        adjacency.set(from, list)
      }
      const existing = list.find(e => e.target === to)
      if (existing) {
        existing.weight += weight
      } else {
        list.push({ target: to, weight })
      }
    }

    const allEntityIds = new Set(entityIds)
    const neighborEdges: SemanticEdge[] = []

    const seedEdges = await graph.getEdgesBatch(entityIds, 'both', identity)
    for (const edge of seedEdges) {
      neighborEdges.push(edge)
      allEntityIds.add(edge.sourceEntityId)
      allEntityIds.add(edge.targetEntityId)
    }

    const firstHopIds = [...allEntityIds].filter(id => !entityIds.includes(id)).slice(0, 100)
    if (firstHopIds.length > 0) {
      const firstHopEdges = await graph.getEdgesBatch(firstHopIds, 'both', identity)
      for (const edge of firstHopEdges) {
        neighborEdges.push(edge)
        allEntityIds.add(edge.sourceEntityId)
        allEntityIds.add(edge.targetEntityId)
      }

      const seenIds = new Set<string>([...entityIds, ...firstHopIds])
      const secondHopIds = [...allEntityIds].filter(id => !seenIds.has(id)).slice(0, 100)
      if (secondHopIds.length > 0) {
        const secondHopEdges = await graph.getEdgesBatch(secondHopIds, 'both', identity)
        neighborEdges.push(...secondHopEdges)
      }
    }

    const seenEdges = new Set<string>()
    for (const edge of neighborEdges) {
      if (seenEdges.has(edge.id)) continue
      seenEdges.add(edge.id)

      addEdgeToAdjacency(edge.sourceEntityId, edge.targetEntityId, edge.weight)
      addEdgeToAdjacency(edge.targetEntityId, edge.sourceEntityId, edge.weight)
    }

    for (const [, edges] of adjacency) {
      for (const edge of edges) {
        edge.weight = Math.log2(1 + edge.weight)
      }
    }

    return adjacency
  }

  async function searchFacts(
    query: string,
    opts?: InternalFactSearchOpts | null,
  ): Promise<FactResult[]> {
    const normalizedOpts = optionalCompactObject<InternalFactSearchOpts>(opts, 'graph.searchFacts') as InternalFactSearchOpts
    if (!memoryStore.searchFacts && !memoryStore.searchFactsHybrid) return []
    const searchEmbedding = await embedText(embedding, query)
    const identity = {
      tenantId: normalizedOpts.tenantId,
      groupId: normalizedOpts.groupId,
      userId: normalizedOpts.userId,
      agentId: normalizedOpts.agentId,
      threadId: normalizedOpts.threadId,
    }
    const facts = memoryStore.searchFactsHybrid
      ? await memoryStore.searchFactsHybrid(query, searchEmbedding, identity, normalizedOpts.limit ?? 20)
      : await memoryStore.searchFacts!(searchEmbedding, identity, normalizedOpts.limit ?? 20)
    return hydrateFacts(facts, identity)
  }

  async function explore(
    query: string,
    opts?: InternalGraphExploreOpts | null,
  ): Promise<GraphExploreResult> {
    const normalizedOpts = optionalCompactObject<InternalGraphExploreOpts>(opts, 'graph.explore') as InternalGraphExploreOpts
    const identity = {
      tenantId: normalizedOpts.tenantId,
      groupId: normalizedOpts.groupId,
      userId: normalizedOpts.userId,
      agentId: normalizedOpts.agentId,
      threadId: normalizedOpts.threadId,
    }
    const include = {
      entities: normalizedOpts.include?.entities ?? true,
      facts: normalizedOpts.include?.facts ?? true,
      chunks: normalizedOpts.include?.chunks ?? false,
    }
    const anchorLimit = Math.max(1, normalizedOpts.anchorLimit ?? 3)
    const entityLimit = requestedLimit(normalizedOpts.entityLimit)
    const factLimit = requestedLimit(normalizedOpts.factLimit)
    const chunkLimit = Math.max(1, normalizedOpts.chunkLimit ?? 10)
    const depth: 1 | 2 = normalizedOpts.depth === 2 ? 2 : 1

    const parsed = await parseGraphQueryIntent({
      query,
      mode: normalizedOpts.intentParser,
      llm: explorationLlm,
    })
    const predicateConfidenceByName = new Map(parsed.intent.predicates.map(predicate => [predicate.name, predicate.confidence]))
    const selectedPredicates = new Set(parsed.intent.predicates.map(predicate => predicate.name))

    const trace: GraphExploreTrace = {
      parser: parsed.parser,
      mode: parsed.intent.mode,
      strictness: parsed.intent.strictness,
      selectedPredicates: [...selectedPredicates],
      sourceEntityQueries: parsed.intent.sourceEntityQueries,
      targetEntityQueries: parsed.intent.targetEntityQueries,
      subqueries: parsed.intent.subqueries,
      intentParseMs: parsed.parseMs,
      intentMatchedPatterns: parsed.matchedPatterns,
      rejectedPredicates: parsed.rejectedPredicates,
      anchorCandidates: [],
      selectedAnchorIds: [],
      matchedEdgeIds: [],
      matchedRelations: [],
      droppedByPredicate: 0,
      droppedByDirection: 0,
      droppedByType: 0,
    }

    const resolvedAnchors = parsed.parser !== 'none' && !graphIntentIsEmpty(parsed.intent)
      ? await resolveIntentAnchors(parsed.intent, identity, anchorLimit)
      : {
          sourceAnchors: [],
          targetAnchors: [],
          anchors: [],
          sourceAnchorIds: new Set<string>(),
          targetAnchorIds: new Set<string>(),
        }
    const anchors = resolvedAnchors.anchors
    trace.anchorCandidates = anchors
    trace.selectedAnchorIds = anchors.map(anchor => anchor.id)

    const emptyResult: GraphExploreResult = {
      intent: parsed.intent,
      anchors,
      entities: [],
      facts: [],
      ...(include.chunks ? { chunks: [] } : {}),
      ...(normalizedOpts.explain ? { trace } : {}),
    }

    if (anchors.length === 0) return emptyResult

    const anchorScoreById = new Map(
      anchors.map(anchor => [anchor.id, normalizeSeedScore(anchor.similarity ?? 1)]),
    )
    const subgraph = await graph.getSubgraph(anchors.map(anchor => anchor.id), depth, identity)
    const entityById = new Map(subgraph.entities.map(entity => [entity.id, entity]))
    const nameMap = new Map(subgraph.entities.map(entity => [entity.id, entity.name]))

    const matchedEdges: Array<{
      edge: SemanticEdge
      score: number
      resultEntityIds: string[]
    }> = []

    for (const edge of subgraph.edges) {
      const source = entityById.get(edge.sourceEntityId)
      const target = entityById.get(edge.targetEntityId)
      if (!source || !target) continue

      const match = edgeMatchesIntent({
        sourceEntityId: edge.sourceEntityId,
        targetEntityId: edge.targetEntityId,
        relation: edge.relation,
        intent: parsed.intent,
        sourceAnchorIds: resolvedAnchors.sourceAnchorIds,
        targetAnchorIds: resolvedAnchors.targetAnchorIds,
      })
      if (!match.match && match.reason === 'predicate') {
        trace.droppedByPredicate++
        continue
      }
      if (!match.match) {
        trace.droppedByDirection++
        continue
      }

      const anchorScore = Math.max(
        anchorScoreById.get(edge.sourceEntityId) ?? 0,
        anchorScoreById.get(edge.targetEntityId) ?? 0,
        1,
      )
      matchedEdges.push({
        edge,
        score: anchorScore * (predicateConfidenceByName.get(edge.relation) ?? 1) * Math.log2(1 + edge.weight),
        resultEntityIds: uniqueIds([edge.sourceEntityId, edge.targetEntityId]),
      })
    }

    matchedEdges.sort((a, b) => b.score - a.score)
    trace.matchedEdgeIds = matchedEdges.map(item => item.edge.id)
    trace.matchedRelations = [...new Set(matchedEdges.map(item => item.edge.relation))]

    const entityScoreById = new Map<string, number>()
    for (const anchor of anchors) {
      entityScoreById.set(anchor.id, anchorScoreById.get(anchor.id) ?? 1)
    }
    for (const match of matchedEdges) {
      for (const entityId of match.resultEntityIds) {
        entityScoreById.set(entityId, Math.max(entityScoreById.get(entityId) ?? 0, match.score))
      }
    }

    const hydratedEntityResults = include.entities
      ? (await hydrateEntityResultsById([...entityScoreById.keys()], undefined, identity)).map(entity => ({
          ...entity,
          metadata: {
            ...(entity.metadata ?? {}),
            exploreScore: entityScoreById.get(entity.id) ?? 0,
          },
        }))
          .sort((a, b) => Number((b.metadata ?? {}).exploreScore ?? 0) - Number((a.metadata ?? {}).exploreScore ?? 0))
      : []
    const entityResults = applyRequestedLimit(hydratedEntityResults, entityLimit)

    const facts = include.facts
      ? applyRequestedLimit(matchedEdges, factLimit)
          .map(match => factResultFromEdge(match.edge, nameMap, match.score))
      : []

    let chunks: ChunkResult[] | undefined
    if (include.chunks) {
      const chunkEntityLimit = Math.max(1, Math.min(entityLimit ?? 10, 10))
      const topEntityIds = [...entityScoreById.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, chunkEntityLimit)
        .map(([entityId]) => entityId)

      const chunkMap = new Map<string, ChunkResult>()
      for (const entityId of topEntityIds) {
        const connectedChunks = await getChunksForEntity(entityId, {
          bucketIds: normalizedOpts.bucketIds,
          limit: chunkLimit,
          ...identity,
        })
        const entityScore = entityScoreById.get(entityId) ?? 0
        for (const chunk of connectedChunks) {
          const key = chunkRefKey(chunk)
          const score = entityScore * Math.log2(1 + chunk.score)
          const existing = chunkMap.get(key)
          if (!existing || score > existing.score) {
            chunkMap.set(key, {
              ...chunk,
              score,
            })
          }
        }
      }

      chunks = [...chunkMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, chunkLimit)
    }

    return {
      intent: parsed.intent,
      anchors,
      entities: entityResults,
      facts,
      ...(include.chunks ? { chunks: chunks ?? [] } : {}),
      ...(normalizedOpts.explain ? { trace } : {}),
    }
  }

  function chunkRefKey(ref: ChunkRef): string {
    return `${ref.bucketId}\u001f${ref.documentId}\u001f${ref.chunkIndex}\u001f${ref.embeddingModel ?? ''}`
  }

  async function getChunksForEntity(entityId: string, opts?: ({
    bucketIds?: string[] | undefined
    limit?: number | undefined
  } & typegraphIdentity) | null): Promise<ChunkResult[]> {
    const normalizedOpts = optionalCompactObject<{
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & typegraphIdentity>(opts, 'graph.getChunksForEntity') as {
      bucketIds?: string[] | undefined
      limit?: number | undefined
    } & typegraphIdentity
    if (!memoryStore.getChunkEdgesForEntities || !memoryStore.getChunksByRefs || !config.resolveChunksTable) return []
    const identity = {
      tenantId: normalizedOpts.tenantId,
      groupId: normalizedOpts.groupId,
      userId: normalizedOpts.userId,
      agentId: normalizedOpts.agentId,
      threadId: normalizedOpts.threadId,
    }
    const chunkEdges = await memoryStore.getChunkEdgesForEntities([entityId], {
      scope: identity,
      bucketIds: normalizedOpts.bucketIds,
      limit: normalizedOpts.limit ?? 20,
    })
    if (chunkEdges.length === 0) return []
    const chunksTable = await config.resolveChunksTable(embeddingModelKey(embedding))
    const chunkRows = await memoryStore.getChunksByRefs(
      chunkEdges.map(edge => edge.chunkRef),
      { chunksTable, bucketIds: normalizedOpts.bucketIds, scope: identity },
    )
    const scoreByChunk = new Map(chunkEdges.map(edge => [chunkRefKey(edge.chunkRef), edge.weight]))
    return chunkRows
      .map(row => ({
        content: row.content,
        bucketId: row.bucketId,
        documentId: row.documentId,
        chunkIndex: row.chunkIndex,
        embeddingModel: row.embeddingModel,
        chunkId: row.chunkId,
        totalChunks: row.totalChunks,
        score: scoreByChunk.get(chunkRefKey(row)) ?? 0,
        metadata: row.metadata,
        tenantId: row.tenantId,
        groupId: row.groupId,
        userId: row.userId,
        agentId: row.agentId,
        threadId: row.threadId,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, normalizedOpts.limit ?? 20)
  }

  async function resolveEntityScope(scope: import('../types/query.js').QueryEntityScope, identity: typegraphIdentity, opts?: {
    bucketIds?: string[] | undefined
    limit?: number | undefined
  } | null): Promise<EntityScopeResolution> {
    const normalizedOpts = optionalCompactObject<{
      bucketIds?: string[] | undefined
      limit?: number | undefined
    }>(opts, 'graph.resolveEntityScope') as {
      bucketIds?: string[] | undefined
      limit?: number | undefined
    }
    const warnings: string[] = []
    const entityIds = new Set((scope.entityIds ?? []).filter(Boolean))
    if ((scope.externalIds?.length ?? 0) > 0 && !memoryStore.findEntityByExternalId) {
      throw new ConfigError('entityScope.externalIds requires a knowledge graph store with external ID resolution.')
    }
    for (const externalId of scope.externalIds ?? []) {
      const entity = memoryStore.findEntityByExternalId
        ? await memoryStore.findEntityByExternalId(externalId, identity)
        : null
      if (entity) entityIds.add(entity.id)
    }
    if ((scope.externalIds?.length ?? 0) > 0 && entityIds.size === (scope.entityIds?.length ?? 0)) {
      warnings.push('No entities resolved for the provided external IDs.')
    }
    const resolvedIds = [...entityIds]
    if (resolvedIds.length > 0 && !memoryStore.getChunkEdgesForEntities) {
      throw new ConfigError('entityScope requires a knowledge graph store with entity-chunk edge lookup.')
    }
    const chunkEdges = resolvedIds.length > 0
      ? await memoryStore.getChunkEdgesForEntities!(resolvedIds, {
          scope: identity,
          bucketIds: normalizedOpts.bucketIds,
          limit: normalizedOpts.limit ?? Math.max(200, resolvedIds.length * 200),
        })
      : []
    const chunkRefs = [...new Map(chunkEdges.map(edge => [chunkRefKey(edge.chunkRef), edge.chunkRef])).values()]
    return {
      entityIds: resolvedIds,
      chunkRefs,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  async function searchKnowledge(
    query: string,
    identity: typegraphIdentity,
    opts?: KnowledgeSearchOpts | null,
  ): Promise<KnowledgeSearchResult> {
    const normalizedOpts = optionalCompactObject<KnowledgeSearchOpts>(opts, 'graph.searchKnowledge') as KnowledgeSearchOpts
    const limit = normalizedOpts.count ?? 10
    const scopeEntityIds = new Set(normalizedOpts.resolvedEntityIds ?? [])
    const hasEntityScopeFilter = Boolean(normalizedOpts.entityScope && normalizedOpts.entityScope.mode !== 'boost')
    if (hasEntityScopeFilter && scopeEntityIds.size === 0) return { facts: [], entities: [] }
    const shouldFilter = hasEntityScopeFilter
    const searchEmbedding = normalizedOpts.retrieval?.semantic !== false || normalizedOpts.retrieval?.keyword
      ? await embedText(embedding, query)
      : undefined

    const entityRows = searchEmbedding && (memoryStore.searchEntitiesHybrid || memoryStore.searchEntities)
      ? (memoryStore.searchEntitiesHybrid
          ? await memoryStore.searchEntitiesHybrid(query, searchEmbedding, identity, limit)
          : await memoryStore.searchEntities!(searchEmbedding, identity, limit))
      : []
    const entities = (await hydrateEntityResults(entityRows, undefined, identity))
      .filter(entity => !shouldFilter || scopeEntityIds.has(entity.id))
      .slice(0, limit)

    const factRows = memoryStore.searchFactsHybrid
      ? await memoryStore.searchFactsHybrid(query, searchEmbedding, identity, limit)
      : searchEmbedding && memoryStore.searchFacts
        ? await memoryStore.searchFacts(searchEmbedding, identity, limit)
        : []
    const facts = (await hydrateFacts(
      factRows.filter(fact =>
        !shouldFilter ||
        scopeEntityIds.has(fact.sourceEntityId) ||
        scopeEntityIds.has(fact.targetEntityId)
      ),
      identity,
    )).slice(0, limit)

    return { facts, entities }
  }

  async function searchGraphChunks(
    query: string,
    identity: typegraphIdentity,
    opts?: GraphSearchOpts | null,
  ): Promise<GraphSearchResult> {
    const normalizedOpts = optionalCompactObject<GraphSearchOpts>(opts, 'graph.searchGraphChunks') as GraphSearchOpts
    const count = normalizedOpts.count ?? 10
    const restartProbability = normalizedOpts.restartProbability ?? 0.5
    const chunkSeedWeight = normalizedOpts.chunkSeedWeight ?? 0.05
    const entitySeedWeight = normalizedOpts.entitySeedWeight ?? 1.0
    const factCandidateLimit = normalizedOpts.factCandidateLimit ?? 200
    const factFilterInputLimit = normalizedOpts.factFilterInputLimit ?? 8
    const chunkSeedLimit = normalizedOpts.chunkSeedLimit ?? 200
    const maxIterations = normalizedOpts.maxPprIterations ?? 50
    const minPprScore = normalizedOpts.minPprScore ?? 1e-10
    const maxExpansionEdgesPerEntity = normalizedOpts.maxExpansionEdgesPerEntity ?? 100
    const factChainLimit = normalizedOpts.factChainLimit ?? 3
    const entityScopeMode = normalizedOpts.entityScope?.mode ?? 'filter'
    const scopedEntityIds = normalizedOpts.entityScope
      ? (normalizedOpts.resolvedEntityIds ?? (await resolveEntityScope(normalizedOpts.entityScope, identity, {
          bucketIds: normalizedOpts.bucketIds,
          limit: Math.max(count * 50, 200),
        })).entityIds)
      : []
    const scopedEntityIdSet = new Set(scopedEntityIds)
    const isEntityScopeFilter = Boolean(normalizedOpts.entityScope && entityScopeMode === 'filter')

    const parsed = await parseGraphQueryIntent({
      query,
      mode: normalizedOpts.intentParser,
      llm: explorationLlm,
    })

    const emptyTrace = (): GraphSearchTrace => ({
      intent: parsed.intent,
      parser: parsed.parser,
      entitySeedCount: 0,
      factSeedCount: 0,
      chunkSeedCount: 0,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      pprNonzeroCount: 0,
      candidatesBeforeMerge: 0,
      candidatesAfterMerge: 0,
      topGraphScores: [],
      selectedFactIds: [],
      selectedEntityIds: [],
      selectedChunkIds: [],
      finalChunkIds: [],
      selectedFactTexts: [],
      selectedEntityNames: [],
      selectedFactChains: [],
      intentParseMs: parsed.parseMs,
      intentMatchedPatterns: parsed.matchedPatterns,
      rejectedPredicates: parsed.rejectedPredicates,
    })

    if (!config.resolveChunksTable) {
      return { results: [], facts: [], entities: [], factChains: [], trace: emptyTrace() }
    }

    if (parsed.parser === 'none' || graphIntentIsEmpty(parsed.intent)) {
      return { results: [], facts: [], entities: [], factChains: [], trace: emptyTrace() }
    }

    const needsFactSearch = parsed.intent.strictness === 'strict'
    const description = intentSearchText(parsed.intent, query)
    const chunkSearchText = chunkIntentSearchText(parsed.intent, query)
    const [factEmbedding, chunkEmbedding] = needsFactSearch
      ? (description === chunkSearchText
          ? await embedText(embedding, description).then(value => [value, value] as const)
          : await Promise.all([
              embedText(embedding, description),
              embedText(embedding, chunkSearchText),
            ]))
      : [undefined, await embedText(embedding, chunkSearchText)] as const
    const chunksTable = await config.resolveChunksTable(embeddingModelKey(embedding))

    const factCandidates = needsFactSearch && factEmbedding && memoryStore.searchFacts
      ? await memoryStore.searchFacts(factEmbedding, identity, factCandidateLimit)
      : []
    const candidateEntityIds = uniqueIds(factCandidates.flatMap(fact => [fact.sourceEntityId, fact.targetEntityId]))
    const candidateEntities = candidateEntityIds.length > 0
      ? await graph.getEntitiesBatch(candidateEntityIds, identity)
      : []
    const entityNameById = new Map(candidateEntities.map(entity => [entity.id, entity.name]))
    const rankedFactCandidates = rerankFactRecords(factCandidates, description, entityNameById)
    const resolvedAnchors = await resolveIntentAnchors(parsed.intent, identity, 5)
    let selectedFacts = needsFactSearch
      ? rankedFactCandidates.filter(fact => factMatchesIntent(fact, {
          intent: parsed.intent,
          sourceAnchorIds: resolvedAnchors.sourceAnchorIds,
          targetAnchorIds: resolvedAnchors.targetAnchorIds,
        }).match)
      : []
    if (normalizedOpts.factFilter && config.factRelevanceFilter && selectedFacts.length > 0) {
      const filterInput = await hydrateFacts(selectedFacts.slice(0, Math.max(factFilterInputLimit, selectedFacts.length)), identity)
      try {
        const selectedIds = new Set(await config.factRelevanceFilter(query, filterInput))
        selectedFacts = selectedFacts.filter(f => selectedIds.has(f.id))
      } catch {
        // Keep the strict graph-intent matches when optional LLM fact filtering fails.
      }
    }
    if (isEntityScopeFilter) {
      selectedFacts = selectedFacts.filter(fact =>
        scopedEntityIdSet.has(fact.sourceEntityId) ||
        scopedEntityIdSet.has(fact.targetEntityId)
      )
    }

    const entitySeeds = new Map<string, number>()
    for (const entityId of scopedEntityIdSet) {
      entitySeeds.set(entityId, Math.max(entitySeeds.get(entityId) ?? 0, entitySeedWeight))
    }
    for (const anchor of resolvedAnchors.anchors) {
      const score = normalizeSeedScore(anchor.similarity ?? 1) * entitySeedWeight
      entitySeeds.set(anchor.id, Math.max(entitySeeds.get(anchor.id) ?? 0, score))
    }
    for (const fact of selectedFacts) {
      const score = normalizeSeedScore(fact.similarity ?? 0.5) * entitySeedWeight
      entitySeeds.set(fact.sourceEntityId, Math.max(entitySeeds.get(fact.sourceEntityId) ?? 0, score))
      entitySeeds.set(fact.targetEntityId, Math.max(entitySeeds.get(fact.targetEntityId) ?? 0, score))
    }

    const chunkSeeds = new Map<string, number>()
    const chunkSeedRows = memoryStore.searchChunks
      ? await memoryStore.searchChunks(chunkEmbedding, identity, {
          chunksTable,
          bucketIds: normalizedOpts.bucketIds,
          limit: chunkSeedLimit,
        })
      : []
    const chunkRefById = new Map<string, ChunkRef>()
    for (const chunk of chunkSeedRows) {
      const chunkNodeId = chunkNodeIdFor(chunk)
      chunkRefById.set(chunkNodeId, chunk)
      chunkSeeds.set(chunkNodeId, normalizeSeedScore(chunk.similarity ?? 0) * chunkSeedWeight)
    }

    const adjacency = new Map<string, Array<{ target: string; weight: number }>>()
    const addWeightedEdge = (from: string, to: string, weight: number) => {
      if (weight <= 0) return
      let edges = adjacency.get(from)
      if (!edges) {
        edges = []
        adjacency.set(from, edges)
      }
      const existing = edges.find(edge => edge.target === to)
      if (existing) existing.weight += weight
      else edges.push({ target: to, weight })
    }

    const entitySeedIds = [...entitySeeds.keys()]
    const entityAdjacency = entitySeedIds.length > 0
      ? await getAdjacencyList(entitySeedIds, identity)
      : new Map<string, Array<{ target: string; weight: number }>>()
    for (const [entityId, edges] of entityAdjacency) {
      for (const edge of edges.slice(0, maxExpansionEdgesPerEntity)) {
        addWeightedEdge(entityId, edge.target, edge.weight)
      }
    }

    const activeEntityIds = new Set<string>(entitySeedIds)
    for (const [node, edges] of entityAdjacency) {
      activeEntityIds.add(node)
      for (const edge of edges) activeEntityIds.add(edge.target)
    }
    for (const entityId of scopedEntityIdSet) activeEntityIds.add(entityId)

    const scopedChunkIds = new Set<string>()
    const chunkEntityEdges = memoryStore.getChunkEdgesForEntities
      ? await memoryStore.getChunkEdgesForEntities([...activeEntityIds], {
          scope: identity,
          bucketIds: normalizedOpts.bucketIds,
          limit: Math.max(100, activeEntityIds.size * maxExpansionEdgesPerEntity),
        })
      : []
    for (const edge of chunkEntityEdges) {
      const chunkNodeId = chunkNodeIdFor(edge.chunkRef)
      chunkRefById.set(chunkNodeId, edge.chunkRef)
      if (scopedEntityIdSet.has(edge.entityId)) scopedChunkIds.add(chunkNodeId)
      const weight = Math.log2(1 + edge.weight)
      addWeightedEdge(edge.entityId, chunkNodeId, weight)
      addWeightedEdge(chunkNodeId, edge.entityId, weight)
      const entitySeedScore = entitySeeds.get(edge.entityId)
      if (entitySeedScore != null) {
        const mentionSeedScore = entitySeedScore * weight * 0.6
        chunkSeeds.set(chunkNodeId, Math.max(chunkSeeds.get(chunkNodeId) ?? 0, mentionSeedScore))
      }
    }

    for (const chunkId of chunkSeeds.keys()) {
      if (!adjacency.has(chunkId)) adjacency.set(chunkId, [])
    }

    const seedWeights = new Map<string, number>()
    for (const [id, score] of entitySeeds) seedWeights.set(id, Math.max(seedWeights.get(id) ?? 0, score))
    for (const [id, score] of chunkSeeds) seedWeights.set(id, Math.max(seedWeights.get(id) ?? 0, score))

    if (seedWeights.size === 0) {
      return { results: [], facts: [], entities: [], factChains: [], trace: emptyTrace() }
    }

    const pprScores = runWeightedPPR(adjacency, seedWeights, restartProbability, maxIterations, minPprScore)
    const scoredChunkIds = [...pprScores.entries()]
      .filter(([id]) => id.startsWith('chunk_') || chunkRefById.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(count * 3, count))
      .map(([id]) => id)

    const fallbackChunkIds = chunkSeedRows
      .map(row => chunkNodeIdFor(row))
      .filter(id => !scoredChunkIds.includes(id))
      .slice(0, Math.max(0, count - scoredChunkIds.length))
    const chunkIds = [...scoredChunkIds, ...fallbackChunkIds]
    const chunkRefs = chunkIds.map(id => chunkRefById.get(id)).filter((ref): ref is ChunkRef => !!ref)
    const chunkRows = memoryStore.getChunksByRefs && chunkRefs.length > 0
      ? await memoryStore.getChunksByRefs(chunkRefs, { chunksTable, bucketIds: normalizedOpts.bucketIds, scope: identity })
      : []
    const denseScoreByChunk = new Map(chunkSeedRows.map(row => [chunkNodeIdFor(row), row.similarity ?? 0]))
    const selectedFactResults = await hydrateFacts(selectedFacts, identity)
    const factChains = buildFactChains(selectedFactResults, factChainLimit)
    const evidenceEntityIds = uniqueIds(isEntityScopeFilter
      ? [
          ...scopedEntityIdSet,
          ...selectedFactResults.flatMap(fact => [fact.sourceEntityId, fact.targetEntityId]),
          ...factChains.flatMap(chain => chain.entityIds),
        ]
      : [
          ...resolvedAnchors.anchors.map(anchor => anchor.id),
          ...entitySeeds.keys(),
          ...selectedFactResults.flatMap(fact => [fact.sourceEntityId, fact.targetEntityId]),
          ...factChains.flatMap(chain => chain.entityIds),
        ])
    const entityOrder = new Map(evidenceEntityIds.map((id, index) => [id, index]))
    const selectedEntityRows = await graph.getEntitiesBatch(evidenceEntityIds, identity)
    const selectedEntityResults = (await hydrateEntityResults(selectedEntityRows, undefined, identity))
      .sort((a, b) => (entityOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (entityOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    const chunkQueryTokens = queryTokens([
      query,
      ...parsed.intent.sourceEntityQueries,
      ...parsed.intent.targetEntityQueries,
    ].join(' '))
    const results = chunkRows
      .filter(row => !isEntityScopeFilter || scopedChunkIds.has(chunkNodeIdFor(row)))
      .map(row => {
        const nodeId = chunkNodeIdFor(row)
        const pprScore = pprScores.get(nodeId) ?? ((denseScoreByChunk.get(nodeId) ?? 0) * chunkSeedWeight)
        const denseScore = denseScoreByChunk.get(nodeId) ?? 0
        const lexicalScore = tokenOverlapScore(chunkQueryTokens, row.content)
        return {
          content: row.content,
          bucketId: row.bucketId,
          documentId: row.documentId,
          chunkIndex: row.chunkIndex,
          embeddingModel: row.embeddingModel,
          chunkId: row.chunkId,
          totalChunks: row.totalChunks,
          score: pprScore + denseScore * 0.15 + lexicalScore * 0.12,
          metadata: row.metadata,
          tenantId: row.tenantId,
          groupId: row.groupId,
          userId: row.userId,
          agentId: row.agentId,
          threadId: row.threadId,
        }
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, count)

    const trace: GraphSearchTrace = {
      intent: parsed.intent,
      parser: parsed.parser,
      entitySeedCount: entitySeeds.size,
      factSeedCount: selectedFacts.length,
      chunkSeedCount: chunkSeeds.size,
      graphNodeCount: countGraphNodes(adjacency, seedWeights),
      graphEdgeCount: countGraphEdges(adjacency),
      pprNonzeroCount: pprScores.size,
      candidatesBeforeMerge: chunkRows.length,
      candidatesAfterMerge: results.length,
      topGraphScores: results.slice(0, 5).map(result => result.score),
      selectedFactIds: selectedFacts.map(fact => fact.id),
      selectedEntityIds: evidenceEntityIds,
      selectedChunkIds: [...chunkSeeds.keys()].slice(0, 20),
      finalChunkIds: results.map(result => chunkNodeIdFor(result)),
      selectedFactTexts: selectedFactResults.map(fact => ({ id: fact.id, content: formatFactEvidence(fact) })),
      selectedEntityNames: selectedEntityResults.map(entity => ({ id: entity.id, content: entity.name })),
      selectedFactChains: factChains.map(chain => ({
        content: chain.content,
        score: chain.score,
        factIds: chain.facts.map(fact => fact.id),
      })),
      intentParseMs: parsed.parseMs,
      intentMatchedPatterns: parsed.matchedPatterns,
      rejectedPredicates: parsed.rejectedPredicates,
    }

    return { results, facts: selectedFactResults, entities: selectedEntityResults, factChains, trace }
  }

  async function explainQuery(query: string, opts?: InternalGraphExplainOpts | null): Promise<GraphSearchTrace> {
    const normalizedOpts = optionalCompactObject<InternalGraphExplainOpts>(opts, 'graph.explainQuery') as InternalGraphExplainOpts
    const identity = {
      tenantId: normalizedOpts.tenantId,
      groupId: normalizedOpts.groupId,
      userId: normalizedOpts.userId,
      agentId: normalizedOpts.agentId,
      threadId: normalizedOpts.threadId,
    }
    const result = await searchGraphChunks(query, identity, normalizedOpts)
    return result.trace
  }

  async function hydrateFacts(facts: SemanticFactRecord[], identity?: typegraphIdentity): Promise<FactResult[]> {
    if (facts.length === 0) return []
    const entityIds = [...new Set(facts.flatMap(f => [f.sourceEntityId, f.targetEntityId]))]
    const entities = await graph.getEntitiesBatch(entityIds, identity)
    const nameMap = new Map(entities.map(entity => [entity.id, entity.name]))
    return facts.map(fact => {
      const metadata = (fact as unknown as { metadata?: Record<string, unknown> }).metadata
      const sourceEntityName = nameMap.get(fact.sourceEntityId)
      const targetEntityName = nameMap.get(fact.targetEntityId)
      const fallbackDescription = fact.description || factTextFor(sourceEntityName ?? fact.sourceEntityId, fact.relation, targetEntityName ?? fact.targetEntityId)
      const relationshipDescription = cleanOptionalText(fact.description)
        ?? propertyString(metadata, 'relationshipDescription')
        ?? propertyString(metadata, 'description')
      const evidenceText = cleanOptionalText(fact.evidenceText)
        ?? propertyString(metadata, 'evidenceText')
      const description = buildFactSearchText({ description: relationshipDescription ?? fallbackDescription, evidenceText })
        || fallbackDescription
      const chunkId = cleanOptionalText(fact.chunkId)
        ?? propertyString(metadata, 'chunkId')
      return {
        id: fact.id,
        edgeId: fact.edgeId,
        sourceEntityId: fact.sourceEntityId,
        sourceEntityName,
        targetEntityId: fact.targetEntityId,
        targetEntityName,
        relation: fact.relation,
        description,
        evidenceText,
        chunkId,
        weight: fact.weight,
        similarity: fact.similarity,
        ...(metadata ? { metadata } : {}),
      }
    })
  }

  async function backfill(
    identity: typegraphIdentity,
    opts?: GraphBackfillOpts | null,
  ): Promise<GraphBackfillResult> {
    const normalizedOpts = optionalCompactObject<GraphBackfillOpts>(opts, 'graph.backfill') as GraphBackfillOpts
    const batchSize = Math.max(1, normalizedOpts.batchSize ?? 500)
    const result: GraphBackfillResult = {
      entityChunkEdgesUpserted: 0,
      factRecordsUpserted: 0,
      entityProfilesUpdated: 0,
      batches: 0,
    }

    if (!config.resolveChunksTable) return result

    const chunksTable = await config.resolveChunksTable(embeddingModelKey(embedding))
    const pageOpts = (offset: number) => ({
      chunksTable,
      scope: identity,
      bucketIds: normalizedOpts.bucketIds,
      limit: batchSize,
      offset,
    })

    if ((normalizedOpts.entityChunkEdges ?? true) && memoryStore.listChunkMentionBackfillRows && memoryStore.upsertGraphEdges) {
      for (let offset = 0; ; offset += batchSize) {
        const rows = await memoryStore.listChunkMentionBackfillRows(pageOpts(offset))
        if (rows.length === 0) break
        result.batches++

        const edgeMap = new Map<string, {
          entityId: string
          chunkRef: ChunkRef
          weight: number
          mentionCount: number
          confidence?: number | undefined
          surfaceTexts: string[]
          mentionTypes: SemanticEntityMention['mentionType'][]
          scope: typegraphIdentity
          accessScope?: AccessScope | undefined
        }>()
        for (const row of rows) {
          const scope = mergeScope(defaultScope, {
            tenantId: row.tenantId,
            groupId: row.groupId,
            userId: row.userId,
            agentId: row.agentId,
            threadId: row.threadId,
          })
          const chunkRef: ChunkRef = {
            bucketId: row.bucketId,
            documentId: row.documentId,
            chunkIndex: row.chunkIndex,
            embeddingModel: row.embeddingModel,
            chunkId: row.chunkId,
          }
          const key = `${chunkRefKey(chunkRef)}:${row.entityId}`
          const current = edgeMap.get(key) ?? {
            entityId: row.entityId,
            chunkRef,
            weight: 0,
            mentionCount: 0,
            confidence: undefined,
            surfaceTexts: [],
            mentionTypes: [],
            scope,
            accessScope: row.accessScope,
          }
          current.mentionCount += 1
          current.confidence = Math.max(current.confidence ?? 0, row.confidence ?? 0)
          if (row.surfaceText?.trim()) {
            const normalized = normalizeSurfaceText(row.surfaceText)
            if (!current.surfaceTexts.some(value => normalizeSurfaceText(value) === normalized)) {
              current.surfaceTexts.push(row.surfaceText.trim())
            }
          }
          if (!current.mentionTypes.includes(row.mentionType)) current.mentionTypes.push(row.mentionType)
          const confidence = current.confidence && current.confidence > 0 ? current.confidence : 0.75
          current.weight = Math.min(3, 0.5 + Math.log2(1 + current.mentionCount) * confidence)
          edgeMap.set(key, current)
        }

        const edges = [...edgeMap.values()].map(edge => buildEntityChunkGraphEdge(edge))
        await memoryStore.upsertGraphEdges(edges)
        result.entityChunkEdgesUpserted += edges.length
        if (rows.length < batchSize) break
      }
    }

    const shouldBackfillFacts = normalizedOpts.facts ?? true
    const shouldBackfillProfiles = normalizedOpts.entityProfiles ?? true
    if ((shouldBackfillFacts || shouldBackfillProfiles) && memoryStore.listSemanticEdgesForBackfill) {
      const updatedProfileEntityIds = new Set<string>()
      for (let offset = 0; ; offset += batchSize) {
        const edges = await memoryStore.listSemanticEdgesForBackfill({
          scope: identity,
          bucketIds: normalizedOpts.bucketIds,
          limit: batchSize,
          offset,
        })
        if (edges.length === 0) break
        result.batches++

        const entityIds = [...new Set(edges.flatMap(edge => [edge.sourceEntityId, edge.targetEntityId]))]
        const entities = await graph.getEntitiesBatch(entityIds)
        const entityById = new Map(entities.map(entity => [entity.id, entity]))
        const factInputs = edges
          .map(edge => {
            const source = entityById.get(edge.sourceEntityId)
            const target = entityById.get(edge.targetEntityId)
            if (!source || !target) return undefined
            return { edge, source, target, description: factTextFor(source.name, edge.relation, target.name) }
          })
          .filter((item): item is { edge: SemanticEdge; source: SemanticEntity; target: SemanticEntity; description: string } => !!item)

        const factEmbeddings = shouldBackfillFacts && factInputs.length > 0
          ? await embedTexts(embedding, factInputs.map(input => input.description))
          : []

        for (let i = 0; i < factInputs.length; i++) {
          const input = factInputs[i]!
          if (shouldBackfillFacts && memoryStore.upsertFactRecord) {
            await memoryStore.upsertFactRecord({
              id: stableGraphId('fact', [input.edge.sourceEntityId, input.edge.relation, input.edge.targetEntityId]),
              edgeId: input.edge.id,
              sourceEntityId: input.edge.sourceEntityId,
              targetEntityId: input.edge.targetEntityId,
              relation: input.edge.relation,
              description: input.description,
              weight: input.edge.weight,
              embedding: factEmbeddings[i],
              scope: input.edge.scope,
              accessScope: input.edge.accessScope,
              createdAt: input.edge.temporal.createdAt,
              updatedAt: new Date(),
            })
            result.factRecordsUpserted += 1
          }

          if (shouldBackfillProfiles) {
            await updateProfilesFromFact(input.source, input.target, input.edge.relation, input.edge.weight)
            updatedProfileEntityIds.add(input.source.id)
            updatedProfileEntityIds.add(input.target.id)
          }
        }
        if (edges.length < batchSize) break
      }
      result.entityProfilesUpdated = updatedProfileEntityIds.size
    }

    return result
  }

  // ── Graph Exploration ──

  async function getEntity(id: string, opts?: typegraphIdentity | null): Promise<EntityDetail | null> {
    const normalizedOpts = optionalCompactObject<typegraphIdentity>(opts, 'graph.getEntity') as typegraphIdentity
    const entity = await graph.getEntity(id, normalizedOpts)
    if (!entity) return null

    const edges = await graph.getEdges(id, 'both', normalizedOpts)
    const neighborIds = new Set<string>()
    for (const e of edges) {
      neighborIds.add(e.sourceEntityId)
      neighborIds.add(e.targetEntityId)
    }
    neighborIds.delete(id)
    const nameMap = new Map<string, string>([[id, entity.name]])
    const neighbors = await graph.getEntitiesBatch([...neighborIds], normalizedOpts)
    for (const n of neighbors) nameMap.set(n.id, n.name)

    const topEdges: EdgeResult[] = edges
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 20)
      .map(e => ({
        id: e.id,
        sourceEntityId: e.sourceEntityId,
        sourceEntityName: nameMap.get(e.sourceEntityId) ?? e.sourceEntityId,
        targetEntityId: e.targetEntityId,
        targetEntityName: nameMap.get(e.targetEntityId) ?? e.targetEntityId,
        relation: e.relation,
        weight: e.weight,
        metadata: e.metadata,
      }))

    return {
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
      aliases: entity.aliases,
      externalIds: entity.externalIds,
      edgeCount: edges.length,
      metadata: entity.metadata,
      description: entity.metadata.description as string | undefined,
      createdAt: entity.temporal.createdAt,
      validAt: entity.temporal.validAt,
      invalidAt: entity.temporal.invalidAt,
      topEdges,
    }
  }

  async function getEdges(entityId: string, opts?: ({
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  } & typegraphIdentity) | null): Promise<EdgeResult[]> {
    const normalizedOpts = optionalCompactObject<{
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & typegraphIdentity>(opts, 'graph.getEdges') as {
      direction?: 'in' | 'out' | 'both'
      relation?: string
      limit?: number
    } & typegraphIdentity
    const identity = {
      tenantId: normalizedOpts.tenantId,
      groupId: normalizedOpts.groupId,
      userId: normalizedOpts.userId,
      agentId: normalizedOpts.agentId,
      threadId: normalizedOpts.threadId,
    }
    let edges = await graph.getEdges(entityId, normalizedOpts.direction ?? 'both', identity)
    if (normalizedOpts.relation) {
      edges = edges.filter(e => e.relation === normalizedOpts.relation)
    }

    const entityIds = new Set<string>()
    for (const e of edges) {
      entityIds.add(e.sourceEntityId)
      entityIds.add(e.targetEntityId)
    }
    const nameMap = new Map<string, string>()
    const ents = await graph.getEntitiesBatch([...entityIds], identity)
    for (const ent of ents) nameMap.set(ent.id, ent.name)

    const limit = normalizedOpts.limit ?? 50
    return edges.slice(0, limit).map(e => ({
      id: e.id,
      sourceEntityId: e.sourceEntityId,
      sourceEntityName: nameMap.get(e.sourceEntityId) ?? e.sourceEntityId,
      targetEntityId: e.targetEntityId,
      targetEntityName: nameMap.get(e.targetEntityId) ?? e.targetEntityId,
      relation: e.relation,
      weight: e.weight,
      metadata: e.metadata,
    }))
  }

  async function getSubgraph(opts: SubgraphOpts): Promise<SubgraphResult> {
    const normalizedOpts = requiredObject<SubgraphOpts>(opts, 'graph.getSubgraph', 'opts')
    let seedIds = normalizedOpts.entityIds ?? []
    if (normalizedOpts.query && (memoryStore.searchEntities || memoryStore.searchEntitiesHybrid)) {
      const queryEmb = await embedText(embedding, normalizedOpts.query)
      const found = memoryStore.searchEntitiesHybrid
        ? await memoryStore.searchEntitiesHybrid(normalizedOpts.query, queryEmb, normalizedOpts.identity, normalizedOpts.limit ?? 10)
        : await memoryStore.searchEntities!(queryEmb, normalizedOpts.identity, normalizedOpts.limit ?? 10)
      seedIds = [...seedIds, ...found.map(e => e.id)]
    }
    if (seedIds.length === 0) {
      return { entities: [], edges: [], stats: { entityCount: 0, edgeCount: 0, avgDegree: 0, components: 0 } }
    }

    const depth = Math.min(normalizedOpts.depth ?? 1, 3)
    const sub = await graph.getSubgraph(seedIds, depth, normalizedOpts.identity)

    let entities = sub.entities
    let edges = sub.edges
    if (normalizedOpts.entityTypes?.length) {
      const types = new Set(normalizedOpts.entityTypes)
      entities = entities.filter(e => types.has(e.entityType))
    }
    if (normalizedOpts.relations?.length) {
      const rels = new Set(normalizedOpts.relations)
      edges = edges.filter(e => rels.has(e.relation))
    }
    if (normalizedOpts.minWeight) {
      edges = edges.filter(e => e.weight >= normalizedOpts.minWeight!)
    }

    const entityLimit = normalizedOpts.limit ?? 100
    entities = entities.slice(0, entityLimit)
    const entitySet = new Set(entities.map(e => e.id))
    edges = edges.filter(e => entitySet.has(e.sourceEntityId) && entitySet.has(e.targetEntityId))

    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.sourceEntityId, (degree.get(e.sourceEntityId) ?? 0) + 1)
      degree.set(e.targetEntityId, (degree.get(e.targetEntityId) ?? 0) + 1)
    }
    const maxDegree = Math.max(1, ...degree.values())
    const maxWeight = Math.max(1, ...edges.map(e => e.weight))

    const nameMap = new Map<string, string>()
    for (const e of entities) nameMap.set(e.id, e.name)

    const parent = new Map<string, string>()
    function find(x: string): string {
      if (!parent.has(x)) parent.set(x, x)
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
      return parent.get(x)!
    }
    function union(a: string, b: string) { parent.set(find(a), find(b)) }
    for (const e of entities) parent.set(e.id, e.id)
    for (const e of edges) union(e.sourceEntityId, e.targetEntityId)
    const components = new Set([...entitySet].map(id => find(id))).size

    return {
      entities: entities.map(e => ({
        id: e.id,
        name: e.name,
        entityType: e.entityType,
        aliases: e.aliases,
        edgeCount: degree.get(e.id) ?? 0,
        metadata: e.metadata,
        size: Math.max(1, Math.round(((degree.get(e.id) ?? 0) / maxDegree) * 10)),
      })),
      edges: edges.map(e => ({
        id: e.id,
        sourceEntityId: e.sourceEntityId,
        sourceEntityName: nameMap.get(e.sourceEntityId) ?? e.sourceEntityId,
        targetEntityId: e.targetEntityId,
        targetEntityName: nameMap.get(e.targetEntityId) ?? e.targetEntityId,
        relation: e.relation,
        weight: e.weight,
        metadata: e.metadata,
        thickness: Math.max(1, Math.round((e.weight / maxWeight) * 5)),
      })),
      stats: {
        entityCount: entities.length,
        edgeCount: edges.length,
        avgDegree: entities.length > 0 ? (edges.length * 2) / entities.length : 0,
        components,
      },
    }
  }

  async function getGraphStats(identity: typegraphIdentity): Promise<GraphStats> {
    const totalEntities = memoryStore.countEntities ? await memoryStore.countEntities(identity) : 0
    const totalEdges = memoryStore.countEdges ? await memoryStore.countEdges(identity) : 0
    const topRelations = memoryStore.getRelationTypes ? await memoryStore.getRelationTypes(identity) : []
    const topEntityTypes = memoryStore.getEntityTypes ? await memoryStore.getEntityTypes(identity) : []
    const degreeDistribution = memoryStore.getDegreeDistribution ? await memoryStore.getDegreeDistribution(identity) : []

    return {
      totalEntities,
      totalEdges,
      avgEdgesPerEntity: totalEntities > 0 ? totalEdges / totalEntities : 0,
      topEntityTypes,
      topRelations,
      degreeDistribution,
    }
  }

  async function getRelationTypes(identity: typegraphIdentity): Promise<Array<{ relation: string; count: number }>> {
    return memoryStore.getRelationTypes ? memoryStore.getRelationTypes(identity) : []
  }

  async function getEntityTypes(identity: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>> {
    return memoryStore.getEntityTypes ? memoryStore.getEntityTypes(identity) : []
  }

  async function mergeEntities(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult> {
    if (!memoryStore.mergeEntityReferences) {
      throw new ConfigError('MemoryStoreAdapter does not support transactional entity merge operations.')
    }
    const result = await memoryStore.mergeEntityReferences(input)
    return {
      ...result,
      target: await getEntity(input.targetEntityId, scopeFrom())
        ?? result.target,
    }
  }

  async function deleteEntity(entityId: string, opts?: DeleteGraphEntityOpts | null): Promise<DeleteGraphEntityResult> {
    if (!memoryStore.deleteEntityReferences) {
      throw new ConfigError('MemoryStoreAdapter does not support transactional entity delete operations.')
    }
    return memoryStore.deleteEntityReferences(
      entityId,
      optionalCompactObject<DeleteGraphEntityOpts>(opts, 'graph.deleteEntity') as DeleteGraphEntityOpts,
    )
  }

  async function deploy(): Promise<void> {
    await memoryStore.initialize()
  }

  return {
    deploy,
    addTriple,
    upsertEntity,
    upsertEntities,
    resolveEntity,
    linkExternalIds,
    mergeEntities,
    deleteEntity,
    upsertEdge,
    upsertEdges,
    upsertFact,
    upsertFacts,
    addEntityMentions,
    searchEntities,
    searchFacts,
    explore,
    resolveEntityScope,
    searchKnowledge,
    getChunksForEntity,
    searchGraphChunks,
    explainQuery,
    backfill,
    getEntity,
    getEdges,
    getSubgraph,
    getGraphStats,
    getRelationTypes,
    getEntityTypes,
  }
}

function countGraphNodes(
  adjacency: Map<string, Array<{ target: string; weight: number }>>,
  seeds: Map<string, number>,
): number {
  const nodes = new Set<string>(seeds.keys())
  for (const [node, edges] of adjacency) {
    nodes.add(node)
    for (const edge of edges) nodes.add(edge.target)
  }
  return nodes.size
}

function countGraphEdges(adjacency: Map<string, Array<{ target: string; weight: number }>>): number {
  let count = 0
  for (const edges of adjacency.values()) count += edges.length
  return count
}

function runWeightedPPR(
  adjacency: Map<string, Array<{ target: string; weight: number }>>,
  seedWeights: Map<string, number>,
  restartProbability: number,
  maxIterations: number,
  minScore: number,
): Map<string, number> {
  const allNodes = new Set<string>(seedWeights.keys())
  for (const [node, edges] of adjacency) {
    allNodes.add(node)
    for (const edge of edges) allNodes.add(edge.target)
  }
  const nodeList = [...allNodes]
  if (nodeList.length === 0) return new Map()
  const idx = new Map(nodeList.map((id, i) => [id, i]))

  const reset = new Float64Array(nodeList.length)
  let totalSeedWeight = 0
  for (const [id, weight] of seedWeights) {
    if (!idx.has(id) || weight <= 0) continue
    totalSeedWeight += weight
  }
  if (totalSeedWeight <= 0) return new Map()
  for (const [id, weight] of seedWeights) {
    const i = idx.get(id)
    if (i === undefined || weight <= 0) continue
    reset[i] = weight / totalSeedWeight
  }

  let scores = Float64Array.from(reset)
  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(nodeList.length)
    for (const [node, edges] of adjacency) {
      const sourceIndex = idx.get(node)
      if (sourceIndex === undefined) continue
      const totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0)
      if (totalWeight <= 0) continue
      const sourceScore = scores[sourceIndex] ?? 0
      for (const edge of edges) {
        const targetIndex = idx.get(edge.target)
        if (targetIndex === undefined) continue
        next[targetIndex] = (next[targetIndex] ?? 0) + (1 - restartProbability) * sourceScore * (edge.weight / totalWeight)
      }
    }

    let diff = 0
    for (let i = 0; i < nodeList.length; i++) {
      next[i]! += restartProbability * reset[i]!
      diff += Math.abs(next[i]! - scores[i]!)
    }
    scores = next
    if (diff < 1e-6) break
  }

  const result = new Map<string, number>()
  for (let i = 0; i < nodeList.length; i++) {
    if (scores[i]! > minScore) result.set(nodeList[i]!, scores[i]!)
  }
  return result
}
