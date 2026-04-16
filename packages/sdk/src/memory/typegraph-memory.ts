import { z } from 'zod'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { typegraphEventSink, typegraphEventType } from '../types/events.js'
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
import { WorkingMemory, type WorkingMemoryConfig } from './working-memory.js'
import { createTemporal } from './temporal.js'
import { generateId } from '../utils/id.js'

// ── Zod schema for structured output ──

const correctionSchema = z.object({
  targetContent: z.string().optional(),
  newContent: z.string().optional(),
  subject: z.string().optional(),
  predicate: z.string().optional(),
  object: z.string().optional(),
})

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
  workingMemory?: WorkingMemoryConfig | undefined
  eventSink?: typegraphEventSink | undefined
}

// ── TypegraphMemory ──
// Unified developer-facing API for cognitive memory.
// Imperative mode - direct calls, instant results.
// Same engines used by job system for automation.

export class TypegraphMemory {
  readonly working: WorkingMemory
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
    this.working = new WorkingMemory(config.workingMemory)

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

  private emit(eventType: typegraphEventType, targetId: string | undefined, payload: Record<string, unknown>, durationMs?: number): void {
    if (!this.eventSink) return
    this.eventSink.emit({
      id: crypto.randomUUID(),
      eventType,
      identity: this.scope,
      targetId,
      payload,
      durationMs,
      timestamp: new Date(),
    })
  }

  // ── Store ──

  /**
   * Store a memory. If content is a plain string, creates a semantic fact
   * with LLM extraction. For full control, use addConversationTurn().
   */
  async remember(content: string, category: MemoryCategory = 'semantic', opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
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
    this.emit('memory.write', result.id, { category, contentLength: content.length })
    return result
  }

  /**
   * Forget (invalidate) a memory by ID. Preserves the record with invalidAt set.
   */
  async forget(id: string): Promise<void> {
    await this.store.invalidate(id)
    this.emit('memory.invalidate', id, {})
  }

  /**
   * Apply a natural language correction to memories.
   * Example: "Actually, John works at Acme Corp, not Beta Inc"
   */
  async correct(naturalLanguageCorrection: string): Promise<{
    invalidated: number
    created: number
    summary: string
  }> {
    // Lazy import to avoid circular deps with consolidation
    const parsed = await this.llm.generateJSON<{
      targetContent?: string
      newContent?: string
      subject?: string
      predicate?: string
      object?: string
    }>(
      `Parse this memory correction: "${naturalLanguageCorrection}"
Respond with JSON: {"targetContent": "...", "newContent": "...", "subject": "...", "predicate": "...", "object": "..."}`,
      undefined,
      { schema: correctionSchema },
    )

    if (!parsed.newContent) {
      return { invalidated: 0, created: 0, summary: 'Could not parse correction' }
    }

    // Find and invalidate matching facts
    const existing = await this.store.list({ scope: this.scope, category: 'semantic' }, 50)
    const semanticFacts = existing.filter((r): r is SemanticFact => r.category === 'semantic')

    let invalidated = 0
    if (parsed.targetContent) {
      const target = parsed.targetContent.toLowerCase()
      for (const fact of semanticFacts) {
        if (fact.content.toLowerCase().includes(target) || target.includes(fact.content.toLowerCase())) {
          await this.store.invalidate(fact.id)
          invalidated++
        }
      }
    }

    // Create corrected fact
    const embedding = await this.embedding.embed(parsed.newContent)
    const newFact: SemanticFact = {
      id: generateId('fact'),
      category: 'semantic',
      status: 'active',
      content: parsed.newContent,
      subject: parsed.subject ?? '',
      predicate: parsed.predicate ?? '',
      object: parsed.object ?? '',
      confidence: 0.95,
      sourceMemoryIds: [],
      importance: 0.7,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: { correctionText: naturalLanguageCorrection },
      scope: this.scope,
      embedding,
      ...createTemporal(),
    }

    await this.store.upsert(newFact)

    const summary = `Invalidated ${invalidated} fact(s), created 1 corrected fact`
    this.emit('memory.correct', undefined, { correction: naturalLanguageCorrection.slice(0, 100) })
    return { invalidated, created: 1, summary }
  }

  // ── Retrieve ──

  /**
   * Unified recall across all memory types.
   */
  async recall(query: string, opts?: {
    types?: MemoryCategory[] | undefined
    limit?: number | undefined
    asOf?: Date | undefined
  }): Promise<MemoryRecord[]> {
    const embedding = await this.embedding.embed(query)
    const results = await this.store.search(embedding, {
      count: opts?.limit ?? 10,
      filter: {
        scope: this.scope,
        category: opts?.types,
      },
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
    })
    return results
  }

