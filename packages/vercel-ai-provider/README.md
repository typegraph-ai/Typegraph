# @typegraph-ai/vercel-ai-provider

Vercel AI SDK integration for TypeGraph tools and memory context helpers.

## Install

```bash
npm install ai @ai-sdk/openai @typegraph-ai/sdk @typegraph-ai/vercel-ai-provider
```

## Basic Usage

Create tools per request and pass the authenticated identity from your server.
Do not ask the model to provide tenant or user IDs.

```ts
import { generateText, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { typegraphInit } from '@typegraph-ai/sdk'
import { typegraphTools } from '@typegraph-ai/vercel-ai-provider'

const tg = await typegraphInit({
  apiKey: process.env.TYPEGRAPH_API_KEY!,
})

export async function answerQuestion(req: Request) {
  const { prompt, orgId, userId, threadId } = await req.json()

  const tools = typegraphTools(tg, {
    identity: {
      tenantId: orgId,
      userId,
      conversationId: threadId,
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
| `typegraph_buckets_list` | List buckets in the configured identity scope |
| `typegraph_buckets_get` | Fetch one bucket by ID and verify scope |
| `typegraph_buckets_create` | Create a bucket in the configured identity scope |
| `typegraph_source_ingest` | Ingest one or more sources |
| `typegraph_query` | Query TypeGraph retrieval, graph, and memory results |
| `typegraph_memory_remember` | Store scoped memory |
| `typegraph_memory_correct` | Correct scoped memory |
| `typegraph_jobs_list` | List jobs in the configured identity scope |
| `typegraph_jobs_get` | Fetch one job by ID and verify scope |

## Identity Scoping

Pass identity to `typegraphTools()` from your trusted auth/session layer:

```ts
const tools = typegraphTools(tg, {
  identity: {
    tenantId: org.id,
    groupId: project.id,
    userId: user.id,
    conversationId: conversation.id,
  },
})
```

The provider merges that identity into bucket, ingest, query, memory, and job
calls. Direct lookup tools such as `typegraph_buckets_get` and
`typegraph_jobs_get` reject records that conflict with the configured identity.

Use `visibility` when writing data to control who can read it later:

```ts
await tools.typegraph_source_ingest.execute({
  source: {
    title: 'Alice profile',
    content: 'Alice prefers vegetarian meals.',
    subject: {
      externalIds: [{ type: 'email', id: 'alice@example.com' }],
      name: 'Alice',
      entityType: 'person',
    },
  },
  options: {
    bucketId: 'bkt_profiles',
    visibility: 'user',
  },
}, { toolCallId: 'manual', messages: [] })
```

`visibility: 'user'` means later queries must include the matching `userId`.
Use `tenant`, `group`, `agent`, or `conversation` for wider or narrower scopes.

## External IDs

External IDs are stable IDs from your app or source systems. Use them to keep
TypeGraph entities aligned with your users, accounts, documents, tickets, or
messages.

Attach external IDs when ingesting sources:

```ts
source: {
  title: 'Linear issue ENG-123',
  content: issueBody,
  subject: {
    externalIds: [{ type: 'linear_issue_id', id: 'ENG-123' }],
    name: 'ENG-123',
    entityType: 'ticket',
  },
}
```

Attach external IDs when storing memory:

```ts
await tools.typegraph_memory_remember.execute({
  content: 'Alice prefers short status updates.',
  subject: {
    externalIds: [{ type: 'email', id: 'alice@example.com' }],
    name: 'Alice',
    entityType: 'person',
  },
  visibility: 'user',
}, { toolCallId: 'manual', messages: [] })
```

Use external IDs in queries to filter or boost around the same entity:

```ts
await tools.typegraph_query.execute({
  text: 'What should I know before replying to Alice?',
  options: {
    signals: { semantic: true, graph: true, memory: true },
    entityScope: {
      externalIds: [{ type: 'email', id: 'alice@example.com' }],
      mode: 'filter',
    },
    context: {
      format: 'markdown',
      sections: ['facts', 'chunks', 'memories'],
    },
  },
}, { toolCallId: 'manual', messages: [] })
```

## Smoke Test

This bypasses model tool selection and directly verifies the tools call your
TypeGraph instance with the expected scope.

```ts
import { typegraphInit } from '@typegraph-ai/sdk'
import { typegraphTools } from '@typegraph-ai/vercel-ai-provider'

const tg = await typegraphInit({ apiKey: process.env.TYPEGRAPH_API_KEY! })

const tools = typegraphTools(tg, {
  identity: {
    tenantId: 'demo-org',
    userId: 'demo-user',
    conversationId: 'demo-thread',
  },
})

const toolOptions = { toolCallId: 'manual', messages: [] }

await tools.typegraph_memory_remember.execute({
  content: 'Demo user likes concise answers.',
  subject: {
    externalIds: [{ type: 'user_id', id: 'demo-user' }],
    name: 'Demo User',
  },
  visibility: 'user',
}, toolOptions)

const result = await tools.typegraph_query.execute({
  text: 'What answer style does this user prefer?',
  options: {
    signals: { memory: true },
    entityScope: {
      externalIds: [{ type: 'user_id', id: 'demo-user' }],
      mode: 'filter',
    },
    context: true,
  },
}, toolOptions)

console.log(result.context ?? result.results.memories)
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
