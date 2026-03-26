import type { EmbeddingProvider } from '@d8um/core'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { MemoryScope } from './types/scope.js'
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
import { randomUUID } from 'crypto'

// ── D8umMemory Config ──

export interface D8umMemoryConfig {
  memoryStore: MemoryStoreAdapter
  embedding: EmbeddingProvider
  llm: LLMProvider
  scope: MemoryScope
  workingMemory?: WorkingMemoryConfig | undefined
}

// ── D8umMemory ──
// Unified developer-facing API for cognitive memory.
// Imperative mode — direct calls, instant results.
// Same engines used by job system for automation.

export class D8umMemory {
  readonly working: WorkingMemory

  private readonly store: MemoryStoreAdapter
  private readonly embedding: EmbeddingProvider
  private readonly llm: LLMProvider
  private readonly scope: MemoryScope
  private readonly extractor: MemoryExtractor
  private readonly invalidation: InvalidationEngine

  constructor(config: D8umMemoryConfig) {
    this.store = config.memoryStore
    this.embedding = config.embedding
    this.llm = config.llm
    this.scope = config.scope
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

  // ── Store ──

  /**
   * Store a memory. If content is a plain string, creates a semantic fact
   * with LLM extraction. For full control, use addConversationTurn().
   */
  async remember(content: string, category: MemoryCategory = 'semantic'): Promise<MemoryRecord> {
    const embedding = await this.embedding.embed(content)
    const temporal = createTemporal()

    const record: MemoryRecord = {
      id: randomUUID(),
      category,
      status: 'active',
      content,
      embedding,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: {},
      scope: this.scope,
      ...temporal,
    }

    return this.store.upsert(record)
  }

  /**
   * Forget (invalidate) a memory by ID. Preserves the record with invalidAt set.
   */
  async forget(id: string): Promise<void> {
    await this.store.invalidate(id)
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
Respond with JSON: {"targetContent": "...", "newContent": "...", "subject": "...", "predicate": "...", "object": "..."}`
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
      id: randomUUID(),
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

    return {
      invalidated,
      created: 1,
      summary: `Invalidated ${invalidated} fact(s), created 1 corrected fact`,
    }
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

    return results
  }

  /**
   * Recall only semantic facts.
   */
  async recallFacts(query: string, limit: number = 10): Promise<SemanticFact[]> {
    const results = await this.recall(query, { types: ['semantic'], limit })
    return results.filter((r): r is SemanticFact => r.category === 'semantic')
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
    sessionId?: string,
  ): Promise<ExtractionResult> {
    // Get existing facts for conflict resolution
    const existingFacts = await this.recallFacts(
      messages.map(m => m.content).join(' '),
      20,
    )

    const result = await this.extractor.processConversation(
      messages,
      existingFacts,
      sessionId,
    )

    // Store episodic memories
    for (const episode of result.episodic) {
      episode.embedding = await this.embedding.embed(episode.content)
      await this.store.upsert(episode)
    }

    // Store new facts and check for contradictions
    for (const fact of result.facts) {
      fact.embedding = await this.embedding.embed(fact.content)

      // Check contradictions before storing
      const contradictions = await this.invalidation.checkContradictions(fact, this.scope)
      if (contradictions.length > 0) {
        await this.invalidation.resolveContradictions(contradictions)
      }

      await this.store.upsert(fact)
    }

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
}
