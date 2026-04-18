import type { EmbeddingProvider } from '../embedding/provider.js'
import type { typegraphIdentity } from '../types/identity.js'
import type { LLMProvider, LLMConfig } from '../types/llm-provider.js'
import type { typegraphEventSink } from '../types/events.js'
import type { ConversationTurnResult, MemoryHealthReport } from '../types/memory.js'
import type { MemoryRecord } from './types/memory.js'
import type { EmbeddingConfig } from '../types/bucket.js'
import type {
  MemoryBridge,
  RememberOpts,
  ForgetOpts,
  CorrectOpts,
  AddConversationTurnOpts,
  RecallOpts,
  HealthCheckOpts,
} from '../types/graph-bridge.js'
import { resolveEmbeddingProvider, resolveLLMProvider } from '../typegraph.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { ConversationMessage } from './extraction/extractor.js'
import { TypegraphMemory } from './typegraph-memory.js'
import { scopeKey } from './types/scope.js'

/** Extract typegraphIdentity fields from an opts bag. */
function identityFrom(opts: typegraphIdentity): typegraphIdentity {
  return {
    tenantId: opts.tenantId,
    groupId: opts.groupId,
    userId: opts.userId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    agentName: opts.agentName,
    agentDescription: opts.agentDescription,
    agentVersion: opts.agentVersion,
  }
}

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

  async function remember(content: string, opts: RememberOpts): Promise<MemoryRecord> {
    const mem = getMemory(identityFrom(opts))
    return mem.remember(content, {
      category: (opts.category as 'episodic' | 'semantic' | 'procedural' | undefined) ?? 'semantic',
      importance: opts.importance,
      metadata: opts.metadata,
      traceId: opts.traceId,
      spanId: opts.spanId,
    }) as unknown as Promise<MemoryRecord>
  }

  async function forget(id: string, opts: ForgetOpts): Promise<void> {
    await memoryStore.invalidate(id)
    // Note: MemoryBridge.forget goes direct to store so no TypegraphMemory.emit fires here.
    // The telemetry arg is accepted for future symmetry / external event sinks.
    void opts
  }

  async function correct(correction: string, opts: CorrectOpts) {
    const mem = getMemory(identityFrom(opts))
    return mem.correct(correction, { traceId: opts.traceId, spanId: opts.spanId })
  }

  async function addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts: AddConversationTurnOpts,
  ): Promise<ConversationTurnResult> {
    const mem = getMemory(identityFrom(opts))
    return mem.addConversationTurn(messages as ConversationMessage[], opts.conversationId, {
      traceId: opts.traceId,
      spanId: opts.spanId,
    }) as unknown as Promise<ConversationTurnResult>
  }

  function recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recall(query: string, opts: RecallOpts): Promise<MemoryRecord[]>
  function recall(query: string, opts: RecallOpts): Promise<MemoryRecord[] | string> {
    const mem = getMemory(identityFrom(opts))
    const internalOpts = {
      limit: opts.limit,
      types: opts.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: opts.temporalAt,
      includeInvalidated: opts.includeInvalidated,
      format: opts.format,
      traceId: opts.traceId,
      spanId: opts.spanId,
    }
    return opts.format
      ? mem.recall(query, internalOpts as typeof internalOpts & { format: 'xml' | 'markdown' | 'plain' })
      : mem.recall(query, internalOpts) as unknown as Promise<MemoryRecord[]>
  }

  function recallHybrid(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recallHybrid(query: string, opts: RecallOpts): Promise<MemoryRecord[]>
  function recallHybrid(query: string, opts: RecallOpts): Promise<MemoryRecord[] | string> {
    const mem = getMemory(identityFrom(opts))
    const internalOpts = {
      limit: opts.limit,
      types: opts.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: opts.temporalAt,
      includeInvalidated: opts.includeInvalidated,
      format: opts.format,
      traceId: opts.traceId,
      spanId: opts.spanId,
    }
    return opts.format
      ? mem.recallHybrid(query, internalOpts as typeof internalOpts & { format: 'xml' | 'markdown' | 'plain' })
      : mem.recallHybrid(query, internalOpts) as unknown as Promise<MemoryRecord[]>
  }

  async function healthCheck(opts?: HealthCheckOpts): Promise<MemoryHealthReport> {
    const mem = getMemory(opts ? identityFrom(opts) : {})
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
    healthCheck,
    hasMemories,
  }
}
