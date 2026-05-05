import type { EmbeddingProvider } from '../embedding/provider.js'
import type { typegraphEventSink, typegraphEventType, TelemetryOpts } from '../types/events.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { typegraphIdentity } from '../types/identity.js'
import type {
  MemoryRecord,
  MemoryCategory,
  SemanticEntity,
  SemanticFact,
  EpisodicMemory,
  ProceduralMemory,
  SemanticGraphEdge,
} from './types/memory.js'
import type { MemorySubject } from '../types/graph-bridge.js'
import type { QueryEntityScope } from '../types/query.js'
import type { Visibility } from '../types/typegraph-document.js'
import type { LLMProvider } from './extraction/llm-provider.js'
import type { ExtractionResult, ConversationMessage } from './extraction/extractor.js'
import { ConfigError } from '../types/errors.js'
import { MemoryExtractor } from './extraction/extractor.js'
import { InvalidationEngine } from './extraction/invalidation.js'
import { decayScore, DEFAULT_DECAY_CONFIG } from './consolidation/decay.js'
import { createTemporal } from './temporal.js'
import { generateId } from '../utils/id.js'
import { DEFAULT_ENTITY_TYPE } from '../index-engine/ontology.js'
import { createHash } from 'crypto'

// ── Recall option shapes ──

type RecallFormat = 'xml' | 'markdown' | 'plain'

interface RecallOptsInternal extends TelemetryOpts {
  types?: MemoryCategory[] | undefined
  limit?: number | undefined
  asOf?: Date | undefined
  /** Include invalidated/expired memories. Default: false. */
  includeInvalidated?: boolean | undefined
  entityScope?: QueryEntityScope | undefined
  /** Return a formatted string instead of `MemoryRecord[]`. */
  format?: RecallFormat | undefined
}

type RecallOptsWithFormat = RecallOptsInternal & { format: RecallFormat }

interface MemoryContextOpts extends TelemetryOpts {
  subject?: MemorySubject | undefined
  relatedEntities?: MemorySubject[] | undefined
  visibility?: Visibility | undefined
}

// ── Memory Health Report ──

export interface MemoryHealthReport {
  totalMemories: number
  activeMemories: number
  invalidatedMemories: number
  consolidatedMemories: number
  /** active / (active + invalidated), 0–1. 1 = perfectly precise, 0 = all invalidated */
  memoryPrecision: number
  totalEntities: number
  totalEdges: number
  edgesPerEntity: number
  /** Fraction of active memories below the decay threshold (rough staleness estimate) */
  stalenessIndex: number
}

// ── typegraphMemoryConfig ──

export interface typegraphMemoryConfig {
  memoryStore: MemoryStoreAdapter
  embedding: EmbeddingProvider
  llm: LLMProvider
  scope: typegraphIdentity
  eventSink?: typegraphEventSink | undefined
}

// ── TypegraphMemory ──
// Unified developer-facing API for cognitive memory.
// Imperative mode - direct calls, instant results.
// Same engines used by job system for automation.

export class TypegraphMemory {
  readonly identity: typegraphIdentity

  private readonly store: MemoryStoreAdapter
  private readonly embedding: EmbeddingProvider
  private readonly llm: LLMProvider
  private readonly scope: typegraphIdentity
  private readonly extractor: MemoryExtractor
  private readonly invalidation: InvalidationEngine
  private readonly eventSink: typegraphEventSink | undefined

  constructor(config: typegraphMemoryConfig) {
    this.store = config.memoryStore
    this.embedding = config.embedding
    this.llm = config.llm
    this.scope = config.scope
    this.identity = config.scope
    this.eventSink = config.eventSink

    this.extractor = new MemoryExtractor({
      llm: config.llm,
      embedding: config.embedding,
      scope: config.scope,
    })

    this.invalidation = new InvalidationEngine({
      llm: config.llm,
      store: config.memoryStore,
    })
  }

  // ── Internal ──

