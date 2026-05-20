import type { Embedder } from '../embedding/provider.js'
import { embedText } from '../embedding/provider.js'
import type { typegraphEventSink, typegraphEventType, TelemetryOpts } from '../types/events.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { AccessScope, typegraphIdentity } from '../types/identity.js'
import type {
  ConversationMemoryExtraction,
  ConsolidateMemoryOpts,
  MemoryArtifactDeleteOpts,
  MemoryArtifactGetOpts,
  MemoryArtifactListOpts,
  MemoryArtifactUpsert,
  MemoryContextOpts,
  MemoryContextResult,
  MemoryConsolidationResult,
} from '../types/graph-bridge.js'
import type {
  MemoryRecord,
  MemoryArtifact,
  MemoryArtifactKind,
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
import { sha256 } from '../index-engine/hash.js'
import {
  DEFAULT_MEMORY_LAYOUT_ID,
  MEMORY_HANDBOOK_PATH,
  MEMORY_SUMMARY_PATH,
  PHASE_TWO_SELECTION_PATH,
  RAW_MEMORIES_PATH,
  type ConversationMemoryMessage,
  conversationExtractionSchema,
  fallbackMemorySummary,
  memoryConsolidationSchema,
  normalizeArtifactPath,
  normalizeConversationSlug,
  normalizeLayoutId,
  rawMemoryPath,
  redactMemorySecrets,
  renderConversationExtractionPrompt,
  renderConversationTranscript,
  renderMemoryConsolidationPrompt,
  rolloutSummaryPath,
} from './conversation.js'

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

export interface MemoryServiceArtifactListOpts extends MemoryServiceCallOpts {
  layoutId?: string | undefined
  prefix?: string | undefined
  kind?: MemoryArtifactKind | MemoryArtifactKind[] | undefined
}

export interface MemoryServiceExtractConversationOpts extends MemoryServiceCallOpts {
  conversationId: string
  messages: ConversationMemoryMessage[]
  layoutId?: string | undefined
  includeRoles?: ConversationMemoryMessage['role'][] | undefined
  maxTranscriptChars?: number | undefined
}

export interface MemoryServiceConsolidateOpts extends MemoryServiceCallOpts {
  layoutId?: string | undefined
  maxRawMemories?: number | undefined
}

export interface MemoryServiceContextResult extends MemoryContextResult {}

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

  private requireArtifactStore(): Required<Pick<
    MemoryStoreAdapter,
    'upsertArtifact' | 'getArtifact' | 'listArtifacts' | 'deleteArtifact'
  >> {
    if (!this.store.upsertArtifact || !this.store.getArtifact || !this.store.listArtifacts || !this.store.deleteArtifact) {
      throw new ConfigError('Memory artifacts require a memory store with artifact persistence.')
    }
    return {
      upsertArtifact: this.store.upsertArtifact.bind(this.store),
      getArtifact: this.store.getArtifact.bind(this.store),
      listArtifacts: this.store.listArtifacts.bind(this.store),
      deleteArtifact: this.store.deleteArtifact.bind(this.store),
    }
  }

  private async upsertArtifactInternal(args: {
    identity: typegraphIdentity
    layoutId?: string | undefined
    path: string
    kind: MemoryArtifactKind
    content: string
    metadata?: Record<string, unknown> | undefined
  }): Promise<MemoryArtifact> {
    const store = this.requireArtifactStore()
    return store.upsertArtifact({
      identity: args.identity,
      layoutId: normalizeLayoutId(args.layoutId),
      path: normalizeArtifactPath(args.path),
      kind: args.kind,
      content: args.content,
      contentHash: sha256(args.content),
      metadata: args.metadata ?? {},
    })
  }

  async upsertArtifact(input: MemoryArtifactUpsert, rawOpts: MemoryServiceCallOpts): Promise<MemoryArtifact> {
    optionalCompactObject<MemoryServiceCallOpts>(rawOpts, 'MemoryService.upsertArtifact')
    return this.upsertArtifactInternal({
      identity: rawOpts.identity,
      layoutId: input.layoutId,
      path: input.path,
      kind: input.kind ?? inferArtifactKind(input.path),
      content: input.content,
      metadata: input.metadata,
    })
  }

  async getArtifact(path: string, rawOpts: MemoryServiceCallOpts & MemoryArtifactGetOpts): Promise<MemoryArtifact | null> {
    optionalCompactObject(rawOpts, 'MemoryService.getArtifact')
    const store = this.requireArtifactStore()
    return store.getArtifact(rawOpts.identity, normalizeLayoutId(rawOpts.layoutId), normalizeArtifactPath(path))
  }

  async listArtifacts(rawOpts: MemoryServiceArtifactListOpts): Promise<MemoryArtifact[]> {
    optionalCompactObject(rawOpts, 'MemoryService.listArtifacts')
    const store = this.requireArtifactStore()
    return store.listArtifacts({
      identity: rawOpts.identity,
      graphIds: rawOpts.graphIds,
      layoutId: rawOpts.layoutId ? normalizeLayoutId(rawOpts.layoutId) : undefined,
      prefix: rawOpts.prefix ? normalizeArtifactPath(rawOpts.prefix) : undefined,
      kind: rawOpts.kind,
    })
  }

  async deleteArtifact(path: string, rawOpts: MemoryServiceCallOpts & MemoryArtifactDeleteOpts): Promise<void> {
    optionalCompactObject(rawOpts, 'MemoryService.deleteArtifact')
    const store = this.requireArtifactStore()
    await store.deleteArtifact(rawOpts.identity, normalizeLayoutId(rawOpts.layoutId), normalizeArtifactPath(path))
  }

  async extractConversation(rawOpts: MemoryServiceExtractConversationOpts): Promise<ConversationMemoryExtraction> {
    const opts = optionalCompactObject<MemoryServiceExtractConversationOpts>(rawOpts, 'MemoryService.extractConversation') as MemoryServiceExtractConversationOpts
    if (!this.llm) throw new ConfigError('Conversation memory extraction requires `llm`.')
    const layoutId = normalizeLayoutId(opts.layoutId)
    const includeRoles = new Set(opts.includeRoles ?? ['user', 'assistant', 'tool'])
    const messages = opts.messages
      .filter(message => includeRoles.has(message.role))
      .filter(message => message.content.trim().length > 0)
      .map(message => ({ ...message, content: redactMemorySecrets(message.content) }))
    const emptyResult: ConversationMemoryExtraction = {
      conversationId: opts.conversationId,
      layoutId,
      noOp: true,
      keywords: [],
      artifacts: {},
    }
    if (messages.length === 0) return emptyResult

    const transcript = renderConversationTranscript(messages, opts.maxTranscriptChars)
    let output: {
      conversation_summary: string
      conversation_slug: string
      raw_memory: string
      task_outcome: 'success' | 'partial' | 'fail' | 'uncertain'
      keywords: string[]
      references: string[]
    }
    try {
      output = await this.llm.generateJSON(
        renderConversationExtractionPrompt({ conversationId: opts.conversationId, transcript }),
        undefined,
        { schema: conversationExtractionSchema },
      )
    } catch {
      return emptyResult
    }

    const hasSummary = output.conversation_summary?.trim().length > 0
    const hasRaw = output.raw_memory?.trim().length > 0
    const hasSlug = output.conversation_slug?.trim().length > 0
    if (!hasSummary && !hasRaw && !hasSlug) return emptyResult
    if (!hasSummary || !hasRaw) return emptyResult

    const slug = normalizeConversationSlug(output.conversation_slug, opts.conversationId)
    const rawPath = rawMemoryPath(opts.conversationId)
    const summaryPath = rolloutSummaryPath(opts.conversationId, slug)
    const updatedAt = new Date().toISOString()
    const rawMemoryContent = formatRawConversationMemory({
      conversationId: opts.conversationId,
      updatedAt,
      rolloutSummaryFile: summaryPath,
      output,
    })
    const rolloutSummaryContent = formatConversationSummary({
      conversationId: opts.conversationId,
      updatedAt,
      output,
    })
    const rawMemory = await this.upsertArtifactInternal({
      identity: opts.identity,
      layoutId,
      path: rawPath,
      kind: 'raw_memory',
      content: rawMemoryContent,
      metadata: {
        conversationId: opts.conversationId,
        rolloutSummaryFile: summaryPath,
        taskOutcome: output.task_outcome,
        keywords: output.keywords,
        references: output.references,
        description: firstMetadataLine(output.raw_memory, 'description') ?? output.conversation_summary.split('\n').find(Boolean) ?? '',
      },
    })
    const rolloutSummary = await this.upsertArtifactInternal({
      identity: opts.identity,
      layoutId,
      path: summaryPath,
      kind: 'rollout_summary',
      content: rolloutSummaryContent,
      metadata: {
        conversationId: opts.conversationId,
        rawMemoryFile: rawPath,
        taskOutcome: output.task_outcome,
        keywords: output.keywords,
        references: output.references,
      },
    })
    const rawMemories = await this.rebuildRawMemoriesArtifact(opts.identity, layoutId)
    return {
      conversationId: opts.conversationId,
      layoutId,
      noOp: false,
      taskOutcome: output.task_outcome,
      keywords: output.keywords,
      artifacts: { rawMemory, rolloutSummary, rawMemories },
    }
  }

  async consolidate(rawOpts: MemoryServiceConsolidateOpts): Promise<MemoryConsolidationResult> {
    const opts = optionalCompactObject<MemoryServiceConsolidateOpts>(rawOpts, 'MemoryService.consolidate') as MemoryServiceConsolidateOpts
    const layoutId = normalizeLayoutId(opts.layoutId)
    const rawArtifacts = await this.selectedRawMemoryArtifacts(opts.identity, layoutId, opts.maxRawMemories)
    const rawMemories = await this.rebuildRawMemoriesArtifact(opts.identity, layoutId, rawArtifacts)
    const existingMemory = await this.getArtifact(MEMORY_HANDBOOK_PATH, { identity: opts.identity, layoutId })
    const existingSummary = await this.getArtifact(MEMORY_SUMMARY_PATH, { identity: opts.identity, layoutId })
    const selection = {
      version: 1,
      updated_at: new Date().toISOString(),
      selected: rawArtifacts.map(artifact => ({
        path: artifact.path,
        updated_at: artifact.updatedAt.toISOString(),
        conversation_id: artifact.metadata.conversationId,
        rollout_summary_file: artifact.metadata.rolloutSummaryFile,
        task_outcome: artifact.metadata.taskOutcome,
      })),
    }
    let consolidated: { memory: string; memory_summary: string; skills?: Array<{ name: string; content: string }> | undefined }
    if (rawArtifacts.length === 0 || !this.llm) {
      consolidated = {
        memory: existingMemory?.content || '# Task Group: Conversation memory\n\nscope: No durable conversation memory has been consolidated yet.\n',
        memory_summary: fallbackMemorySummary(rawArtifacts),
      }
    } else {
      try {
        consolidated = await this.llm.generateJSON(
          renderMemoryConsolidationPrompt({
            rawMemories: rawArtifacts.map(artifact => artifact.content).join('\n\n'),
            existingMemory: existingMemory?.content,
            existingSummary: existingSummary?.content,
            selectionJson: JSON.stringify(selection, null, 2),
          }),
          undefined,
          { schema: memoryConsolidationSchema },
        )
      } catch {
        consolidated = {
          memory: fallbackMemoryHandbook(rawArtifacts),
          memory_summary: fallbackMemorySummary(rawArtifacts),
        }
      }
    }

    const handbook = await this.upsertArtifactInternal({
      identity: opts.identity,
      layoutId,
      path: MEMORY_HANDBOOK_PATH,
      kind: 'handbook',
      content: ensureTrailingNewline(consolidated.memory || fallbackMemoryHandbook(rawArtifacts)),
      metadata: { selected: rawArtifacts.length },
    })
    const summary = await this.upsertArtifactInternal({
      identity: opts.identity,
      layoutId,
      path: MEMORY_SUMMARY_PATH,
      kind: 'summary',
      content: ensureTrailingNewline(consolidated.memory_summary || fallbackMemorySummary(rawArtifacts)),
      metadata: { selected: rawArtifacts.length },
    })
    for (const skill of consolidated.skills ?? []) {
      const name = normalizeConversationSlug(skill.name, 'skill')
      await this.upsertArtifactInternal({
        identity: opts.identity,
        layoutId,
        path: `skills/${name}/SKILL.md`,
        kind: 'skill',
        content: ensureTrailingNewline(skill.content),
        metadata: { name },
      })
    }
    const phaseTwoSelection = await this.upsertArtifactInternal({
      identity: opts.identity,
      layoutId,
      path: PHASE_TWO_SELECTION_PATH,
      kind: 'phase_two_selection',
      content: `${JSON.stringify(selection, null, 2)}\n`,
      metadata: { selected: rawArtifacts.length },
    })
    return {
      layoutId,
      selected: rawArtifacts.length,
      artifacts: {
        handbook,
        summary,
        rawMemories,
        phaseTwoSelection,
      },
    }
  }

  async context(query: string, rawOpts: MemoryServiceRecallOpts & MemoryContextOpts): Promise<MemoryServiceContextResult> {
    const opts = optionalCompactObject<MemoryServiceRecallOpts & MemoryContextOpts>(rawOpts, 'MemoryService.context') as MemoryServiceRecallOpts & MemoryContextOpts
    const layoutId = normalizeLayoutId(opts.layoutId)
    const summary = await this.getArtifact(MEMORY_SUMMARY_PATH, { identity: opts.identity, layoutId })
    const handbook = await this.getArtifact(MEMORY_HANDBOOK_PATH, { identity: opts.identity, layoutId })
    const handbookExcerpt = handbook?.content ? selectHandbookBlocks(handbook.content, query, opts.handbookLimit ?? 2) : ''
    const artifacts = [summary, handbook].filter((artifact): artifact is MemoryArtifact => !!artifact)
    const prompt = renderMemoryContextPrompt({
      summary: summary?.content,
      handbook: handbookExcerpt,
    })
    const recall = opts.includeStructuredRecall
      ? await this.recall(query, {
        ...opts,
        format: opts.format,
      } as MemoryServiceRecallOpts)
      : undefined
    return {
      layoutId,
      summary: summary?.content,
      handbook: handbookExcerpt || undefined,
      recall,
      artifacts,
      prompt,
    }
  }

  private async selectedRawMemoryArtifacts(identity: typegraphIdentity, layoutId: string, maxRawMemories = 256): Promise<MemoryArtifact[]> {
    const artifacts = await this.listArtifacts({
      identity,
      layoutId,
      prefix: 'raw_memories',
      kind: 'raw_memory',
    })
    return artifacts
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.path.localeCompare(left.path))
      .slice(0, Math.max(1, maxRawMemories))
  }

  private async rebuildRawMemoriesArtifact(identity: typegraphIdentity, layoutId: string, selected?: MemoryArtifact[]): Promise<MemoryArtifact> {
    const rawArtifacts = selected ?? await this.selectedRawMemoryArtifacts(identity, layoutId)
    return this.upsertArtifactInternal({
      identity,
      layoutId,
      path: RAW_MEMORIES_PATH,
      kind: 'raw_memories',
      content: rawArtifacts.map(artifact => artifact.content.trimEnd()).filter(Boolean).join('\n\n'),
      metadata: { selected: rawArtifacts.map(artifact => artifact.path) },
    })
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

function inferArtifactKind(path: string): MemoryArtifactKind {
  const normalized = normalizeArtifactPath(path)
  if (normalized === MEMORY_SUMMARY_PATH) return 'summary'
  if (normalized === MEMORY_HANDBOOK_PATH) return 'handbook'
  if (normalized === RAW_MEMORIES_PATH) return 'raw_memories'
  if (normalized === PHASE_TWO_SELECTION_PATH) return 'phase_two_selection'
  if (normalized.startsWith('raw_memories/')) return 'raw_memory'
  if (normalized.startsWith('rollout_summaries/')) return 'rollout_summary'
  if (normalized.startsWith('skills/')) return 'skill'
  return 'other'
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
}

function firstMetadataLine(content: string, key: string): string | undefined {
  const prefix = `${key}:`
  for (const line of content.split('\n')) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
  }
  return undefined
}

