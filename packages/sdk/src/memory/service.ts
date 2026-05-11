import type { Embedder } from '../embedding/provider.js'
import { embedText } from '../embedding/provider.js'
import type { typegraphEventSink, typegraphEventType, TelemetryOpts } from '../types/events.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { AccessScope, typegraphIdentity } from '../types/identity.js'
import type {
  MemoryRecord,
  MemoryCategory,
  SemanticEntity,
  ProceduralMemory,
  SemanticGraphEdge,
} from './types/memory.js'
import type { MemorySubject } from '../types/graph-bridge.js'
import type { QueryEntityScope } from '../types/query.js'
import type { MemoryHealthReport } from '../types/memory.js'
import type { LLMProvider } from './extraction/llm-provider.js'
import type { ConversationMessage } from './extraction/extractor.js'
import { ConfigError } from '../types/errors.js'
import { MemoryExtractor } from './extraction/extractor.js'
import { InvalidationEngine } from './extraction/invalidation.js'
import { decayScore, DEFAULT_DECAY_CONFIG } from './consolidation/decay.js'
import { createTemporal } from './temporal.js'
import { generateId, stableInternalId } from '../utils/id.js'
import { optionalCompactObject } from '../utils/input.js'
import { DEFAULT_ENTITY_TYPE } from '../index-engine/ontology.js'

// ── Recall option shapes ──

export type MemoryRecallFormat = 'xml' | 'markdown' | 'plain'

export interface MemoryServiceCallOpts extends TelemetryOpts {
  identity: typegraphIdentity
  accessScope?: AccessScope | undefined
  graphIds?: string[] | undefined
}

export interface MemoryServiceRecallOpts extends MemoryServiceCallOpts {
  types?: MemoryCategory[] | undefined
  limit?: number | undefined
  asOf?: Date | undefined
  /** Include invalidated/expired memories. Default: false. */
  includeInvalidated?: boolean | undefined
  entityScope?: QueryEntityScope | undefined
  /** Return a formatted string instead of `MemoryRecord[]`. */
  format?: MemoryRecallFormat | undefined
}

type RecallOptsWithFormat = MemoryServiceRecallOpts & { format: MemoryRecallFormat }

export interface MemoryServiceContextOpts extends MemoryServiceCallOpts {
  subject?: MemorySubject | undefined
  relatedEntities?: MemorySubject[] | undefined
  graphExtraction?: boolean | undefined
}