  private emit(
    eventType: typegraphEventType,
    targetId: string | undefined,
    payload: Record<string, unknown>,
    durationMs?: number,
    telemetry?: TelemetryOpts,
  ): void {
    if (!this.eventSink) return
    this.eventSink.emit({
      id: crypto.randomUUID(),
      eventType,
      identity: this.scope,
      targetId,
      payload,
      durationMs,
      traceId: telemetry?.traceId,
      spanId: telemetry?.spanId,
      timestamp: new Date(),
    })
  }

  private stableMemoryEntityId(subject: MemorySubject): string {
    const key = subject.entityId
      ?? subject.externalIds?.map(id => `${id.identityType}:${id.type}:${id.encoding ?? 'none'}:${id.id}`).sort().join('|')
      ?? subject.name
      ?? 'memory-subject'
    const scopeKey = [
      this.scope.tenantId,
      this.scope.groupId,
      this.scope.userId,
      this.scope.agentId,
      this.scope.conversationId,
    ].map(value => value ?? '').join('\u001f')
    return `ent_${createHash('sha256').update(`${scopeKey}\u001f${key}`).digest('hex').slice(0, 32)}`
  }

  private memorySubjectEntityType(subject: MemorySubject): string {
    if (subject.entityType?.trim()) return subject.entityType.trim()
    const identityType = subject.externalIds?.[0]?.identityType
    if (identityType === 'user') return 'person'
    if (identityType === 'tenant' || identityType === 'group') return 'organization'
    return DEFAULT_ENTITY_TYPE
  }

  private async resolveMemorySubject(subject: MemorySubject | undefined, visibility?: Visibility): Promise<SemanticEntity | null> {
    if (!subject) return null
    if (subject.entityId && this.store.getEntity) {
      const existing = await this.store.getEntity(subject.entityId, this.scope)
      if (existing) return existing
    }
    for (const externalId of subject.externalIds ?? []) {
      const existing = this.store.findEntityByExternalId
        ? await this.store.findEntityByExternalId(externalId, this.scope)
        : null
      if (existing) return existing
    }
    if (!this.store.upsertEntity) return null
    const name = subject.name?.trim()
      || subject.externalIds?.[0]?.id
      || subject.entityId
      || 'Unknown entity'
    const embedding = await this.embedding.embed(name)
    const now = new Date()
    return this.store.upsertEntity({
      id: subject.entityId ?? this.stableMemoryEntityId(subject),
      name,
      entityType: this.memorySubjectEntityType(subject),
      aliases: subject.aliases ?? [],
      externalIds: subject.externalIds,
      properties: subject.properties ?? {},
      embedding,
      scope: this.scope,
      visibility,
      temporal: { validAt: now, createdAt: now },
    })
  }

  private async resolveEntityScope(scope: QueryEntityScope | undefined): Promise<string[] | undefined> {
    if (!scope) return undefined
    const entityIds = new Set((scope.entityIds ?? []).filter(Boolean))
    if ((scope.externalIds?.length ?? 0) > 0 && !this.store.findEntityByExternalId) {
      throw new ConfigError('entityScope.externalIds requires a memory store with external ID resolution.')
    }
    for (const externalId of scope.externalIds ?? []) {
      const entity = this.store.findEntityByExternalId
        ? await this.store.findEntityByExternalId(externalId, this.scope)
        : null
      if (entity) entityIds.add(entity.id)
    }
    return [...entityIds]
  }

  private async linkMemoryToEntities(memoryId: string, entities: SemanticEntity[], visibility?: Visibility): Promise<void> {
    if (!this.store.upsertGraphEdges || entities.length === 0) return
    const now = new Date()
    const edges: SemanticGraphEdge[] = entities.map(entity => ({
      id: `edge_${createHash('sha256').update(`memory:${memoryId}:ABOUT:${entity.id}`).digest('hex').slice(0, 32)}`,
      sourceType: 'memory',
      sourceId: memoryId,
      targetType: 'entity',
      targetId: entity.id,
      relation: 'ABOUT',
      weight: 1,
      properties: {},
      scope: this.scope,
      visibility,
      temporal: { validAt: now, createdAt: now },
      evidence: [memoryId],
    }))
    await this.store.upsertGraphEdges(edges)
  }

