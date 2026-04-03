import type { EmbeddingProvider, LLMProvider } from '@d8um-ai/core'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { d8umIdentity } from '@d8um-ai/core'
import type { EpisodicMemory, SemanticFact, ProceduralMemory } from '../types/index.js'
import type { EmbeddedGraph } from '../graph/embedded-graph.js'

// ── Consolidation Types ──

export interface ConsolidationConfig {
  memoryStore: MemoryStoreAdapter
  graph?: EmbeddedGraph | undefined
  llm: LLMProvider
  embedding: EmbeddingProvider
}

export type ConsolidationStrategy =
  | 'episodic_to_semantic'
  | 'community_detection'
  | 'procedural_promotion'

export interface ConsolidationOpts {
  strategies?: ConsolidationStrategy[] | undefined
  /** Only consolidate episodes older than this (ms). Default: 1 hour */
  minEpisodicAgeMs?: number | undefined
  /** Dry run - report what would change without modifying the store */
  dryRun?: boolean | undefined
}

export interface ConsolidationResult {
  factsExtracted: number
  factsUpdated: number
  proceduresCreated: number
  communitiesDetected: number
  episodesConsolidated: number
}

// ── Consolidation Engine ──
// Orchestrates memory promotion strategies.
// Each strategy is independently composable.

export class ConsolidationEngine {
  private readonly store: MemoryStoreAdapter
  private readonly graph?: EmbeddedGraph | undefined
  private readonly llm: LLMProvider
  private readonly embedding: EmbeddingProvider

  constructor(config: ConsolidationConfig) {
    this.store = config.memoryStore
    this.graph = config.graph
    this.llm = config.llm
    this.embedding = config.embedding
  }

  /**
   * Run consolidation strategies for a scope.
   */
  async consolidate(
    scope: d8umIdentity,
    opts: ConsolidationOpts = {},
  ): Promise<ConsolidationResult> {
    const strategies = opts.strategies ?? ['episodic_to_semantic']
    const result: ConsolidationResult = {
      factsExtracted: 0,
      factsUpdated: 0,
      proceduresCreated: 0,
      communitiesDetected: 0,
      episodesConsolidated: 0,
    }

    for (const strategy of strategies) {
      switch (strategy) {
        case 'episodic_to_semantic': {
          const r = await this.promoteEpisodicToSemantic(scope, opts)
          result.factsExtracted += r.factsExtracted
          result.episodesConsolidated += r.episodesConsolidated
          break
        }
        case 'procedural_promotion': {
          const r = await this.promoteToProcedural(scope, opts)
          result.proceduresCreated += r.proceduresCreated
          break
        }
        case 'community_detection': {
          // Community detection requires the graph layer
          if (this.graph) {
            result.communitiesDetected += 0 // placeholder
          }
          break
        }
      }
    }

    return result
  }

