import type { Embedder } from '../embedding/provider.js'
import type { typegraphIdentity } from '../types/identity.js'
import type { LLMProvider, LLMConfig } from '../types/llm-provider.js'
import type { typegraphEventSink } from '../types/events.js'
import type { ThreadTurnResult, MemoryHealthReport } from '../types/memory.js'
import type { MemoryRecord } from './types/memory.js'
import type { EmbeddingConfig } from '../types/bucket.js'
import type {
  MemoryBridge,
  RememberOpts,
  ForgetOpts,
  CorrectOpts,
  AddThreadTurnOpts,
  RecallOpts,
  HealthCheckOpts,
} from '../types/graph-bridge.js'
import { resolveEmbedder, resolveLLMProvider } from '../typegraph.js'
import type { MemoryStoreAdapter } from './types/adapter.js'
import type { ConversationMessage } from './extraction/extractor.js'
import { TypegraphMemory } from './typegraph-memory.js'
import { scopeKey } from './types/scope.js'
import { compactTypeGraphContext, contextAccess, contextTelemetry, contextToIdentity, optionalCompactObject } from '../utils/input.js'

function normalizeMemoryOpts<T extends { context?: any }>(
  opts: T | null | undefined,
  defaults: typegraphIdentity | undefined,
  method: string,
): T & { _identity: typegraphIdentity; _accessScope?: ReturnType<typeof contextAccess>; _traceId?: string; _spanId?: string } {
  const normalized = optionalCompactObject<T>(opts, method) as T
  const context = compactTypeGraphContext(normalized.context, method)
  const identity = contextToIdentity(context, defaults?.tenantId)
  const telemetry = contextTelemetry(context)
  const mergedIdentity = {
    ...defaults,
    ...identity,
  }
  const result = {
    ...normalized,
    _identity: mergedIdentity,
    _accessScope: contextAccess(context),
  }
  if (telemetry.traceId) Object.assign(result, { _traceId: telemetry.traceId })
  if (telemetry.spanId) Object.assign(result, { _spanId: telemetry.spanId })
  return result
}

// ── Config ──

export interface CreateMemoryBridgeConfig {
  memoryStore: MemoryStoreAdapter
  /** Embedder — pass a resolved Embedder or an AI SDK embedding input ({ model, dimensions }). */
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
  const embedding: Embedder = resolveEmbedder(config.embedding)
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
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'remember')
    const mem = getMemory(normalizedOpts._identity)
    return mem.remember(content, {
      category: (normalizedOpts.category as 'episodic' | 'semantic' | 'procedural' | undefined) ?? 'semantic',
      importance: normalizedOpts.importance,
      metadata: normalizedOpts.metadata,
      subject: normalizedOpts.subject,
      relatedEntities: normalizedOpts.relatedEntities,
      accessScope: normalizedOpts._accessScope,
      traceId: normalizedOpts._traceId,
      spanId: normalizedOpts._spanId,
    }) as unknown as Promise<MemoryRecord>
  }

  async function forget(id: string, opts?: ForgetOpts | null): Promise<void> {
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'forget')
    const mem = getMemory(normalizedOpts._identity)
    await mem.forget(id, { traceId: normalizedOpts._traceId, spanId: normalizedOpts._spanId })
  }

  async function correct(correction: string, opts?: CorrectOpts | null) {
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'correct')
    const mem = getMemory(normalizedOpts._identity)
    return mem.correct(correction, {
      subject: normalizedOpts.subject,
      relatedEntities: normalizedOpts.relatedEntities,
      traceId: normalizedOpts._traceId,
      spanId: normalizedOpts._spanId,
    })
  }

  async function addThreadTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    opts?: AddThreadTurnOpts | null,
  ): Promise<ThreadTurnResult> {
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'addThreadTurn')
    const mem = getMemory(normalizedOpts._identity)
    return mem.addThreadTurn(messages as ConversationMessage[], {
      threadId: normalizedOpts.threadId,
      subject: normalizedOpts.subject,
      relatedEntities: normalizedOpts.relatedEntities,
      accessScope: normalizedOpts._accessScope,
      traceId: normalizedOpts._traceId,
      spanId: normalizedOpts._spanId,
    }) as unknown as Promise<ThreadTurnResult>
  }

  function recall(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  function recall(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[] | string> {
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'recall')
    const mem = getMemory(normalizedOpts._identity)
    const internalOpts = {
      limit: normalizedOpts.limit,
      types: normalizedOpts.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: normalizedOpts.temporalAt,
      includeInvalidated: normalizedOpts.includeInvalidated,
      entityScope: normalizedOpts.entityScope,
      format: normalizedOpts.format,
      traceId: normalizedOpts._traceId,
      spanId: normalizedOpts._spanId,
    }
    return normalizedOpts.format
      ? mem.recall(query, internalOpts as typeof internalOpts & { format: 'xml' | 'markdown' | 'plain' })
      : mem.recall(query, internalOpts) as unknown as Promise<MemoryRecord[]>
  }

  function recallHybrid(query: string, opts: RecallOpts & { format: 'xml' | 'markdown' | 'plain' }): Promise<string>
  function recallHybrid(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[]>
  function recallHybrid(query: string, opts?: RecallOpts | null): Promise<MemoryRecord[] | string> {
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'recallHybrid')
    const mem = getMemory(normalizedOpts._identity)
    const internalOpts = {
      limit: normalizedOpts.limit,
      types: normalizedOpts.types as ('episodic' | 'semantic' | 'procedural')[] | undefined,
      asOf: normalizedOpts.temporalAt,
      includeInvalidated: normalizedOpts.includeInvalidated,
      entityScope: normalizedOpts.entityScope,
      format: normalizedOpts.format,
      traceId: normalizedOpts._traceId,
      spanId: normalizedOpts._spanId,
    }
    return normalizedOpts.format
      ? mem.recallHybrid(query, internalOpts as typeof internalOpts & { format: 'xml' | 'markdown' | 'plain' })
      : mem.recallHybrid(query, internalOpts) as unknown as Promise<MemoryRecord[]>
  }

  async function healthCheck(opts?: HealthCheckOpts | null): Promise<MemoryHealthReport> {
    const normalizedOpts = normalizeMemoryOpts(opts, config.scope, 'healthCheck')
    const mem = getMemory(normalizedOpts._identity)
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
    addThreadTurn,
    recall,
    recallHybrid,
    healthCheck,
    hasMemories,
  }
}
