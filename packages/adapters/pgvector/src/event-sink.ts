import type { typegraphEvent, typegraphEventSink } from '@typegraph-ai/sdk'

export interface PgEventSinkConfig {
  /** Postgres query function (same pool as the adapter). */
  sql: (query: string, params?: unknown[]) => Promise<unknown[]>
  /** Table name for events. Defaults to 'typegraph_events'. */
  eventsTable?: string | undefined
  /** Max events to buffer before flushing. Default: 50. */
  bufferSize?: number | undefined
  /** Max ms to wait before flushing. Default: 100. */
  flushIntervalMs?: number | undefined
}

/**
 * Postgres-backed event sink with batched inserts.
 * Fire-and-forget: errors are logged to console, never thrown to callers.
 */
export class PgEventSink implements typegraphEventSink {
  private sql: PgEventSinkConfig['sql']
  private eventsTable: string
  private bufferSize: number
  private flushIntervalMs: number
  private buffer: typegraphEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private timerRefd = false
  private flushing = false
  private beforeExitHandler: (() => void) | null = null
  private destroyed = false

  constructor(config: PgEventSinkConfig) {
    this.sql = config.sql
    this.eventsTable = config.eventsTable ?? 'typegraph_events'
    this.bufferSize = config.bufferSize ?? 50
    this.flushIntervalMs = config.flushIntervalMs ?? 100

    this.timer = setInterval(() => {
      this.flush().catch((err) => console.error('[typegraph] Event flush failed:', err instanceof Error ? err.message : err))
    }, this.flushIntervalMs)

    // Start unref's — an idle sink should never block process exit. We only
    // ref() the timer while the buffer is non-empty (see setTimerRef below),
    // so Node will wait for pending writes to drain but not for nothing.
    this.unrefTimer()

    // Last-chance flush when the event loop would otherwise exit. Covers the
    // case where a short-lived script (benchmark, CLI) finishes its awaited
    // work and returns — without this, anything still in the 100ms window
    // gets dropped on process teardown.
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      this.beforeExitHandler = () => {
        if (this.buffer.length === 0) return
        // beforeExit fires in a context where async work can still run; node
        // will re-check the loop after this callback resolves its microtasks.
        this.flush().catch((err) => console.error('[typegraph] beforeExit flush failed:', err instanceof Error ? err.message : err))
      }
      process.on('beforeExit', this.beforeExitHandler)
    }
  }

  private refTimer(): void {
    if (!this.timer || this.timerRefd) return
    if (typeof this.timer === 'object' && 'ref' in this.timer) {
      (this.timer as { ref: () => void }).ref()
      this.timerRefd = true
    }
  }

  private unrefTimer(): void {
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref()
      this.timerRefd = false
    }
  }

  emit(event: typegraphEvent): void {
    this.buffer.push(event)
    this.refTimer()
    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch((err) => console.error('[typegraph] Event flush failed:', err instanceof Error ? err.message : err))
    }
  }

  emitBatch(events: typegraphEvent[]): void {
    if (events.length === 0) return
    this.buffer.push(...events)
    this.refTimer()
    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch((err) => console.error('[typegraph] Event flush failed:', err instanceof Error ? err.message : err))
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    if (this.flushing) return
    this.flushing = true

    // Drain the buffer up front so concurrent flush() calls can't double-insert
    // the same events (PK violation). On error, events are returned to the
    // front of the buffer for the next flush tick.
    const batch = this.buffer.splice(0, this.buffer.length)

    try {
      // Use unnest-based batch insert for efficiency
      const ids: string[] = []
      const eventTypes: string[] = []
      const tenantIds: (string | null)[] = []
      const groupIds: (string | null)[] = []
      const userIds: (string | null)[] = []
      const agentIds: (string | null)[] = []
      const conversationIds: (string | null)[] = []
      const targetIds: (string | null)[] = []
      const targetTypes: (string | null)[] = []
      const payloads: string[] = []
      const durationMs: (number | null)[] = []
      const traceIds: (string | null)[] = []
      const spanIds: (string | null)[] = []
      const createdAts: string[] = []

      for (const e of batch) {
        ids.push(e.id)
        eventTypes.push(e.eventType)
        tenantIds.push(e.identity.tenantId ?? null)
        groupIds.push(e.identity.groupId ?? null)
        userIds.push(e.identity.userId ?? null)
        agentIds.push(e.identity.agentId ?? null)
        conversationIds.push(e.identity.conversationId ?? null)
        targetIds.push(e.targetId ?? null)
        targetTypes.push(e.targetType ?? null)
        payloads.push(JSON.stringify(e.payload))
        durationMs.push(e.durationMs ?? null)
        traceIds.push(e.traceId ?? null)
        spanIds.push(e.spanId ?? null)
        createdAts.push(e.timestamp.toISOString())
      }

      await this.sql(
        `INSERT INTO ${this.eventsTable} (
          id, event_type, tenant_id, group_id, user_id, agent_id, conversation_id,
          target_id, target_type, payload, duration_ms, trace_id, span_id, created_at
        )
        SELECT * FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
          $8::text[], $9::text[], $10::jsonb[], $11::int[], $12::text[], $13::text[], $14::timestamptz[]
        )`,
        [
          ids, eventTypes, tenantIds, groupIds, userIds, agentIds, conversationIds,
          targetIds, targetTypes, payloads, durationMs, traceIds, spanIds, createdAts,
        ],
      )

      // Insert succeeded — batch is already drained from buffer.
      if (this.buffer.length === 0) {
        this.unrefTimer()
      }
    } catch (err) {
      // Restore the batch to the front of the buffer for retry on the next
      // flush tick. Cap total buffer to 10× bufferSize to prevent unbounded
      // growth if the DB stays unreachable.
      this.buffer.unshift(...batch)
      const maxRetained = this.bufferSize * 10
      if (this.buffer.length > maxRetained) {
        const overflow = this.buffer.length - maxRetained
        this.buffer.splice(0, overflow)
        console.error(`[typegraph] Event buffer overflow: dropped ${overflow} events.`)
      }
      console.error('[typegraph] Failed to flush events (will retry):', (err as Error).message)
      throw err
    } finally {
      this.flushing = false
    }
  }

  /** Stop the flush timer, detach process hooks, and flush remaining events. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.beforeExitHandler && typeof process !== 'undefined' && typeof process.off === 'function') {
      process.off('beforeExit', this.beforeExitHandler)
      this.beforeExitHandler = null
    }
    await this.flush().catch((err) => {
      console.error('[typegraph] Final event flush failed:', err instanceof Error ? err.message : err)
    })
  }
}