export type MemoryServiceRememberOpts = MemoryServiceContextOpts & {
  category?: MemoryCategory | undefined
  importance?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface MemoryRetrievalService {
  recall(query: string, opts?: MemoryServiceRecallOpts | null): Promise<MemoryRecord[]>
  recallHybrid(query: string, opts?: MemoryServiceRecallOpts | null): Promise<MemoryRecord[]>
  hasMemories(): Promise<boolean>
}

// ── Runtime config ──

export interface MemoryServiceConfig {
  memoryStore: MemoryStoreAdapter
  embedding: Embedder
  llm?: LLMProvider | undefined
  eventSink?: typegraphEventSink | undefined
}

export class MemoryService {
  private readonly store: MemoryStoreAdapter
  private readonly embedding: Embedder
  private readonly llm: LLMProvider | undefined
  private readonly invalidation: InvalidationEngine | undefined
  private readonly eventSink: typegraphEventSink | undefined
  private memoriesChecked = false
  private memoriesExist = false

  constructor(config: MemoryServiceConfig) {
    this.store = config.memoryStore
    this.embedding = config.embedding
    this.llm = config.llm
    this.eventSink = config.eventSink

    this.invalidation = config.llm
      ? new InvalidationEngine({
          llm: config.llm,
          store: config.memoryStore,
        })
      : undefined
  }

  // ── Internal ──

  private emit(
    eventType: typegraphEventType,
    targetId: string | undefined,
    payload: Record<string, unknown>,
    identity: typegraphIdentity,
    durationMs?: number,
    telemetry?: TelemetryOpts | null,
  ): void {
    if (!this.eventSink) return
    this.eventSink.emit({
      id: crypto.randomUUID(),
      eventType,
      identity,
      targetId,
      payload,
      durationMs,
      traceId: telemetry?.traceId,
      spanId: telemetry?.spanId,
      timestamp: new Date(),
    })
  }

  private createExtractor(identity: typegraphIdentity): MemoryExtractor {
    if (!this.llm) {
      throw new ConfigError('Memory graph extraction requires `llm` or a configured extractor.')
    }
    return new MemoryExtractor({
      llm: this.llm,
      embedding: this.embedding,
      scope: identity,
    })
  }

  private stableMemoryEntityId(subject: MemorySubject, identity: typegraphIdentity): string {
    const key = subject.entityId
      ?? subject.externalIds?.map(id => `${id.type}:${id.encoding ?? 'none'}:${id.id}`).sort().join('|')
      ?? subject.name
      ?? 'memory-subject'
    const scopeKey = [
      identity.tenantId,
      identity.groupId,
      identity.userId,
      identity.agentId,
      identity.threadId,
    ].map(value => value ?? '').join('\u001f')
    return stableInternalId({
      tenantId: identity.tenantId ?? 'tenant',
      kind: 'ent',
      id: `${scopeKey}\u001f${key}`,
    })
  }

  private memorySubjectEntityType(subject: MemorySubject): string {
    if (subject.entityType?.trim()) return subject.entityType.trim()
    return DEFAULT_ENTITY_TYPE
  }

  private async resolveMemorySubject(subject: MemorySubject | undefined, identity: typegraphIdentity, accessScope?: AccessScope): Promise<SemanticEntity | null> {
    if (!subject) return null
    if (subject.entityId && this.store.getEntity) {
      const existing = await this.store.getEntity(subject.entityId, identity)
      if (existing) return existing
    }
    for (const externalId of subject.externalIds ?? []) {
      const existing = this.store.findEntityByExternalId
        ? await this.store.findEntityByExternalId(externalId, identity)
        : null
      if (existing) return existing
    }
    if (!this.store.upsertEntity) return null
    const name = subject.name?.trim()
      || subject.externalIds?.[0]?.id
      || subject.entityId
      || 'Unknown entity'
    const embedding = await embedText(this.embedding, name)
    const now = new Date()
    return this.store.upsertEntity({
      id: subject.entityId ?? this.stableMemoryEntityId(subject, identity),
      graphId: identity.graphId ?? 'public',
      name,
      entityType: this.memorySubjectEntityType(subject),
      aliases: subject.aliases ?? [],
      externalIds: subject.externalIds,
      metadata: subject.metadata ?? {},
      embedding,
      scope: identity,
      accessScope,
      temporal: { validAt: now, createdAt: now },
    })
  }

  private async resolveEntityScope(scope: QueryEntityScope | undefined, identity: typegraphIdentity): Promise<string[] | undefined> {
    if (!scope) return undefined
    const entityIds = new Set((scope.entityIds ?? []).filter(Boolean))
    if ((scope.externalIds?.length ?? 0) > 0 && !this.store.findEntityByExternalId) {
      throw new ConfigError('entityScope.externalIds requires a memory store with external ID resolution.')
    }
    for (const externalId of scope.externalIds ?? []) {
      const entity = this.store.findEntityByExternalId
        ? await this.store.findEntityByExternalId(externalId, identity)
        : null
      if (entity) entityIds.add(entity.id)
    }
    return [...entityIds]
  }

  private async linkMemoryToEntities(memoryId: string, entities: SemanticEntity[], identity: typegraphIdentity, accessScope?: AccessScope): Promise<void> {
    if (!this.store.upsertGraphEdges || entities.length === 0) return
    const now = new Date()
    const edges: SemanticGraphEdge[] = entities.map(entity => ({
      id: stableInternalId({
        tenantId: identity.tenantId ?? 'tenant',
        kind: 'edge',
        id: `memory:${memoryId}:ABOUT:${entity.id}`,
      }),
      graphId: identity.graphId ?? entity.graphId ?? 'public',
      sourceType: 'memory',
      sourceId: memoryId,
      targetType: 'entity',
      targetId: entity.id,
      relation: 'ABOUT',
      weight: 1,
      metadata: {},
      scope: identity,
      accessScope,
      temporal: { validAt: now, createdAt: now },
      evidence: [memoryId],
    }))
    await this.store.upsertGraphEdges(edges)
  }

  private async memoryIdsForEntityScope(scope: QueryEntityScope | undefined, identity: typegraphIdentity): Promise<string[] | undefined> {
    const entityIds = await this.resolveEntityScope(scope, identity)
    if (!entityIds) return undefined
    if (entityIds.length === 0) return []
    if (!this.store.getMemoryIdsForEntities) {
      throw new ConfigError('entityScope requires a memory store with entity-memory association lookup.')
    }
    return this.store.getMemoryIdsForEntities(entityIds, identity)
  }

  private async resolveMemoryContext(opts?: MemoryServiceContextOpts | null): Promise<{
    entities: SemanticEntity[]
    entityScope?: QueryEntityScope | undefined
    memoryIds?: string[] | undefined
  }> {
    if (!opts) return { entities: [] }
    const subjects = [opts?.subject, ...(opts?.relatedEntities ?? [])].filter((subject): subject is MemorySubject => !!subject)
    if (subjects.length === 0) return { entities: [] }
    const entities = (await Promise.all(subjects.map(subject => this.resolveMemorySubject(subject, opts.identity, opts?.accessScope))))
      .filter((entity): entity is SemanticEntity => !!entity)
    const entityIds = [...new Set(entities.map(entity => entity.id))]
    if (entityIds.length === 0) return { entities: [] }
    const entityScope: QueryEntityScope = { entityIds }
    const memoryIds = await this.memoryIdsForEntityScope(entityScope, opts.identity)
    return { entities, entityScope, memoryIds }
  }

  private async extractAndStoreFacts(
    content: string,
    opts: MemoryServiceContextOpts,
    source: 'remember' | 'correct',
  ): Promise<{ invalidated: number; created: number }> {
    const extractor = this.createExtractor(opts.identity)
    const invalidation = this.invalidation
    if (!invalidation) {
      throw new ConfigError('Memory graph extraction requires `llm` or a configured extractor.')
    }
    const messages: ConversationMessage[] = [{ role: 'user', content }]
    const candidates = await extractor.extractFacts(messages)
    if (candidates.length === 0) return { invalidated: 0, created: 0 }

    let invalidated = 0
    let created = 0
    const syntheticEpisodeId = generateId('mem')
    const context = await this.resolveMemoryContext(opts)

    for (const candidate of candidates) {
      const fact = extractor.candidateToFact(candidate, syntheticEpisodeId)
      fact.graphId = opts.identity.graphId ?? 'public'
      fact.metadata = { ...fact.metadata, source }
      fact.embedding = await embedText(this.embedding, fact.content)

      const contradictions = await invalidation.checkContradictions(fact, opts.identity, {
        memoryIds: context.memoryIds,
      })
      if (contradictions.length > 0) {
        invalidated += contradictions.length
        this.emit('extraction.contradiction', undefined, {
          factContent: fact.content.slice(0, 100),
          contradictionCount: contradictions.length,
          source,
        }, opts.identity, undefined, opts)
        await invalidation.resolveContradictions(contradictions)
      }

      const stored = await this.store.upsert(fact)
      this.memoriesChecked = true
      this.memoriesExist = true
      await this.linkMemoryToEntities(stored.id, context.entities, opts.identity, opts?.accessScope)
      created++
    }

    return { invalidated, created }
  }

  // ── Store ──

  /**
   * Store an explicit memory. Structured graph extraction is opt-in via
   * `graphExtraction: true`.
   */
  async remember(content: string, rawOpts?: MemoryServiceRememberOpts | null): Promise<MemoryRecord> {
    const opts = optionalCompactObject<MemoryServiceRememberOpts>(rawOpts, 'MemoryService.remember') as MemoryServiceRememberOpts
    const category = opts?.category ?? 'semantic'
    const embedding = await embedText(this.embedding, content)
    const temporal = createTemporal()

    const record: MemoryRecord = {
      id: generateId('mem'),
      graphId: opts.identity.graphId ?? 'public',
      category,
      status: 'active',
      content,
      embedding,
      importance: opts?.importance ?? 0.5,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: opts?.metadata ?? {},
      scope: opts.identity,
      accessScope: opts?.accessScope,
      ...temporal,
    }

    const result = await this.store.upsert(record)
    this.memoriesChecked = true
    this.memoriesExist = true
    const { entities } = await this.resolveMemoryContext(opts)
    await this.linkMemoryToEntities(result.id, entities, opts.identity, opts?.accessScope)
    if (opts?.graphExtraction) {
      await this.extractAndStoreFacts(content, opts, 'remember')
    }
    this.emit('memory.write', result.id, { category, contentLength: content.length }, opts.identity, undefined, opts)
    return result
  }

  /**
   * Forget (invalidate) a memory by ID. Preserves the record with invalidAt set.
   */
  async forget(id: string, rawOpts: MemoryServiceCallOpts): Promise<void> {
    const opts = optionalCompactObject<MemoryServiceCallOpts>(rawOpts, 'MemoryService.forget') as MemoryServiceCallOpts
    await this.store.invalidate(id)
    await this.store.invalidateGraphEdgesForNode?.('memory', id)
    this.emit('memory.invalidate', id, {}, opts.identity, undefined, opts)
  }

  /**
   * Apply a natural language correction to memories.
   * Example: "Actually, John works at Acme Corp, not Beta Inc"
   *
   * Runs the correction through extraction + contradiction machinery by
   * default. `graphExtraction: false` stores the correction as an explicit
   * memory without graph side effects.
   */
  async correct(naturalLanguageCorrection: string, rawOpts?: MemoryServiceContextOpts | null): Promise<{
    invalidated: number
    created: number
    summary: string
  }> {
    const opts = optionalCompactObject<MemoryServiceContextOpts>(rawOpts, 'MemoryService.correct') as MemoryServiceContextOpts
    if (opts?.graphExtraction === false) {
      await this.remember(naturalLanguageCorrection, {
        ...opts,
        category: 'semantic',
        metadata: { correction: true },
        graphExtraction: false,
      })
      return { invalidated: 0, created: 1, summary: 'Stored correction without graph extraction' }
    }
    const extractor = this.createExtractor(opts.identity)
    const invalidation = this.invalidation
    if (!invalidation) {
      throw new ConfigError('Memory correction requires `llm` or a configured extractor.')
    }
    const messages: ConversationMessage[] = [
      { role: 'user', content: naturalLanguageCorrection },
    ]

    const candidates = await extractor.extractFacts(messages)
    if (candidates.length === 0) {
      this.emit('memory.correct', undefined, {
        correction: naturalLanguageCorrection.slice(0, 100),
        invalidated: 0,
        created: 0,
      }, opts.identity, undefined, opts)
      return { invalidated: 0, created: 0, summary: 'Could not parse correction' }
    }

    let invalidated = 0
    let created = 0
    const syntheticEpisodeId = generateId('mem')
    const context = await this.resolveMemoryContext(opts)

    for (const candidate of candidates) {
      const fact = extractor.candidateToFact(candidate, syntheticEpisodeId)
      fact.graphId = opts.identity.graphId ?? 'public'
      fact.metadata = { ...fact.metadata, correctionText: naturalLanguageCorrection }
      fact.embedding = await embedText(this.embedding, fact.content)

      const contradictions = await invalidation.checkContradictions(fact, opts.identity, {
        memoryIds: context.memoryIds,
      })
      if (contradictions.length > 0) {
        invalidated += contradictions.length
        this.emit('extraction.contradiction', undefined, {
          factContent: fact.content.slice(0, 100),
          contradictionCount: contradictions.length,
          source: 'correct',
        }, opts.identity, undefined, opts)
        await invalidation.resolveContradictions(contradictions)
      }

      const stored = await this.store.upsert(fact)
      this.memoriesChecked = true
      this.memoriesExist = true
      await this.linkMemoryToEntities(stored.id, context.entities, opts.identity, opts?.accessScope)
      created++
    }

    const summary = `Invalidated ${invalidated} fact(s), created ${created} corrected fact(s)`
    this.emit('memory.correct', undefined, {
      correction: naturalLanguageCorrection.slice(0, 100),
      invalidated,
      created,
    }, opts.identity, undefined, opts)
    return { invalidated, created, summary }
  }

  // ── Retrieve ──

  /**
   * Unified recall across all memory types.
   * When `opts.format` is set, returns a formatted string grouped by category
   * suitable for dropping into an LLM prompt.
   */
  async recall(query: string, opts: RecallOptsWithFormat): Promise<string>
  async recall(query: string, opts?: MemoryServiceRecallOpts | null): Promise<MemoryRecord[]>
  async recall(query: string, rawOpts?: MemoryServiceRecallOpts | null): Promise<MemoryRecord[] | string> {
    const opts = optionalCompactObject<MemoryServiceRecallOpts>(rawOpts, 'MemoryService.recall') as MemoryServiceRecallOpts
    const embedding = await embedText(this.embedding, query, 'search')
    const scopedMemoryIds = await this.memoryIdsForEntityScope(opts?.entityScope, opts.identity)
    const results = await this.store.search(embedding, {
      count: opts?.limit ?? 10,
      filter: {
        scope: opts.identity,
        graphIds: opts?.graphIds ?? (opts.identity.graphId ? [opts.identity.graphId] : undefined),
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
    }, opts.identity, undefined, opts)

    if (opts?.format) return formatRecords(results, opts.format)
    return results
  }

  async recallHybrid(query: string, opts: RecallOptsWithFormat): Promise<string>
  async recallHybrid(query: string, opts?: MemoryServiceRecallOpts | null): Promise<MemoryRecord[]>
  async recallHybrid(query: string, rawOpts?: MemoryServiceRecallOpts | null): Promise<MemoryRecord[] | string> {
    const opts = optionalCompactObject<MemoryServiceRecallOpts>(rawOpts, 'MemoryService.recallHybrid') as MemoryServiceRecallOpts
    const embedding = await embedText(this.embedding, query, 'search')
    const scopedMemoryIds = await this.memoryIdsForEntityScope(opts?.entityScope, opts.identity)
    const searchOpts = {
      count: opts?.limit ?? 10,
      filter: {
        scope: opts.identity,
        graphIds: opts?.graphIds ?? (opts.identity.graphId ? [opts.identity.graphId] : undefined),
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
    }, opts.identity, undefined, opts)

    if (opts?.format) return formatRecords(results, opts.format)
    return results
  }

  // ── Health ──

  /**
   * Return a snapshot of memory system health and statistics.
   * Uses count methods on the adapter when available; falls back to list() sampling.
   */
  async healthCheck(rawOpts: MemoryServiceCallOpts): Promise<MemoryHealthReport> {
    optionalCompactObject<MemoryServiceCallOpts>(rawOpts, 'MemoryService.healthCheck')
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

  async hasMemories(): Promise<boolean> {
    if (this.memoriesChecked) return this.memoriesExist
    try {
      const results = await this.store.list({ status: 'active' }, 1)
      this.memoriesExist = results.length > 0
    } catch (err) {
      this.memoriesExist = false
    }
    this.memoriesChecked = true
    return this.memoriesExist
  }

  async deploy(): Promise<void> {
    await this.store.initialize()
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
function formatRecords(records: MemoryRecord[], format: MemoryRecallFormat): string {
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
