import type { d8umIdentity } from '@d8um-ai/core'
import type { SemanticFact } from '../types/memory.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import type { LLMProvider } from './llm-provider.js'
import { contradictionCheckPrompt } from './prompts.js'
import { invalidateRecord } from '../temporal.js'

// ── Contradiction ──

export interface Contradiction {
  existingFact: SemanticFact
  newFact: SemanticFact
  conflictType: 'direct' | 'temporal' | 'superseded'
  confidence: number
  reasoning: string
}

// ── Invalidation Engine ──
// Detects contradictions between new and existing facts.
// Inspired by Graphiti's edge invalidation - old facts are preserved
// with invalidAt set, never deleted.

export interface InvalidationConfig {
  llm: LLMProvider
  store: MemoryStoreAdapter
}

export class InvalidationEngine {
  private readonly llm: LLMProvider
  private readonly store: MemoryStoreAdapter

  constructor(config: InvalidationConfig) {
    this.llm = config.llm
    this.store = config.store
  }

  /**
   * Check if a new fact contradicts any existing facts in the given scope.
   * Returns an array of detected contradictions.
   */
  async checkContradictions(
    newFact: SemanticFact,
    scope: d8umIdentity,
  ): Promise<Contradiction[]> {
    // Search for semantically similar existing facts
    const existingFacts = await this.findRelatedFacts(newFact, scope)
    if (existingFacts.length === 0) return []

    const contradictions: Contradiction[] = []

    for (const existing of existingFacts) {
      // Skip if same fact
      if (existing.id === newFact.id) continue

      const prompt = contradictionCheckPrompt(existing.content, newFact.content)

      try {
        const result = await this.llm.generateJSON<{
          contradicts: boolean
          type: 'direct' | 'temporal' | 'superseded' | 'compatible'
          reasoning: string
        }>(prompt)

        if (result.contradicts && result.type !== 'compatible') {
          contradictions.push({
            existingFact: existing,
            newFact,
            conflictType: result.type as 'direct' | 'temporal' | 'superseded',
            confidence: newFact.confidence,
            reasoning: result.reasoning,
          })
        }
      } catch {
        // On LLM failure, skip this comparison
        continue
      }
    }

    return contradictions
  }

  /**
   * Resolve detected contradictions by invalidating old facts.
   * Old facts are preserved with invalidAt set - never deleted.
   */
  async resolveContradictions(contradictions: Contradiction[]): Promise<void> {
    for (const contradiction of contradictions) {
      const invalidated = invalidateRecord(
        contradiction.existingFact,
        contradiction.newFact.validAt,
      )

      // Update the existing fact in the store with invalidAt/expiredAt set
      await this.store.invalidate(
        invalidated.id,
        invalidated.invalidAt,
      )
    }
  }

  /**
   * Find existing facts that are semantically related to a new fact.
   * Uses the same subject or has high content similarity.
   */
  private async findRelatedFacts(
    newFact: SemanticFact,
    scope: d8umIdentity,
  ): Promise<SemanticFact[]> {
    // Search by embedding similarity if available
    if (newFact.embedding) {
      const results = await this.store.search(newFact.embedding, {
        count: 10,
        filter: {
          scope,
          category: 'semantic',
        },
      })
      return results.filter(
        (r): r is SemanticFact => r.category === 'semantic'
      )
    }

    // Fall back to listing facts in scope
    const results = await this.store.list(
      { scope, category: 'semantic' },
      20,
    )
    return results.filter(
      (r): r is SemanticFact => r.category === 'semantic'
    )
  }
}
