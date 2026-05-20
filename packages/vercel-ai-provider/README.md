# @typegraph-ai/vercel-ai-provider

Vercel AI SDK integration for TypeGraph tools and memory context helpers.

## Install

```bash
pnpm add ai @ai-sdk/openai @typegraph-ai/sdk @typegraph-ai/vercel-ai-provider
```

## Basic Usage

Create tools per request and pass trusted context from your server. Do not ask
the model to provide tenant, user, group, agent, or thread IDs.

```ts
import { generateText, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { AgentId, ThreadId, UserId, typegraphInit } from '@typegraph-ai/sdk'
import { typegraphTools } from '@typegraph-ai/vercel-ai-provider'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
})

export async function answerQuestion(req: Request) {
  const { prompt, userId, threadId } = await req.json()

  const tools = typegraphTools(tg, {
    context: {
      userId: UserId(userId),
      threadId: ThreadId(threadId),
      agentId: AgentId('support-agent'),
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
| `typegraph_search` | Search TypeGraph documents, events, threads, entities, and facts |
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

Graph access is configured on TypeGraph graphs, not on model-selected tool
inputs. Use buckets to route document/event writes to the intended graph:

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

The model cannot choose graph access through this tool surface. Set graph access
in trusted `typegraphInit({ graphs })` config and expose only the buckets/tools
your agent should use.

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
    resources: ['documents', 'facts', 'entities'],
    weights: { semantic: 1, bm25: 0.7, graph: 0.5, recency: 0.3 },
    entityScope: {
      externalIds: [{ type: 'email', id: 'alice@example.com' }],
      mode: 'filter',
    },
    promptBuilder: {
      format: 'markdown',
      sections: ['facts', 'chunks'],
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

const memories = await tg.memory.recall('What answer style does this user prefer?', {
  context: {
    userId: UserId('demo-user'),
    threadId: 'demo-thread',
  },
  limit: 5,
})

console.log(memories)
```

## Memory Middleware

`typegraphMemoryMiddleware()` enriches prompts from scoped memory recall and can
capture response turns back into a TypeGraph thread. Conversation artifact
extraction is opt-in.

```ts
import { typegraphMemoryMiddleware } from '@typegraph-ai/vercel-ai-provider'

const memory = typegraphMemoryMiddleware(tg, {
  context: {
    userId: UserId('demo-user'),
    threadId: ThreadId('demo-thread'),
    agentId: AgentId('support-agent'),
  },
  includeFacts: true,
  format: 'xml',
  conversationMemory: {
    enabled: true,
    mode: 'extract_and_consolidate',
  },
})

const enrichedPrompt = await memory.enrichPrompt('How should I reply?')

await memory.afterResponse([
  { role: 'user', content: 'How should I reply?' },
  { role: 'assistant', content: 'Use a concise answer and mention the SSO workaround.' },
])
```

`afterResponse()` always stores supplied turns with `thread.addTurn()`. When
`conversationMemory.enabled` is true, it also calls `memory.extractThread()`.
When `mode` is `extract_and_consolidate`, it follows with
`memory.consolidate()`. Leave `conversationMemory` unset when you only want
prompt enrichment and turn capture.

## API

| Export | Description |
| --- | --- |
| `typegraphTools(typegraph, opts)` | Full Vercel AI SDK tool set |
| `typegraphMemoryTools(memory, opts)` | Memory-only subset for remember/correct |
| `typegraphMemoryMiddleware(typegraph, opts)` | Prompt enrichment, turn capture, and optional conversation memory extraction |

## Related

- [TypeGraph main repo](../../README.md)
- [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