  async recallHybrid(query: string, opts?: {
    types?: MemoryCategory[] | undefined
    limit?: number | undefined
    asOf?: Date | undefined
  }): Promise<MemoryRecord[]> {
    const embedding = await this.embedding.embed(query)
    const searchOpts = {
      count: opts?.limit ?? 10,
      filter: {
        scope: this.scope,
        category: opts?.types,
      } as import('./types/adapter.js').MemoryFilter,
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
    })
    return results
  }

  /**
   * Recall only semantic facts.
   */
  async recallFacts(query: string, limit: number = 10): Promise<SemanticFact[]> {
    const results = await this.recall(query, { types: ['semantic'], limit })
    const facts = results.filter((r): r is SemanticFact => r.category === 'semantic')
    this.emit('memory.read', undefined, { query: query.slice(0, 100), resultCount: facts.length, source: 'facts' })
    return facts
  }

  /**
   * Recall only episodic memories.
   */
  async recallEpisodes(query: string, limit: number = 10): Promise<EpisodicMemory[]> {
    const results = await this.recall(query, { types: ['episodic'], limit })
    return results.filter((r): r is EpisodicMemory => r.category === 'episodic')
  }

  /**
   * Recall procedural memories matching a trigger.
   */
  async recallProcedures(trigger: string, limit: number = 5): Promise<ProceduralMemory[]> {
    const results = await this.recall(trigger, { types: ['procedural'], limit })
    return results.filter((r): r is ProceduralMemory => r.category === 'procedural')
  }

  // ── Conversation ──

  /**
   * Ingest a conversation turn. Extracts episodic memory + semantic facts.
   */
  async addConversationTurn(
    messages: ConversationMessage[],
    conversationId?: string,
  ): Promise<ExtractionResult> {
    // Get existing facts for conflict resolution
    const existingFacts = await this.recallFacts(
      messages.map(m => m.content).join(' '),
      20,
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
      this.emit('memory.write', stored.id, { category: 'episodic', source: 'conversation' })
    }

    // Store new facts and check for contradictions
    let contradictionCount = 0
    for (const fact of result.facts) {
      fact.embedding = await this.embedding.embed(fact.content)

      // Check contradictions before storing
      const contradictions = await this.invalidation.checkContradictions(fact, this.scope)
      if (contradictions.length > 0) {
        contradictionCount += contradictions.length
        this.emit('extraction.contradiction', undefined, {
          factContent: fact.content.slice(0, 100),
          contradictionCount: contradictions.length,
        })
        await this.invalidation.resolveContradictions(contradictions)
      }

      const stored = await this.store.upsert(fact)
      this.emit('memory.write', stored.id, { category: 'semantic', source: 'conversation' })
    }

    this.emit('extraction.facts', undefined, {
      episodicCount: result.episodic.length,
      factCount: result.facts.length,
      contradictionCount,
      conversationId,
    })

    return result
  }

  // ── Context Assembly ──

  /**
   * Build LLM-ready context string from memory.
   */
  async assembleContext(query: string, opts?: {
    includeWorking?: boolean | undefined
    includeFacts?: boolean | undefined
    includeEpisodes?: boolean | undefined
    includeProcedures?: boolean | undefined
    maxMemoryTokens?: number | undefined
    format?: 'xml' | 'markdown' | 'plain' | undefined
  }): Promise<string> {
    const sections: string[] = []
    const format = opts?.format ?? 'xml'

    // Working memory
    if (opts?.includeWorking !== false && this.working.size > 0) {
      const workingContext = this.working.toContext()
      if (format === 'xml') {
        sections.push(`<working_memory>\n${workingContext}\n</working_memory>`)
      } else {
        sections.push(`## Working Memory\n${workingContext}`)
      }
    }

    // Semantic facts
    if (opts?.includeFacts !== false) {
      const facts = await this.recallFacts(query, 10)
      if (facts.length > 0) {
        const factLines = facts.map(f => `- ${f.content}`).join('\n')
        if (format === 'xml') {
          sections.push(`<semantic_memory>\n${factLines}\n</semantic_memory>`)
        } else {
          sections.push(`## Known Facts\n${factLines}`)
        }
      }
    }

    // Episodic memories
    if (opts?.includeEpisodes) {
      const episodes = await this.recallEpisodes(query, 5)
      if (episodes.length > 0) {
        const epLines = episodes.map(e => `- ${e.content}`).join('\n')
        if (format === 'xml') {
          sections.push(`<episodic_memory>\n${epLines}\n</episodic_memory>`)
        } else {
          sections.push(`## Recent Episodes\n${epLines}`)
        }
      }
    }

    // Procedural memories
    if (opts?.includeProcedures) {
      const procedures = await this.recallProcedures(query, 3)
      if (procedures.length > 0) {
        const procLines = procedures.map(p =>
          `- When: ${p.trigger}\n  Steps: ${p.steps.join(' → ')}`
        ).join('\n')
        if (format === 'xml') {
          sections.push(`<procedural_memory>\n${procLines}\n</procedural_memory>`)
        } else {
          sections.push(`## Procedures\n${procLines}`)
        }
      }
    }

    if (sections.length === 0) return ''

    if (format === 'xml') {
      return `<memory>\n${sections.join('\n')}\n</memory>`
    }
    return sections.join('\n\n')
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