function formatRawConversationMemory(args: {
  conversationId: string
  updatedAt: string
  rolloutSummaryFile: string
  output: {
    conversation_summary: string
    raw_memory: string
    task_outcome: string
    keywords: string[]
    references: string[]
  }
}): string {
  return [
    `conversation_id: ${args.conversationId}`,
    `updated_at: ${args.updatedAt}`,
    `rollout_summary_file: ${args.rolloutSummaryFile}`,
    `task_outcome: ${args.output.task_outcome}`,
    `keywords: ${args.output.keywords.join(', ')}`,
    '',
    args.output.raw_memory.trimEnd(),
    '',
  ].join('\n')
}

function formatConversationSummary(args: {
  conversationId: string
  updatedAt: string
  output: {
    conversation_summary: string
    task_outcome: string
    keywords: string[]
    references: string[]
  }
}): string {
  return [
    `conversation_id: ${args.conversationId}`,
    `updated_at: ${args.updatedAt}`,
    `task_outcome: ${args.output.task_outcome}`,
    `keywords: ${args.output.keywords.join(', ')}`,
    '',
    args.output.conversation_summary.trimEnd(),
    '',
    '## References',
    '',
    ...args.output.references.map(reference => `- ${reference}`),
    '',
  ].join('\n')
}

function fallbackMemoryHandbook(rawArtifacts: MemoryArtifact[]): string {
  if (rawArtifacts.length === 0) {
    return '# Task Group: Conversation memory\n\nscope: No durable conversation memory has been consolidated yet.\n'
  }
  return rawArtifacts.map((artifact, index) => {
    const description = typeof artifact.metadata.description === 'string'
      ? artifact.metadata.description
      : artifact.path
    const keywords = Array.isArray(artifact.metadata.keywords)
      ? artifact.metadata.keywords.join(', ')
      : artifact.path
    return [
      `# Task Group: ${description || `Conversation memory ${index + 1}`}`,
      '',
      `scope: Use when the task relates to ${keywords || artifact.path}.`,
      '',
      `## Task 1: ${description || artifact.path}`,
      '',
      '### rollout_summary_files',
      '',
      `- ${String(artifact.metadata.rolloutSummaryFile ?? artifact.path)} (conversation_id=${String(artifact.metadata.conversationId ?? '')}, updated_at=${artifact.updatedAt.toISOString()}, task_outcome=${String(artifact.metadata.taskOutcome ?? 'uncertain')})`,
      '',
      '### keywords',
      '',
      `- ${keywords}`,
      '',
      '## Reusable knowledge',
      '',
      artifact.content.trimEnd(),
      '',
    ].join('\n')
  }).join('\n')
}

function selectHandbookBlocks(memory: string, query: string, limit: number): string {
  const blocks = memory
    .split(/\n(?=# Task Group: )/g)
    .map(block => block.trim())
    .filter(Boolean)
  if (blocks.length === 0) return ''
  const terms = query.toLowerCase().split(/[^a-z0-9_/-]+/).filter(term => term.length > 2)
  const scored = blocks.map((block, index) => {
    const haystack = block.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
    return { block, score, index }
  })
  const selected = scored
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, limit))
  return selected.map(item => item.block).join('\n\n')
}

function renderMemoryContextPrompt(args: {
  summary?: string | undefined
  handbook?: string | undefined
}): string {
  const sections: string[] = []
  if (args.summary?.trim()) {
    sections.push(`## Memory Summary\n\n${args.summary.trim()}`)
  }
  if (args.handbook?.trim()) {
    sections.push(`## Relevant Memory Handbook\n\n${args.handbook.trim()}`)
  }
  return sections.length > 0 ? sections.join('\n\n') : ''
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
