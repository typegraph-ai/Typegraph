# @typegraph-ai/otel

OpenTelemetry event sink for TypeGraph.

This package maps TypeGraph SDK events to OpenTelemetry spans. It is optional:
if `@opentelemetry/api` is not installed, the sink is a no-op.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/otel @opentelemetry/api
```

## Usage

```ts
import { OTelEventSink } from '@typegraph-ai/otel'
import { typegraphInit } from '@typegraph-ai/sdk'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
  eventSink: new OTelEventSink(),
})
```

Pass a tracer when you want to control the tracer instance:

```ts
import { trace } from '@opentelemetry/api'
import { OTelEventSink } from '@typegraph-ai/otel'

const eventSink = new OTelEventSink(trace.getTracer('my-app'))
```

The sink creates spans named `typegraph.<eventType>` and attaches TypeGraph
identity, target, memory, query, tool, and indexing attributes where available.

## Exports

| Export | Purpose |
| --- | --- |
| `OTelEventSink` | TypeGraph `eventSink` implementation backed by OpenTelemetry spans |

## Related

- [SDK README](../sdk/README.md)
- [Repository README](../../README.md)
