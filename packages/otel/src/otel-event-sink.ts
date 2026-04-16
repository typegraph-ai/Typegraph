import type { typegraphEvent, typegraphEventSink } from '@typegraph-ai/sdk'

// OTel semantic convention attribute keys
const ATTR = {
  // GenAI conventions
  GEN_AI_CONVERSATION_ID: 'gen_ai.conversation.id',
  GEN_AI_AGENT_ID: 'gen_ai.agent.id',
  GEN_AI_AGENT_NAME: 'gen_ai.agent.name',
  GEN_AI_DATA_SOURCE_ID: 'gen_ai.data_source.id',
  GEN_AI_OPERATION_NAME: 'gen_ai.operation.name',
  GEN_AI_TOOL_TYPE: 'gen_ai.tool.type',
  GEN_AI_TOOL_CALL_ID: 'gen_ai.tool.call.id',
  GEN_AI_REQUEST_TOP_K: 'gen_ai.request.top_k',
  // typegraph-specific namespace
  TYPEGRAPH_TENANT_ID: 'typegraph.tenant.id',
  TYPEGRAPH_GROUP_ID: 'typegraph.group.id',
  TYPEGRAPH_USER_ID: 'typegraph.user.id',
  TYPEGRAPH_EVENT_TYPE: 'typegraph.event.type',
  TYPEGRAPH_TARGET_ID: 'typegraph.target.id',
  TYPEGRAPH_TARGET_TYPE: 'typegraph.target.type',
  TYPEGRAPH_MEMORY_CATEGORY: 'typegraph.memory.category',
  TYPEGRAPH_QUERY_MODE: 'typegraph.query.mode',
  TYPEGRAPH_VISIBILITY: 'typegraph.visibility',
} as const

// Lazy OTel API loader — avoids top-level await and handles optional peer dep
let _otelApi: typeof import('@opentelemetry/api') | null | undefined

async function getOTelApi(): Promise<typeof import('@opentelemetry/api') | null> {
  if (_otelApi !== undefined) return _otelApi
  try {
    _otelApi = await import('@opentelemetry/api')
  } catch {
    // @opentelemetry/api not installed — sink will be a no-op
    _otelApi = null
  }
  return _otelApi
}

export class OTelEventSink implements typegraphEventSink {
  private readonly _tracer: import('@opentelemetry/api').Tracer | undefined

  /**
   * @param tracer Optional OTel Tracer. If omitted, one is lazily obtained via
   *               `trace.getTracer('typegraph')` when @opentelemetry/api is available.
   */
  constructor(tracer?: import('@opentelemetry/api').Tracer) {
    this._tracer = tracer
  }

  async emit(event: typegraphEvent): Promise<void> {
    const api = await getOTelApi()
    if (api === null) return // OTel not installed — no-op

    const tracer = this._tracer ?? api.trace.getTracer('typegraph')
    const { SpanStatusCode, SpanKind, context, trace } = api

    // Build context: if the event carries a traceId/spanId, link this span
    let parentCtx = api.context.active()
    if (event.traceId && event.spanId) {
      const spanContext: import('@opentelemetry/api').SpanContext = {
        traceId: event.traceId,
        spanId: event.spanId,
        traceFlags: api.TraceFlags.SAMPLED,
      }
      parentCtx = trace.setSpanContext(parentCtx, spanContext)
    }

    const spanName = `typegraph.${event.eventType}`

    const span = tracer.startSpan(
      spanName,
      {
        kind: SpanKind.INTERNAL,
        startTime: event.timestamp,
        attributes: buildAttributes(event),
      },
      parentCtx,
    )

    // Record duration if available
    const endTime =
      event.durationMs !== undefined
        ? new Date(event.timestamp.getTime() + event.durationMs)
        : undefined

    span.setStatus({ code: SpanStatusCode.OK })
    span.end(endTime)
  }

  /** OTel SDK manages its own export pipeline — nothing to flush here. */
  async flush(): Promise<void> {
    // no-op: handled by the OTel SDK's BatchSpanProcessor / exporter
  }
}

// ── Attribute builder ──────────────────────────────────────────────────────────

function buildAttributes(
  event: typegraphEvent,
): Record<string, string | number | boolean> {
  const { identity, eventType, targetId, targetType, payload } = event
  const attrs: Record<string, string | number | boolean> = {}

  // Core event metadata
  attrs[ATTR.TYPEGRAPH_EVENT_TYPE] = eventType

  // Identity — typegraph namespace
  if (identity.tenantId) attrs[ATTR.TYPEGRAPH_TENANT_ID] = identity.tenantId
  if (identity.groupId) attrs[ATTR.TYPEGRAPH_GROUP_ID] = identity.groupId
  if (identity.userId) attrs[ATTR.TYPEGRAPH_USER_ID] = identity.userId

  // Identity — GenAI semantic conventions
  if (identity.agentId) {
    attrs[ATTR.GEN_AI_AGENT_ID] = identity.agentId
  }
  if (identity.conversationId) {
    attrs[ATTR.GEN_AI_CONVERSATION_ID] = identity.conversationId
  }

  // Target object
  if (targetId) attrs[ATTR.TYPEGRAPH_TARGET_ID] = targetId
  if (targetType) attrs[ATTR.TYPEGRAPH_TARGET_TYPE] = targetType

  // Event-type-specific attributes
  switch (eventType) {
    case 'query.execute': {
      attrs[ATTR.GEN_AI_OPERATION_NAME] = 'retrieval'
      if (typeof payload['mode'] === 'string') {
        attrs[ATTR.TYPEGRAPH_QUERY_MODE] = payload['mode']
      }
      if (typeof payload['count'] === 'number') {
        attrs[ATTR.GEN_AI_REQUEST_TOP_K] = payload['count']
      }
      break
    }

    case 'tool.call':
    case 'tool.result': {
      attrs[ATTR.GEN_AI_TOOL_TYPE] = 'datastore'
      if (typeof payload['toolCallId'] === 'string') {
        attrs[ATTR.GEN_AI_TOOL_CALL_ID] = payload['toolCallId']
      }
      if (typeof payload['dataSourceId'] === 'string') {
        attrs[ATTR.GEN_AI_DATA_SOURCE_ID] = payload['dataSourceId']
      }
      break
    }

    case 'memory.write':
    case 'memory.read':
    case 'memory.invalidate':
    case 'memory.correct':
    case 'memory.consolidate':
    case 'memory.decay': {
      if (typeof payload['category'] === 'string') {
        attrs[ATTR.TYPEGRAPH_MEMORY_CATEGORY] = payload['category']
      }
      if (typeof payload['visibility'] === 'string') {
        attrs[ATTR.TYPEGRAPH_VISIBILITY] = payload['visibility']
      }
      break
    }

    case 'index.start':
    case 'index.complete':
    case 'index.document': {
      if (typeof payload['bucketId'] === 'string') {
        attrs[ATTR.GEN_AI_DATA_SOURCE_ID] = payload['bucketId']
      }
      break
    }

    default:
      break
  }

  return attrs
}
