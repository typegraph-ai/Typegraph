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
import { optionalCompactObject, withDefaultTenant } from '../utils/input.js'

/** Extract typegraphIdentity fields from an opts bag. */
function identityFrom(opts: typegraphIdentity | null | undefined, defaults?: typegraphIdentity): typegraphIdentity {
  const merged = { ...(defaults ?? {}), ...optionalCompactObject<typegraphIdentity>(opts, 'memory.identity', 'opts') }
  return {
    tenantId: merged.tenantId,
    groupId: merged.groupId,
    userId: merged.userId,
    agentId: merged.agentId,
    conversationId: merged.conversationId,
    agentName: merged.agentName,
    agentDescription: merged.agentDescription,
    agentVersion: merged.agentVersion,
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

  async function remember(content: string, opts?: RememberOpts | null): Promise<MemoryRecord> {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'remember') as RememberOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
    return mem.remember(content, {
      category: (normalizedOpts.category as 'episodic' | 'semantic' | 'procedural' | undefined) ?? 'semantic',
      importance: normalizedOpts.importance,
      metadata: normalizedOpts.metadata,
      subject: normalizedOpts.subject,
      relatedEntities: normalizedOpts.relatedEntities,
      visibility: normalizedOpts.visibility,
      traceId: normalizedOpts.traceId,
      spanId: normalizedOpts.spanId,
    }) as unknown as Promise<MemoryRecord>
  }

  async function forget(id: string, opts?: ForgetOpts | null): Promise<void> {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'forget') as ForgetOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
    await mem.forget(id, { traceId: normalizedOpts.traceId, spanId: normalizedOpts.spanId })
  }

  async function correct(correction: string, opts?: CorrectOpts | null) {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'correct') as CorrectOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
    return mem.correct(correction, {
      subject: normalizedOpts.subject,
      relatedEntities: normalizedOpts.relatedEntities,
      traceId: normalizedOpts.traceId,
      spanId: normalizedOpts.spanId,
    })
  }

  async function addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts?: AddConversationTurnOpts | null,
  ): Promise<ConversationTurnResult> {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'addConversationTurn') as AddConversationTurnOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
    return mem.addConversationTurn(messages as ConversationMessage[], {
      conversationId: normalizedOpts.conversationId,
      subject: normalizedOpts.subject,
      relatedEntities: normalizedOpts.relatedEntities,
      visibility: normalizedOpts.visibility,
      traceId: normalizedOpts.traceId,
      spanId: normalizedOpts.spanId,
    }) as unknown as Promise<ConversationTurnResult>
  }

  function recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  function recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[] | string> {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'recall') as RecallOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
    const internalOpts = {
      limit: normalizedOpts.limit,
      types: normalizedOpts.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: normalizedOpts.temporalAt,
      includeInvalidated: normalizedOpts.includeInvalidated,
      entityScope: normalizedOpts.entityScope,
      format: normalizedOpts.format,
      traceId: normalizedOpts.traceId,
      spanId: normalizedOpts.spanId,
    }
    return normalizedOpts.format
      ? mem.recall(query, internalOpts as typeof internalOpts & { format: 'xml' | 'markdown' | 'plain' })
      : mem.recall(query, internalOpts) as unknown as Promise<MemoryRecord[]>
  }

  function recallHybrid(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recallHybrid(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  function recallHybrid(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[] | string> {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'recallHybrid') as RecallOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
    const internalOpts = {
      limit: normalizedOpts.limit,
      types: normalizedOpts.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: normalizedOpts.temporalAt,
      includeInvalidated: normalizedOpts.includeInvalidated,
      entityScope: normalizedOpts.entityScope,
      format: normalizedOpts.format,
      traceId: normalizedOpts.traceId,
      spanId: normalizedOpts.spanId,
    }
    return normalizedOpts.format
      ? mem.recallHybrid(query, internalOpts as typeof internalOpts & { format: 'xml' | 'markdown' | 'plain' })
      : mem.recallHybrid(query, internalOpts) as unknown as Promise<MemoryRecord[]>
  }

  async function healthCheck(opts?: HealthCheckOpts | null): Promise<MemoryHealthReport> {
    const normalizedOpts = withDefaultTenant(opts, config.scope?.tenantId, 'healthCheck') as HealthCheckOpts
    const mem = getMemory(identityFrom(normalizedOpts, config.scope))
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
