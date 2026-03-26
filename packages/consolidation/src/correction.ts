import type { MemoryStoreAdapter, MemoryScope, SemanticFact, LLMProvider } from '@d8um/memory'
import { invalidateRecord, createTemporal } from '@d8um/memory'
import { randomUUID } from 'crypto'

// ── Correction Types ──

export interface CorrectionResult {
  /** Number of existing facts that were invalidated */
  invalidated: number
  /** Number of new facts created from the correction */
  created: number
  /** Human-readable summary of what changed */
  summary: string
}

// ── Memory Corrector ──
// Parses natural language corrections and applies versioned updates.
// Old facts are invalidated, new facts are created — preserving full history.

export class MemoryCorrector {
  private readonly store: MemoryStoreAdapter
  private readonly llm: LLMProvider

  constructor(store: MemoryStoreAdapter, llm: LLMProvider) {
    this.store = store
    this.llm = llm
  }

  /**
   * Apply a natural language correction to memories in the given scope.
   *
   * Example: "Actually, John works at Acme Corp, not Beta Inc"
   * - Finds the fact "John works at Beta Inc"
   * - Invalidates it (preserves with invalidAt set)
   * - Creates new fact "John works at Acme Corp"
   */
  async correct(
    correction: string,
    scope: MemoryScope,
  ): Promise<CorrectionResult> {
    // Parse the correction to identify what to change
    const parsed = await this.parseCorrection(correction)

    if (!parsed.targetContent && !parsed.newContent) {
      return { invalidated: 0, created: 0, summary: 'Could not parse correction' }
    }

    // Find matching existing facts
    const existing = await this.store.list(
      { scope, category: 'semantic' },
      50,
    )

    const semanticFacts = existing.filter(
      (r): r is SemanticFact => r.category === 'semantic'
    )

    // Find facts that match the correction target
    let invalidated = 0
    const matchingFacts = parsed.targetContent
      ? await this.findMatchingFacts(parsed.targetContent, semanticFacts)
      : []

    // Invalidate matching facts
    for (const fact of matchingFacts) {
      const updated = invalidateRecord(fact)
      await this.store.invalidate(updated.id, updated.invalidAt)
      invalidated++
    }

    // Create new fact if correction provides replacement
    let created = 0
    if (parsed.newContent) {
      const temporal = createTemporal()
      const newFact: SemanticFact = {
        id: randomUUID(),
        category: 'semantic',
        content: parsed.newContent,
        subject: parsed.subject ?? '',
        predicate: parsed.predicate ?? '',
        object: parsed.object ?? '',
        confidence: 0.95, // corrections are high confidence
        sourceMemoryIds: matchingFacts.map(f => f.id),
        importance: matchingFacts.length > 0 ? Math.max(...matchingFacts.map(f => f.importance)) : 0.7,
        accessCount: 0,
        lastAccessedAt: new Date(),
        metadata: { correctedFrom: matchingFacts.map(f => f.id), correctionText: correction },
        scope,
        ...temporal,
      }

      await this.store.upsert(newFact)
      created++
    }

    return {
      invalidated,
      created,
      summary: `Invalidated ${invalidated} fact(s), created ${created} new fact(s) from correction`,
    }
  }

  private async parseCorrection(correction: string): Promise<{
    targetContent?: string | undefined
    newContent?: string | undefined
    subject?: string | undefined
    predicate?: string | undefined
    object?: string | undefined
  }> {
    try {
      return await this.llm.generateJSON(
        `Parse this memory correction into structured fields.

Correction: "${correction}"

Identify:
- "targetContent": The incorrect fact being corrected (what was wrong)
- "newContent": The correct fact (what it should be)
- "subject": The entity the correction is about
- "predicate": The relationship type
- "object": The corrected value

Respond with only valid JSON:
{"targetContent": "...", "newContent": "...", "subject": "...", "predicate": "...", "object": "..."}`
      )
    } catch {
      return {}
    }
  }

  private async findMatchingFacts(
    targetContent: string,
    facts: SemanticFact[],
  ): Promise<SemanticFact[]> {
    const targetLower = targetContent.toLowerCase()
    // Simple content matching — in production, this would use embedding similarity
    return facts.filter(f =>
      f.content.toLowerCase().includes(targetLower) ||
      targetLower.includes(f.content.toLowerCase())
    )
  }
}