  private async memoryIdsForEntityScope(scope: QueryEntityScope | undefined): Promise<string[] | undefined> {
    const entityIds = await this.resolveEntityScope(scope)
    if (!entityIds) return undefined
    if (entityIds.length === 0) return []
    if (!this.store.getMemoryIdsForEntities) {
      throw new ConfigError('entityScope requires a memory store with entity-memory association lookup.')
    }
    return this.store.getMemoryIdsForEntities(entityIds, this.scope)
  }

  private async resolveMemoryContext(opts?: MemoryContextOpts | undefined): Promise<{
    entities: SemanticEntity[]
    entityScope?: QueryEntityScope | undefined
    memoryIds?: string[] | undefined
  }> {
    const subjects = [opts?.subject, ...(opts?.relatedEntities ?? [])].filter((subject): subject is MemorySubject => !!subject)
    if (subjects.length === 0) return { entities: [] }
    const entities = (await Promise.all(subjects.map(subject => this.resolveMemorySubject(subject, opts?.visibility))))
      .filter((entity): entity is SemanticEntity => !!entity)
    const entityIds = [...new Set(entities.map(entity => entity.id))]
    if (entityIds.length === 0) return { entities: [] }
    const entityScope: QueryEntityScope = { entityIds }
    const memoryIds = await this.memoryIdsForEntityScope(entityScope)
    return { entities, entityScope, memoryIds }
  }

  // ── Store ──

  /**
   * Store a memory. Creates a record in the given category (default: `semantic`).
   * For LLM extraction of structured facts from a conversation, use `addConversationTurn()`.
   */
  async remember(content: string, opts?: {
    category?: MemoryCategory | undefined
    importance?: number | undefined
    metadata?: Record<string, unknown> | undefined
    subject?: MemorySubject | undefined
    relatedEntities?: MemorySubject[] | undefined
    visibility?: Visibility | undefined
  } & TelemetryOpts): Promise<MemoryRecord> {
    const category = opts?.category ?? 'semantic'
    const embedding = await this.embedding.embed(content)
    const temporal = createTemporal()

    const record: MemoryRecord = {
      id: generateId('mem'),
      category,
      status: 'active',
      content,
      embedding,
      importance: opts?.importance ?? 0.5,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: opts?.metadata ?? {},
      scope: this.scope,
      visibility: opts?.visibility,
      ...temporal,
    }

    const result = await this.store.upsert(record)
    const { entities } = await this.resolveMemoryContext(opts)
    await this.linkMemoryToEntities(result.id, entities, opts?.visibility)
    this.emit('memory.write', result.id, { category, contentLength: content.length }, undefined, opts)
    return result
  }

  /**
   * Forget (invalidate) a memory by ID. Preserves the record with invalidAt set.
   */
  async forget(id: string, telemetry?: TelemetryOpts): Promise<void> {
    await this.store.invalidate(id)
    await this.store.invalidateGraphEdgesForNode?.('memory', id)
    this.emit('memory.invalidate', id, {}, undefined, telemetry)
  }

