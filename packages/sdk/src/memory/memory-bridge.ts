import type { EmbeddingProvider } from '../embedding/provider.js'
import type { typegraphIdentity } from '../types/identity.js'
import type { LLMProvider, LLMConfig } from '../types/llm-provider.js'
import type { typegraphEventSink } from '../types/events.js'
import type { ConversationTurnResult, MemoryHealthReport } from '../types/memory.js'
import type { MemoryRecord } from './types/memory.js'
import type { EmbeddingConfig } from '../types/bucket.js'
import type { MemoryBridge } from '../types/graph-bridge.js'
import { resolveEmbeddingProvider, resolveLLMProvider } from '../typegraph.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { ConversationMessage } from './extraction/extractor.js'
import { TypegraphMemory } from './typegraph-memory.js'
import { scopeKey } from './types/scope.js'

// ── Config ──

export interface CreateMemoryBridgeConfig {
  memoryStore: MemoryStoreAdapter
  /** Embedding provider — pass a resolved EmbeddingProvider or an AI SDK embedding input ({ model, dimensions }). */
  embedding: EmbeddingConfig
  /** LLM provider — pass a resolved LLMProvider, a bare AI SDK model, or { model } wrapper. */
  llm: LLMConfig
  /** Default scope for memory operations. */
  scope?: typegraphIdentity
  /** Optional event sink for observability. Passed through to TypegraphMemory instances. */
  eventSink?: typegraphEventSink
}

// ── Memory Bridge Factory ──

/**
 * Create a MemoryBridge for conversational memory operations.
 * Independent of the knowledge graph — does not create EmbeddedGraph, EntityResolver, or PredicateNormalizer.
 */
export function createMemoryBridge(config: CreateMemoryBridgeConfig): MemoryBridge {
  const { memoryStore } = config
  const embedding: EmbeddingProvider = resolveEmbeddingProvider(config.embedding)
  const llm: LLMProvider = resolveLLMProvider(config.llm)

  // Cache TypegraphMemory instances per identity scope
  const memoryCache = new Map<string, TypegraphMemory>()

  function getMemory(identity: typegraphIdentity): TypegraphMemory {
    const key = scopeKey(identity)
    let mem = memoryCache.get(key)
    if (!mem) {
      mem = new TypegraphMemory({ memoryStore, embedding, llm, scope: identity, eventSink: config.eventSink })
      memoryCache.set(key, mem)
    }
    return mem
  }

  async function remember(content: string, identity: typegraphIdentity, category?: string, opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
    const mem = getMemory(identity)
    return mem.remember(content, (category as 'episodic' | 'semantic' | 'procedural') ?? 'semantic', opts) as unknown as Promise<MemoryRecord>
  }

  async function forget(id: string, _identity: typegraphIdentity): Promise<void> {
    await memoryStore.invalidate(id)
  }

  async function correct(correction: string, identity: typegraphIdentity) {
    const mem = getMemory(identity)
    return mem.correct(correction)
  }

  async function addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: typegraphIdentity,
    conversationId?: string,
  ): Promise<ConversationTurnResult> {
    const mem = getMemory(identity)
    return mem.addConversationTurn(messages as ConversationMessage[], conversationId) as unknown as Promise<ConversationTurnResult>
  }

  async function recall(query: string, identity: typegraphIdentity, opts?: {
    limit?: number
    types?: string[]
    temporalAt?: Date
    includeInvalidated?: boolean
  }): Promise<MemoryRecord[]> {
    const mem = getMemory(identity)
    const results = await mem.recall(query, {
      limit: opts?.limit,
      types: opts?.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: opts?.temporalAt,
    })
    return results as unknown as MemoryRecord[]
  }

  async function recallHybrid(query: string, identity: typegraphIdentity, opts?: {
    limit?: number
    types?: string[]
    temporalAt?: Date
    includeInvalidated?: boolean
  }): Promise<MemoryRecord[]> {
    const mem = getMemory(identity)
    const results = await mem.recallHybrid(query, {
      limit: opts?.limit,
      types: opts?.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: opts?.temporalAt,
    })
    return results as unknown as MemoryRecord[]
  }

  async function buildMemoryContext(query: string, identity: typegraphIdentity, opts?: {
    includeWorking?: boolean
    includeFacts?: boolean
    includeEpisodes?: boolean
    includeProcedures?: boolean
    maxMemoryTokens?: number
    format?: 'xml' | 'markdown' | 'plain'
  }): Promise<string> {
    const mem = getMemory(identity)
    return mem.assembleContext(query, opts)
  }

  async function healthCheck(identity: typegraphIdentity): Promise<MemoryHealthReport> {
    const mem = getMemory(identity)
    return mem.healthCheck() as unknown as Promise<MemoryHealthReport>
  }

  let memoriesChecked = false
  let memoriesExist = false

  async function hasMemories(): Promise<boolean> {
    if (memoriesChecked) return memoriesExist
    try {
      const results = await memoryStore.list({ status: 'active' }, 1)
      memoriesExist = results.length > 0
    } catch (err) {
      console.error('[typegraph] Memory check failed:', err instanceof Error ? err.message : err)
      memoriesExist = false
    }
    memoriesChecked = true
    return memoriesExist
  }

  async function deploy(): Promise<void> {
    await memoryStore.initialize()
  }

  return {
    deploy,
    remember,
    forget,
    correct,
    addConversationTurn,
    recall,
    recallHybrid,
    buildMemoryContext,
    healthCheck,
    hasMemories,
  }
}
