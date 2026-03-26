import type { EmbeddingProvider } from '@d8um/core'
import type { MemoryScope } from '../types/scope.js'
import type { EpisodicMemory, SemanticFact } from '../types/memory.js'
import type { LLMProvider } from './llm-provider.js'
import { factExtractionPrompt, conflictResolutionPrompt } from './prompts.js'
import { createTemporal } from '../temporal.js'
import { randomUUID } from 'crypto'

// ── Extraction Types ──

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp?: Date | undefined
}

export type MemoryOperationType = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'

export interface MemoryOperation {
  type: MemoryOperationType
  fact: CandidateFact
  /** Existing memory ID for UPDATE/DELETE operations */
  targetId?: string | undefined
  confidence: number
  reasoning?: string | undefined
}

export interface CandidateFact {
  content: string
  subject: string
  predicate: string
  object: string
  importance: number
  confidence: number
}

export interface ExtractionResult {
  /** Raw episodic memories created from the conversation */
  episodic: EpisodicMemory[]
  /** Semantic facts extracted */
  facts: SemanticFact[]
  /** Operations decided against existing memories */
  operations: MemoryOperation[]
}

// ── Extraction Config ──

export interface ExtractionConfig {
  llm: LLMProvider
  embedding: EmbeddingProvider
  scope: MemoryScope
}

// ── Memory Extractor ──
// Two-phase extraction pipeline inspired by Mem0:
// Phase 1: Extract candidate facts from conversation
// Phase 2: Compare against existing memories, decide ADD/UPDATE/DELETE/NOOP

export class MemoryExtractor {
  private readonly llm: LLMProvider
  private readonly embedding: EmbeddingProvider
  private readonly scope: MemoryScope

  constructor(config: ExtractionConfig) {
    this.llm = config.llm
    this.embedding = config.embedding
    this.scope = config.scope
  }

  /**
   * Phase 1: Extract candidate facts from a conversation.
   */
  async extractFacts(messages: ConversationMessage[]): Promise<CandidateFact[]> {
    const conversation = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n')

    const prompt = factExtractionPrompt(conversation)
    const result = await this.llm.generateJSON<CandidateFact[]>(prompt)

    if (!Array.isArray(result)) return []
    return result.filter(f =>
      typeof f.content === 'string' &&
      typeof f.subject === 'string' &&
      typeof f.predicate === 'string' &&
      typeof f.object === 'string'
    )
  }

  /**
   * Phase 2: Compare candidate facts against existing memories,
   * decide ADD/UPDATE/DELETE/NOOP for each.
   */
  async resolveConflicts(
    candidates: CandidateFact[],
    existingFacts: SemanticFact[],
  ): Promise<MemoryOperation[]> {
    if (candidates.length === 0) return []

    const operations: MemoryOperation[] = []

    for (const candidate of candidates) {
      if (existingFacts.length === 0) {
        operations.push({
          type: 'ADD',
          fact: candidate,
          confidence: candidate.confidence,
          reasoning: 'No existing facts to compare against',
        })
        continue
      }

      const existingDescriptions = existingFacts
        .map((f, i) => `[${i}] ${f.content}`)
        .join('\n')

      const prompt = conflictResolutionPrompt(candidate.content, existingDescriptions)

      try {
        const result = await this.llm.generateJSON<{
          operation: MemoryOperationType
          targetIndex: number | null
          reasoning: string
        }>(prompt)

        const targetIndex = result.targetIndex
        const targetFact = targetIndex !== null ? existingFacts[targetIndex] : undefined

        operations.push({
          type: result.operation,
          fact: candidate,
          targetId: targetFact?.id,
          confidence: candidate.confidence,
          reasoning: result.reasoning,
        })
      } catch {
        // On LLM failure, default to ADD
        operations.push({
          type: 'ADD',
          fact: candidate,
          confidence: candidate.confidence * 0.5, // lower confidence due to failed resolution
          reasoning: 'LLM conflict resolution failed, defaulting to ADD',
        })
      }
    }

    return operations
  }

  /**
   * Create an episodic memory from a conversation turn.
   */
  createEpisodicMemory(
    messages: ConversationMessage[],
    sessionId?: string,
    sequence?: number,
  ): EpisodicMemory {
    const content = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n')

    const timestamp = messages.find(m => m.timestamp)?.timestamp ?? new Date()
    const temporal = createTemporal(timestamp)

    return {
      id: randomUUID(),
      category: 'episodic',
      status: 'active',
      content,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: {},
      scope: this.scope,
      eventType: 'conversation',
      participants: [...new Set(messages.filter(m => m.role === 'user').map(() => this.scope.userId).filter(Boolean) as string[])],
      sessionId,
      sequence,
      ...temporal,
    }
  }

  /**
   * Convert a candidate fact + operation into a SemanticFact record.
   */
  candidateToFact(candidate: CandidateFact, episodeId: string): SemanticFact {
    const temporal = createTemporal()
    return {
      id: randomUUID(),
      category: 'semantic',
      status: 'active',
      content: candidate.content,
      importance: candidate.importance,
      accessCount: 0,
      lastAccessedAt: new Date(),
      metadata: {},
      scope: this.scope,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      confidence: candidate.confidence,
      sourceMemoryIds: [episodeId],
      ...temporal,
    }
  }

  /**
   * Full pipeline: extract + resolve in one call.
   * Creates episodic memory, extracts facts, resolves conflicts.
   */
  async processConversation(
    messages: ConversationMessage[],
    existingFacts: SemanticFact[] = [],
    sessionId?: string,
    sequence?: number,
  ): Promise<ExtractionResult> {
    // Create episodic memory
    const episode = this.createEpisodicMemory(messages, sessionId, sequence)

    // Phase 1: Extract candidate facts
    const candidates = await this.extractFacts(messages)

    // Phase 2: Resolve conflicts
    const operations = await this.resolveConflicts(candidates, existingFacts)

    // Convert ADD operations into SemanticFact records
    const facts = operations
      .filter(op => op.type === 'ADD')
      .map(op => this.candidateToFact(op.fact, episode.id))

    return {
      episodic: [episode],
      facts,
      operations,
    }
  }
}