  /**
   * Apply a natural language correction to memories.
   * Example: "Actually, John works at Acme Corp, not Beta Inc"
   *
   * Runs the correction through the same extraction + contradiction
   * machinery as `addConversationTurn`, so prior facts get invalidated
   * by the LLM contradiction judge rather than a brittle substring match.
   */
  async correct(naturalLanguageCorrection: string, opts?: MemoryContextOpts): Promise<{
    invalidated: number
    created: number
    summary: string
  }> {
    const messages: ConversationMessage[] = [
      { role: 'user', content: naturalLanguageCorrection },
    ]

    const candidates = await this.extractor.extractFacts(messages)
    if (candidates.length === 0) {
      this.emit('memory.correct', undefined, {
        correction: naturalLanguageCorrection.slice(0, 100),
        invalidated: 0,
        created: 0,
      }, undefined, opts)
      return { invalidated: 0, created: 0, summary: 'Could not parse correction' }
    }

    let invalidated = 0
    let created = 0
    const syntheticEpisodeId = generateId('mem')
    const context = await this.resolveMemoryContext(opts)

    for (const candidate of candidates) {
      const fact = this.extractor.candidateToFact(candidate, syntheticEpisodeId)
      fact.metadata = { ...fact.metadata, correctionText: naturalLanguageCorrection }
      fact.embedding = await this.embedding.embed(fact.content)

      const contradictions = await this.invalidation.checkContradictions(fact, this.scope, {
        memoryIds: context.memoryIds,
      })
      if (contradictions.length > 0) {
        invalidated += contradictions.length
        this.emit('extraction.contradiction', undefined, {
          factContent: fact.content.slice(0, 100),
          contradictionCount: contradictions.length,
          source: 'correct',
        }, undefined, opts)
        await this.invalidation.resolveContradictions(contradictions)
      }

      const stored = await this.store.upsert(fact)
      await this.linkMemoryToEntities(stored.id, context.entities, opts?.visibility)
      created++
    }

    const summary = `Invalidated ${invalidated} fact(s), created ${created} corrected fact(s)`
    this.emit('memory.correct', undefined, {
      correction: naturalLanguageCorrection.slice(0, 100),
      invalidated,
      created,
    }, undefined, opts)
    return { invalidated, created, summary }
  }

  // ── Retrieve ──

  /**
   * Unified recall across all memory types.
   * When `opts.format` is set, returns a formatted string grouped by category
   * suitable for dropping into an LLM prompt.
   */
  async recall(query: string, opts: RecallOptsWithFormat): Promise<string>
  async recall(query: string, opts?: RecallOptsInternal): Promise<MemoryRecord[]>
  async recall(query: string, opts?: RecallOptsInternal): Promise<MemoryRecord[] | string> {
    const embedding = await this.embedding.embed(query)
    const scopedMemoryIds = await this.memoryIdsForEntityScope(opts?.entityScope)
    const results = await this.store.search(embedding, {
      count: opts?.limit ?? 10,
      filter: {
        scope: this.scope,
        ...(scopedMemoryIds ? { ids: scopedMemoryIds } : {}),
        category: opts?.types,
        ...(opts?.includeInvalidated ? {} : { status: 'active' as const }),
      },
      includeExpired: opts?.includeInvalidated,
      temporalAt: opts?.asOf,
    })

    // Track access
    for (const record of results) {
      if (this.store.recordAccess) {
        await this.store.recordAccess(record.id)
      }
    }

    this.emit('memory.read', undefined, {
      query: query.slice(0, 100),
      resultCount: results.length,
      types: opts?.types,
    }, undefined, opts)

    if (opts?.format) return formatRecords(results, opts.format)
    return results
  }

  async recallHybrid(query: string, opts: RecallOptsWithFormat): Promise<string>
  async recallHybrid(query: string, opts?: RecallOptsInternal): Promise<MemoryRecord[]>
  async recallHybrid(query: string, opts?: RecallOptsInternal): Promise<MemoryRecord[] | string> {
    const embedding = await this.embedding.embed(query)
    const scopedMemoryIds = await this.memoryIdsForEntityScope(opts?.entityScope)
    const searchOpts = {
      count: opts?.limit ?? 10,
      filter: {
        scope: this.scope,
        ...(scopedMemoryIds ? { ids: scopedMemoryIds } : {}),
        category: opts?.types,
        ...(opts?.includeInvalidated ? {} : { status: 'active' as const }),
      } as import('./types/adapter.js').MemoryFilter,
      includeExpired: opts?.includeInvalidated,
      temporalAt: opts?.asOf,
    }

    // Use hybrid search if adapter supports it, otherwise fall back to vector-only
    const results = this.store.hybridSearch
      ? await this.store.hybridSearch(embedding, query, searchOpts)
      : await this.store.search(embedding, searchOpts)

    // Track access
    for (const record of results) {
      if (this.store.recordAccess) {
        await this.store.recordAccess(record.id)
      }
    }

    this.emit('memory.read', undefined, {
      query: query.slice(0, 100),
      resultCount: results.length,
      types: opts?.types,
      hybrid: true,
    }, undefined, opts)

    if (opts?.format) return formatRecords(results, opts.format)
    return results
  }

