# @typegraph-ai/vercel-ai-provider

Vercel AI SDK integration for TypeGraph tools and memory context helpers.

## Install

```bash
npm install ai @ai-sdk/openai @typegraph-ai/sdk @typegraph-ai/vercel-ai-provider
```

## Basic Usage

Create tools per request and pass trusted context from your server. Do not ask
the model to provide tenant, user, group, agent, or thread IDs.

```ts
import { generateText, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { ThreadId, UserId, typegraphInit } from '@typegraph-ai/sdk'
import { typegraphTools } from '@typegraph-ai/vercel-ai-provider'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
  tenantId: 'tenant_acme',
})

export async function answerQuestion(req: Request) {
  const { prompt, userId, threadId } = await req.json()

  const tools = typegraphTools(tg, {
    context: {
      userId: UserId(userId),
      threadId: ThreadId(threadId),
      agentId: 'support-agent',
    },
  })

  return generateText({
    model: openai('gpt-4.1-mini'),
    tools,
    stopWhen: stepCountIs(4),
    prompt,
  })
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `typegraph_buckets_list` | List buckets in the configured context |
| `typegraph_buckets_get` | Fetch one bucket by ID and verify context |
| `typegraph_buckets_create` | Create a bucket in the configured context |
| `typegraph_document_ingest` | Ingest one or more documents |
| `typegraph_search` | Search TypeGraph retrieval, graph, and memory results |
| `typegraph_remember` | Store scoped memory |
| `typegraph_correct` | Correct scoped memory |
| `typegraph_jobs_list` | List jobs |
| `typegraph_jobs_get` | Fetch one job by ID and verify context |

## Context Scoping

Pass `context` to `typegraphTools()` from your trusted auth/session layer:

```ts
const tools = typegraphTools(tg, {
  context: {
    groupId: project.id,
    userId: user.id,
    threadId: thread.id,
  },
})
```

The provider merges that context into bucket, document ingest, search, memory,
and correction calls. Direct lookup tools such as `typegraph_buckets_get` and
`typegraph_jobs_get` reject records that conflict with the configured context.

Use `context.access` when writing data to control who can read it later:

```ts
await tools.typegraph_document_ingest.execute({
  document: {
    name: 'Alice profile',
    content: 'Alice prefers vegetarian meals.',
  },
  options: {
    bucketId: 'bkt_profiles',
  },
}, { toolCallId: 'manual', messages: [] })
```

The model cannot choose access principals through this tool surface. Set
`context.access` in your trusted server-side call to `typegraphTools()`.

## External IDs

External IDs are stable IDs from your app or source systems. Use them in memory
subjects and entity scopes to keep TypeGraph entities aligned with users,
accounts, documents, tickets, or messages.

Attach external IDs when storing memory:

```ts
await tools.typegraph_remember.execute({
  content: 'Alice prefers short status updates.',
  subject: {
    externalIds: [{ type: 'email', id: 'alice@example.com' }],
    name: 'Alice',
    entityType: 'person',
  },
}, { toolCallId: 'manual', messages: [] })
```

Use external IDs in search to filter around the same entity:

```ts
await tools.typegraph_search.execute({
  text: 'What should I know before replying to Alice?',
  options: {
    resources: ['documents', 'facts', 'entities', 'memories'],
    weights: { semantic: 1, bm25: 0.7, graph: 0.5, recency: 0.3 },
    entityScope: {
      externalIds: [{ type: 'email', id: 'alice@example.com' }],
      mode: 'filter',
    },
    promptBuilder: {
      format: 'markdown',
      sections: ['facts', 'chunks', 'memories'],
    },
  },
}, { toolCallId: 'manual', messages: [] })
```

## Smoke Test

This bypasses model tool selection and directly verifies the tools call your
TypeGraph instance with the expected context.

```ts
import { UserId, typegraphInit } from '@typegraph-ai/sdk'
import { typegraphTools } from '@typegraph-ai/vercel-ai-provider'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
  tenantId: 'tenant_demo',
})

const tools = typegraphTools(tg, {
  context: {
    userId: UserId('demo-user'),
    threadId: 'demo-thread',
  },
})

const toolOptions = { toolCallId: 'manual', messages: [] }

await tools.typegraph_remember.execute({
  content: 'Demo user likes concise answers.',
  subject: {
    externalIds: [{ type: 'user_id', id: 'demo-user' }],
    name: 'Demo User',
  },
}, toolOptions)

const result = await tools.typegraph_search.execute({
  text: 'What answer style does this user prefer?',
  options: {
    resources: ['memories'],
    weights: { semantic: 1, bm25: false, graph: false, recency: 0.3 },
    promptBuilder: true,
  },
}, toolOptions)

console.log(result.prompt ?? result.results.memories)
```

## API

| Export | Description |
| --- | --- |
| `typegraphTools(typegraph, opts)` | Full Vercel AI SDK tool set |
| `typegraphMemoryTools(memory, opts)` | Memory-only subset for remember/correct |
| `typegraphMemoryMiddleware(memory, opts)` | Prompt enrichment helper for memory recall |

## Related

- [TypeGraph main repo](../../README.md)
- [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
