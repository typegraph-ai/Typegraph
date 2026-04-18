import type { EmbeddingProvider } from '../embedding/provider.js'
import type { typegraphEventSink, typegraphEventType, TelemetryOpts } from '../types/events.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { typegraphIdentity } from '../types/identity.js'
import type {
  MemoryRecord,
  MemoryCategory,
  SemanticFact,
  EpisodicMemory,
  ProceduralMemory,
} from './types/memory.js'
import type { LLMProvider } from './extraction/llm-provider.js'
import type { ExtractionResult, ConversationMessage } from './extraction/extractor.js'
import { MemoryExtractor } from './extraction/extractor.js'
import { InvalidationEngine } from './extraction/invalidation.js'
import { createTemporal } from './temporal.js'
import { generateId } from '../utils/id.js'

// ── Recall option shapes ──

type RecallFormat = 'xml' | 'markdown' | 'plain'

interface RecallOptsInternal extends TelemetryOpts {
  types?: MemoryCategory[] | undefined
  limit?: number | undefined
  asOf?: Date | undefined
  /** Include invalidated/expired memories. Default: false. */
  includeInvalidated?: boolean | undefined
  /** Return a formatted string instead of `MemoryRecord[]`. */
  format?: RecallFormat | undefined
}

type RecallOptsWithFormat = RecallOptsInternal & { format: RecallFormat }

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

  // ── Store ──

  /**
   * Store a memory. Creates a record in the given category (default: `semantic`).
   * For LLM extraction of structured facts from a conversation, use `addConversationTurn()`.
   */
  async remember(content: string, opts?: {
    category?: MemoryCategory | undefined
    importance?: number | undefined
    metadata?: Record<string, unknown> | undefined
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
      ...temporal,
    }

    const result = await this.store.upsert(record)
    this.emit('memory.write', result.id, { category, contentLength: content.length }, undefined, opts)
    return result
  }

  /**
   * Forget (invalidate) a memory by ID. Preserves the record with invalidAt set.
   */
  async forget(id: string, telemetry?: TelemetryOpts): Promise<void> {
    await this.store.invalidate(id)
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
  async correct(naturalLanguageCorrection: string, telemetry?: TelemetryOpts): Promise<{
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
      }, undefined, telemetry)
      return { invalidated: 0, created: 0, summary: 'Could not parse correction' }
    }

    let invalidated = 0
    let created = 0
    const syntheticEpisodeId = generateId('mem')

    for (const candidate of candidates) {
      const fact = this.extractor.candidateToFact(candidate, syntheticEpisodeId)
      fact.metadata = { ...fact.metadata, correctionText: naturalLanguageCorrection }
      fact.embedding = await this.embedding.embed(fact.content)

      const contradictions = await this.invalidation.checkContradictions(fact, this.scope)
      if (contradictions.length > 0) {
        invalidated += contradictions.length
        this.emit('extraction.contradiction', undefined, {
          factContent: fact.content.slice(0, 100),
          contradictionCount: contradictions.length,
          source: 'correct',
        }, undefined, telemetry)
        await this.invalidation.resolveContradictions(contradictions)
      }

      await this.store.upsert(fact)
      created++
    }

    const summary = `Invalidated ${invalidated} fact(s), created ${created} corrected fact(s)`
    this.emit('memory.correct', undefined, {
      correction: naturalLanguageCorrection.slice(0, 100),
      invalidated,
      created,
    }, undefined, telemetry)
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
    const results = await this.store.search(embedding, {
      count: opts?.limit ?? 10,
      filter: {
        scope: this.scope,
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
    const searchOpts = {
      count: opts?.limit ?? 10,
      filter: {
        scope: this.scope,
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
    telemetry?: TelemetryOpts,
  ): Promise<ExtractionResult> {
    // Get existing facts for conflict resolution
    const existingFacts = await this.recallFacts(
      messages.map(m => m.content).join(' '),
      20,
      telemetry,
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
      this.emit('memory.write', stored.id, { category: 'episodic', source: 'conversation' }, undefined, telemetry)
    }

    // Store new facts and check for contradictions
    let contradictionCount = 0
    const allContradictions: Array<{ existingId: string; newId: string; conflictType: string; reasoning: string }> = []
    for (const fact of result.facts) {
      fact.embedding = await this.embedding.embed(fact.content)

      // Check contradictions before storing
      const contradictions = await this.invalidation.checkContradictions(fact, this.scope)
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
        }, undefined, telemetry)
        await this.invalidation.resolveContradictions(contradictions)
      }

      const stored = await this.store.upsert(fact)
      this.emit('memory.write', stored.id, { category: 'semantic', source: 'conversation' }, undefined, telemetry)
    }

    this.emit('extraction.facts', undefined, {
      episodicCount: result.episodic.length,
      factCount: result.facts.length,
      contradictionCount,
      conversationId,
    }, undefined, telemetry)

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
      const { decayScore, DEFAULT_DECAY_CONFIG } = await import('./consolidation/decay.js')
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
