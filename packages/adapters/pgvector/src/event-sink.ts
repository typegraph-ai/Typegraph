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

  constructor(config: PgEventSinkConfig) {
    this.sql = config.sql
    this.eventsTable = config.eventsTable ?? 'typegraph_events'
    this.bufferSize = config.bufferSize ?? 50
    this.flushIntervalMs = config.flushIntervalMs ?? 100

    this.timer = setInterval(() => {
      this.flush().catch((err) => console.error('[typegraph] Event flush failed:', err instanceof Error ? err.message : err))
    }, this.flushIntervalMs)

    // Allow Node.js to exit even if the timer is active
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  emit(event: typegraphEvent): void {
    this.buffer.push(event)
    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch((err) => console.error('[typegraph] Event flush failed:', err instanceof Error ? err.message : err))
    }
  }

  emitBatch(events: typegraphEvent[]): void {
    this.buffer.push(...events)
    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch((err) => console.error('[typegraph] Event flush failed:', err instanceof Error ? err.message : err))
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return

    // Snapshot the buffer without draining it; only drain after the INSERT succeeds
    // so a transient DB failure doesn't silently swallow events.
    const batch = this.buffer.slice()

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

      // Insert succeeded — drain the events we just persisted from the buffer.
      // (Other emits may have arrived during the await; splice by count, not clear.)
      this.buffer.splice(0, batch.length)
    } catch (err) {
      // Retain events for a retry on the next flush tick. Cap total buffer to
      // 10× bufferSize to prevent unbounded growth if the DB stays unreachable.
      const maxRetained = this.bufferSize * 10
      if (this.buffer.length > maxRetained) {
        const overflow = this.buffer.length - maxRetained
        this.buffer.splice(0, overflow)
        console.error(`[typegraph] Event buffer overflow: dropped ${overflow} events.`)
      }
      console.error('[typegraph] Failed to flush events (will retry):', (err as Error).message)
      throw err
    }
  }

  /** Stop the flush timer and flush remaining events. */
  async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.flush().catch((err) => {
      console.error('[typegraph] Final event flush failed:', err instanceof Error ? err.message : err)
    })
  }
}