  /**
   * Recall only semantic facts.
   */
  async recallFacts(query: string, limit: number = 10, telemetry?: TelemetryOpts): Promise<SemanticFact[]> {
    const results = await this.recall(query, { types: ['semantic'], limit, ...telemetry })
    const facts = results.filter((r): r is SemanticFact => r.category === 'semantic')
    this.emit('memory.read', undefined, { query: query.slice(0, 100), resultCount: facts.length, source: 'facts' }, undefined, telemetry)
    return facts
  }

  /**
   * Recall only episodic memories.
   */
  async recallEpisodes(query: string, limit: number = 10, telemetry?: TelemetryOpts): Promise<EpisodicMemory[]> {
    const results = await this.recall(query, { types: ['episodic'], limit, ...telemetry })
    return results.filter((r): r is EpisodicMemory => r.category === 'episodic')
  }

  /**
   * Recall procedural memories matching a trigger.
   */
  async recallProcedures(trigger: string, limit: number = 5, telemetry?: TelemetryOpts): Promise<ProceduralMemory[]> {
    const results = await this.recall(trigger, { types: ['procedural'], limit, ...telemetry })
    return results.filter((r): r is ProceduralMemory => r.category === 'procedural')
  }

  // ── Conversation ──

  /**
   * Ingest a conversation turn. Extracts episodic memory + semantic facts.
   */
  async addConversationTurn(
    messages: ConversationMessage[],
    conversationId?: string,
    opts?: MemoryContextOpts,
  ): Promise<ExtractionResult> {
    const context = await this.resolveMemoryContext(opts)
    // Get existing facts for conflict resolution
    const existingFacts = context.entityScope
      ? (await this.recall(messages.map(m => m.content).join(' '), {
          types: ['semantic'],
          limit: 20,
          entityScope: context.entityScope,
          ...opts,
        })).filter((record): record is SemanticFact => record.category === 'semantic')
      : await this.recallFacts(
          messages.map(m => m.content).join(' '),
          20,
          opts,
        )

    const result = await this.extractor.processConversation(
      messages,
      existingFacts,
      conversationId,
    )

    // Store episodic memories
    for (const episode of result.episodic) {
      episode.embedding = await this.embedding.embed(episode.content)
      const stored = await this.store.upsert(episode)
      await this.linkMemoryToEntities(stored.id, context.entities, opts?.visibility)
      this.emit('memory.write', stored.id, { category: 'episodic', source: 'conversation' }, undefined, opts)
    }

    // Store new facts and check for contradictions
    let contradictionCount = 0
    const allContradictions: Array<{ existingId: string; newId: string; conflictType: string; reasoning: string }> = []
    for (const fact of result.facts) {
      fact.embedding = await this.embedding.embed(fact.content)

      // Check contradictions before storing
      const contradictions = await this.invalidation.checkContradictions(fact, this.scope, {
        memoryIds: context.memoryIds,
      })
      if (contradictions.length > 0) {
        contradictionCount += contradictions.length
        for (const c of contradictions) {
          allContradictions.push({
            existingId: c.existingFact.id,
            newId: fact.id,
            conflictType: c.conflictType,
            reasoning: c.reasoning,
          })
        }
        this.emit('extraction.contradiction', undefined, {
          factContent: fact.content.slice(0, 100),
          contradictionCount: contradictions.length,
        }, undefined, opts)
        await this.invalidation.resolveContradictions(contradictions)
      }

      const stored = await this.store.upsert(fact)
      await this.linkMemoryToEntities(stored.id, context.entities, opts?.visibility)
      this.emit('memory.write', stored.id, { category: 'semantic', source: 'conversation' }, undefined, opts)
    }

    this.emit('extraction.facts', undefined, {
      episodicCount: result.episodic.length,
      factCount: result.facts.length,
      contradictionCount,
      conversationId,
    }, undefined, opts)

    // Expose contradictions on the result so callers (typegraph.ts) can fire the onContradictionDetected hook
    ;(result as ExtractionResult & { _contradictions?: typeof allContradictions })._contradictions = allContradictions

    return result
  }

  // ── Health ──

