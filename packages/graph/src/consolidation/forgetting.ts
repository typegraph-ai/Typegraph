import type { LLMProvider } from '@d8um-ai/core'
import type { d8umIdentity } from '@d8um-ai/core'
import type { MemoryRecord } from '../types/index.js'
import type { MemoryStoreAdapter } from '../types/adapter.js'
import { findDecayedMemories, type DecayConfig, DEFAULT_DECAY_CONFIG } from './decay.js'

// ── Forgetting Policies ──

export type ForgettingPolicy = 'archive' | 'summarize' | 'delete'

export interface ForgettingResult {
  archived: number
  summarized: number
  deleted: number
  totalProcessed: number
}

// ── Forgetting Engine ──

export class ForgettingEngine {
  private readonly store: MemoryStoreAdapter
  private readonly llm?: LLMProvider | undefined

  constructor(store: MemoryStoreAdapter, llm?: LLMProvider) {
    this.store = store
    this.llm = llm
  }

  /**
   * Apply a forgetting policy to decayed memories in the given scope.
   *
   * Policies:
   * - 'archive': Set expiredAt on the record (still queryable with includeExpired flag)
   * - 'summarize': Use LLM to condense low-scoring memories into a summary, archive originals
   * - 'delete': Permanently remove from the store
   */
  async forget(
    scope: d8umIdentity,
    policy: ForgettingPolicy,
    decayConfig: DecayConfig = DEFAULT_DECAY_CONFIG,
  ): Promise<ForgettingResult> {
    // Find all memories in scope
    const allMemories = await this.store.list({ scope }, 1000)

    // Identify decayed memories
    const decayed = findDecayedMemories(allMemories, decayConfig)

    if (decayed.length === 0) {
      return { archived: 0, summarized: 0, deleted: 0, totalProcessed: 0 }
    }

    switch (policy) {
      case 'archive':
        return this.archiveMemories(decayed)
      case 'summarize':
        return this.summarizeMemories(decayed, scope)
      case 'delete':
        return this.deleteMemories(decayed)
    }
  }

  private async archiveMemories(memories: MemoryRecord[]): Promise<ForgettingResult> {
    for (const memory of memories) {
      await this.store.expire(memory.id)
    }
    return { archived: memories.length, summarized: 0, deleted: 0, totalProcessed: memories.length }
  }

  private async summarizeMemories(
    memories: MemoryRecord[],
    _scope: d8umIdentity,
  ): Promise<ForgettingResult> {
    if (!this.llm || memories.length === 0) {
      // Fall back to archive if no LLM available
      return this.archiveMemories(memories)
    }

    // Group memories by category for more coherent summaries
    const byCategory = new Map<string, MemoryRecord[]>()
    for (const m of memories) {
      const group = byCategory.get(m.category) ?? []
      group.push(m)
      byCategory.set(m.category, group)
    }

    let summarized = 0
    for (const [_category, group] of byCategory) {
      if (group.length < 2) {
        // Not enough to summarize - just archive
        for (const m of group) {
          await this.store.expire(m.id)
        }
        continue
      }

      // Create summary via LLM
      const contents = group.map(m => `- ${m.content}`).join('\n')
      const summaryContent = await this.llm.generateText(
        `Summarize the following memories into a single concise statement:\n\n${contents}\n\nSummary:`
      )

      // Create a summary record with the highest importance from the group
      const maxImportance = Math.max(...group.map(m => m.importance))
      const summaryRecord: MemoryRecord = {
        ...group[0]!,
        id: crypto.randomUUID(),
        status: 'active',
        content: summaryContent.trim(),
        importance: maxImportance,
        accessCount: 0,
        lastAccessedAt: new Date(),
        metadata: { summarizedFrom: group.map(m => m.id), summarizedCount: group.length },
        createdAt: new Date(),
        validAt: new Date(),
      }

      await this.store.upsert(summaryRecord)
      summarized++

      // Archive the originals
      for (const m of group) {
        await this.store.expire(m.id)
      }
    }

    return { archived: memories.length, summarized, deleted: 0, totalProcessed: memories.length }
  }

  private async deleteMemories(memories: MemoryRecord[]): Promise<ForgettingResult> {
    for (const memory of memories) {
      await this.store.delete(memory.id)
    }
    return { archived: 0, summarized: 0, deleted: memories.length, totalProcessed: memories.length }
  }
}