  /**
   * Promote unconsolidated episodic memories into semantic facts.
   */
  async promoteEpisodicToSemantic(
    scope: d8umIdentity,
    opts: ConsolidationOpts = {},
  ): Promise<{ factsExtracted: number; episodesConsolidated: number }> {
    const minAge = opts.minEpisodicAgeMs ?? 60 * 60 * 1000 // 1 hour
    const now = new Date()
    const cutoff = new Date(now.getTime() - minAge)

    // Find unconsolidated episodes
    const allEpisodes = await this.store.list({ scope, category: 'episodic' }, 100)
    const episodes = allEpisodes.filter((m): m is EpisodicMemory => {
      if (m.category !== 'episodic') return false
      const ep = m as EpisodicMemory
      if (ep.consolidatedAt) return false
      return ep.createdAt <= cutoff
    })

    if (episodes.length === 0 || opts.dryRun) {
      return { factsExtracted: 0, episodesConsolidated: episodes.length }
    }

    // Batch episodes into groups and extract facts
    let factsExtracted = 0
    const batchSize = 10
    for (let i = 0; i < episodes.length; i += batchSize) {
      const batch = episodes.slice(i, i + batchSize)
      const contents = batch.map(ep => ep.content).join('\n\n---\n\n')

      try {
        const facts = await this.llm.generateJSON<Array<{
          content: string
          subject: string
          predicate: string
          object: string
          importance: number
        }>>(
          `Extract generalizable facts from these episodic memories. Only extract facts that appear consistently or are clearly stated. Return a JSON array.

Episodes:
${contents}

Respond with only valid JSON: [{"content": "...", "subject": "...", "predicate": "...", "object": "...", "importance": 0.0}, ...]`
        )

        if (Array.isArray(facts)) {
          for (const fact of facts) {
            const embedding = await this.embedding.embed(fact.content)
            const semanticFact: SemanticFact = {
              id: crypto.randomUUID(),
              category: 'semantic',
              status: 'active',
              content: fact.content,
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              confidence: 0.7,
              sourceMemoryIds: batch.map(ep => ep.id),
              importance: fact.importance ?? 0.5,
              accessCount: 0,
              lastAccessedAt: new Date(),
              metadata: { consolidatedFrom: 'episodic_to_semantic' },
              scope,
              embedding,
              validAt: new Date(),
              createdAt: new Date(),
            }

            await this.store.upsert(semanticFact)
            factsExtracted++
          }
        }

        // Mark episodes as consolidated
        for (const ep of batch) {
          const updated: EpisodicMemory = { ...ep, status: 'consolidated', consolidatedAt: new Date() }
          await this.store.upsert(updated)
        }
      } catch {
        // Skip batch on LLM failure
        continue
      }
    }

    return { factsExtracted, episodesConsolidated: episodes.length }
  }

  /**
   * Detect repeated patterns in episodic memories and create procedural memories.
   */
  async promoteToProcedural(
    scope: d8umIdentity,
    opts: ConsolidationOpts = {},
  ): Promise<{ proceduresCreated: number }> {
    // Find tool-trace or action episodes
    const allEpisodes = await this.store.list({ scope, category: 'episodic' }, 200)
    const actionEpisodes = allEpisodes.filter((m): m is EpisodicMemory => {
      if (m.category !== 'episodic') return false
      const ep = m as EpisodicMemory
      return ep.eventType === 'action' || ep.eventType === 'tool_trace'
    })

    if (actionEpisodes.length < 3 || opts.dryRun) {
      return { proceduresCreated: 0 }
    }

    const contents = actionEpisodes
      .slice(0, 50) // limit context size
      .map(ep => ep.content)
      .join('\n\n---\n\n')

    try {
      const procedures = await this.llm.generateJSON<Array<{
        trigger: string
        steps: string[]
        confidence: number
      }>>(
        `Analyze these action/tool traces and identify repeating procedural patterns.

Actions:
${contents}

Respond with only valid JSON: [{"trigger": "...", "steps": ["..."], "confidence": 0.0}, ...]`
      )

      let created = 0
      if (Array.isArray(procedures)) {
        for (const proc of procedures) {
          if (proc.confidence < 0.5) continue

          const proceduralMemory: ProceduralMemory = {
            id: crypto.randomUUID(),
            category: 'procedural',
            status: 'active',
            content: `When: ${proc.trigger}\nSteps: ${proc.steps.join(' → ')}`,
            trigger: proc.trigger,
            steps: proc.steps,
            successCount: 0,
            failureCount: 0,
            importance: proc.confidence,
            accessCount: 0,
            lastAccessedAt: new Date(),
            metadata: { promotedFrom: 'episodic_to_procedural' },
            scope,
            validAt: new Date(),
            createdAt: new Date(),
          }

          await this.store.upsert(proceduralMemory)
          created++
        }
      }

      return { proceduresCreated: created }
    } catch {
      return { proceduresCreated: 0 }
    }
  }
}