  /**
   * Return a snapshot of memory system health and statistics.
   * Uses count methods on the adapter when available; falls back to list() sampling.
   */
  async healthCheck(): Promise<MemoryHealthReport> {
    let totalMemories: number
    let activeMemories: number
    let invalidatedMemories: number
    let consolidatedMemories: number

    if (this.store.countMemories) {
      // Fast path: adapter supports native counts
      ;[totalMemories, activeMemories, invalidatedMemories, consolidatedMemories] =
        await Promise.all([
          this.store.countMemories(),
          this.store.countMemories({ status: 'active' }),
          this.store.countMemories({ status: 'invalidated' }),
          this.store.countMemories({ status: 'consolidated' }),
        ])
    } else {
      // Fallback: list up to 1 000 records and tally in memory
      const records = await this.store.list({}, 1000)
      totalMemories = records.length
      activeMemories = records.filter(r => r.status === 'active').length
      invalidatedMemories = records.filter(r => r.status === 'invalidated').length
      consolidatedMemories = records.filter(r => r.status === 'consolidated').length
    }

    const precision = (activeMemories + invalidatedMemories) > 0
      ? activeMemories / (activeMemories + invalidatedMemories)
      : 1

    const totalEntities = this.store.countEntities
      ? await this.store.countEntities()
      : 0

    const totalEdges = this.store.countEdges
      ? await this.store.countEdges()
      : 0

    const edgesPerEntity = totalEntities > 0
      ? Math.round((totalEdges / totalEntities) * 100) / 100
      : 0

    // Staleness: sample active memories and count those below decay threshold
    let stalenessIndex = 0
    if (activeMemories > 0) {
      const sample = await this.store.list({ status: 'active' }, Math.min(activeMemories, 500))
      const stale = sample.filter(r => decayScore(r, DEFAULT_DECAY_CONFIG) < DEFAULT_DECAY_CONFIG.minScore)
      stalenessIndex = Math.round((stale.length / sample.length) * 1000) / 1000
    }

    return {
      totalMemories,
      activeMemories,
      invalidatedMemories,
      consolidatedMemories,
      memoryPrecision: Math.round(precision * 1000) / 1000,
      totalEntities,
      totalEdges,
      edgesPerEntity,
      stalenessIndex,
    }
  }
}

// ── Formatter ──

const SECTION_LABELS: Record<MemoryCategory, { xml: string; md: string; plain: string }> = {
  semantic: { xml: 'semantic_memory', md: '## Known Facts', plain: 'Known facts:' },
  episodic: { xml: 'episodic_memory', md: '## Recent Episodes', plain: 'Recent episodes:' },
  procedural: { xml: 'procedural_memory', md: '## Procedures', plain: 'Procedures:' },
}

function renderRecord(record: MemoryRecord): string {
  if (record.category === 'procedural') {
    const proc = record as ProceduralMemory
    return `- When: ${proc.trigger}\n  Steps: ${proc.steps.join(' → ')}`
  }
  return `- ${record.content}`
}

/**
 * Group records by category and emit a single formatted string.
 * Categories with no records are omitted.
 */
function formatRecords(records: MemoryRecord[], format: RecallFormat): string {
  if (records.length === 0) return ''

  const grouped: Record<MemoryCategory, MemoryRecord[]> = {
    semantic: [],
    episodic: [],
    procedural: [],
  }
  for (const record of records) grouped[record.category].push(record)

  const sections: string[] = []
  for (const category of ['semantic', 'episodic', 'procedural'] as const) {
    const group = grouped[category]
    if (group.length === 0) continue
    const body = group.map(renderRecord).join('\n')
    const labels = SECTION_LABELS[category]
    if (format === 'xml') {
      sections.push(`<${labels.xml}>\n${body}\n</${labels.xml}>`)
    } else if (format === 'markdown') {
      sections.push(`${labels.md}\n${body}`)
    } else {
      sections.push(`${labels.plain}\n${body}`)
    }
  }

  if (sections.length === 0) return ''
  if (format === 'xml') return `<memory>\n${sections.join('\n')}\n</memory>`
  return sections.join('\n\n')
}
