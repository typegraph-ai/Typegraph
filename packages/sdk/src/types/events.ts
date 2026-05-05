import type { typegraphIdentity } from './identity.js'

// ── Event Types ──

export type typegraphEventType =
  // Memory lifecycle
  | 'memory.write'
  | 'memory.read'
  | 'memory.invalidate'
  | 'memory.correct'
  // Query pipeline
  | 'query.execute'
  | 'query.bucket_result'
  // Graph exploration
  | 'graph.explore'
  // Indexing
  | 'index.start'
  | 'index.complete'
  | 'index.source'
  // Extraction
  | 'extraction.facts'
  | 'extraction.contradiction'
  // Tool calls (MCP)
  | 'tool.call'
  | 'tool.result'
  // Bucket lifecycle
  | 'bucket.create'
  | 'bucket.update'
  | 'bucket.delete'
  // Source lifecycle
  | 'source.update'
  | 'source.delete'
  // Governance
  | 'policy.create'
  | 'policy.update'
  | 'policy.delete'
  | 'policy.violation'

export interface typegraphEvent {
  /** Unique event ID (UUID or ULID). */
  id: string
  /** Event type from the typegraphEventType union. */
  eventType: typegraphEventType
  /** Identity context for who/what triggered the event. */
  identity: typegraphIdentity
  /** ID of the target object (memory, entity, edge, source, bucket). */
  targetId?: string | undefined
  /** Type of the target object. */
  targetType?: 'memory' | 'entity' | 'edge' | 'source' | 'bucket' | undefined
  /** Arbitrary event payload (scores, counts, error messages, etc.). */
  payload: Record<string, unknown>
  /** Duration of the operation in milliseconds. */
  durationMs?: number | undefined
  /** OpenTelemetry trace ID for distributed tracing correlation. */
  traceId?: string | undefined
  /** OpenTelemetry span ID for distributed tracing correlation. */
  spanId?: string | undefined
  /** Event timestamp. */
  timestamp: Date
}

/**
 * Token usage metadata for LLM-calling operations.
 * Attached to event payloads for extraction, answer generation, etc.
 */
export interface TokenUsage {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  model?: string | undefined
  estimatedCost?: number | undefined
}

/**
 * Optional OpenTelemetry correlation fields that SDK methods accept so callers
 * can link emitted `typegraph_events` rows to their parent trace/span. Spread
 * into any per-call options interface to keep the API consistent.
 */
export interface TelemetryOpts {
  traceId?: string | undefined
  spanId?: string | undefined
}

/**
 * Sink for typegraph events. Implementations can write to Postgres, OTel, console, etc.
 * All methods are fire-and-forget — errors should be logged, not thrown.
 */
export interface typegraphEventSink {
  /** Emit a single event. */
  emit(event: typegraphEvent): void | Promise<void>
  /** Emit a batch of events (optional optimization). */
  emitBatch?(events: typegraphEvent[]): void | Promise<void>
  /** Flush any buffered events. */
  flush?(): Promise<void>
}
