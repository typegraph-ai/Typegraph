# @typegraph-ai/sdk

The TypeGraph SDK is the main TypeScript API for a business context graph:
documents, events, threads, entities, facts, memory, jobs, policies, telemetry,
and hybrid search from one client.

This package README documents the current SDK surface. Use the repository root
README for the product-level overview.

## Install

```bash
pnpm add @typegraph-ai/sdk @typegraph-ai/adapter-pgvector @ai-sdk/gateway @neondatabase/serverless
```

## Core Model

TypeGraph is tenant-scoped. `tenantId` is configured once on `typegraphInit` or
`typegraphDeploy`, and it is the hard graph/data boundary.

Use separate tenant IDs when you need separate graph universes. Do not use
separate tenant IDs for customer accounts inside one B2B product intelligence
graph if you need cross-customer questions like "Which customers are blocked by
SSO issues?" Model those customers as entities instead.

Graphs are the logical knowledge boundaries inside a tenant. The default bucket
is `public`, the default graph is `public`, and the `public` bucket writes to
the `public` graph. Buckets own write routing; ingest calls choose a bucket, not
an ad hoc graph.

Per-call actor identity lives under one key: `context`.

```ts
import { AgentId, GroupId, UserId } from '@typegraph-ai/sdk'

const context = {
  userId: UserId('dana'),
  groupId: GroupId('success'),
  agentId: AgentId('successbot'),
}
```

Graph access belongs on graph config, not on individual records. Event
participants are provenance and business graph context only; they never grant
read access automatically.

## Quick Start

```ts
import { gateway } from '@ai-sdk/gateway'
import { neon } from '@neondatabase/serverless'
import { PgVectorAdapter } from '@typegraph-ai/adapter-pgvector'
import {
  AgentId,
  GroupId,
  TenantId,
  UserId,
  entityRef,
  typegraphDeploy,
  typegraphInit,
} from '@typegraph-ai/sdk'

const sql = neon(process.env.DATABASE_URL!)
const vectorStore = new PgVectorAdapter({ sql })

const config = {
  tenantId: TenantId('tenant_acme'),
  vectorStore,
  embedding: {
    model: gateway.embeddingModel('openai/text-embedding-3-small'),
    dimensions: 1536,
  },
  searchEmbedding: {
    model: gateway.embeddingModel('openai/text-embedding-3-small'),
    dimensions: 1536,
  },
  llm: {
    model: gateway('openai/gpt-5.4-mini'),
  },
  graphs: {
    public: { access: 'public' },
    internal: {
      extends: ['public'],
      access: {
        read: { groups: [GroupId('employees')] },
        write: { groups: [GroupId('employees')] },
      },
    },
  },
  buckets: {
    public: { graph: 'public' },
    gong: { name: 'Gong Calls', graph: 'internal', graphExtraction: true },
  },
  ontology: {
    version: '2026-05-08',
    profiles: ['saas'],
  },
}

await typegraphDeploy(config)
const tg = await typegraphInit(config)
```

`typegraphDeploy(config)` creates storage objects. `typegraphInit(config)` is
the lightweight app-runtime initializer. Applications should not call graph or
memory bridge constructors; `vectorStore + embedding + llm` is enough
for graph extraction, graph APIs, and memory APIs when the adapter supports the
required storage capabilities.

## Documents

Documents are durable long-form content with chunks and embeddings.

```ts
await tg.document.ingest(
  [
    {
      id: 'zendesk:article:42',
      name: 'SAML troubleshooting',
      description: 'Known SAML setup failures and resolutions.',
      content: articleBody,
      metadata: { provider: 'zendesk', locale: 'en-US' },
    },
    {
      id: 'notion:page:pricing-faq',
      name: 'Pricing FAQ',
      description: 'Internal pricing and packaging answers.',
      content: pricingFaq,
      metadata: { provider: 'notion' },
    },
  ],
  {
    bucketId: 'support',
    context: {
      userId: UserId('dana'),
    },
  },
)
```

Document inputs use the standard primary fields:

```ts
{
  id?: string
  name: string
  description?: string
  url?: string | null
  content: string
  metadata?: Record<string, unknown>
}
```

## Events

Events are time-anchored business occurrences. They can contain short event
content and can attach documents, such as meeting transcripts or support
exports.

```ts
await tg.event.ingest(
  {
    id: 'gong:meeting:123',
    name: 'Acme discovery call',
    description: 'Acme reported an SSO redirect loop blocking enterprise rollout.',
    url: 'https://gong.example.com/calls/123',
    occurredAt: new Date('2026-05-08T17:00:00Z'),
    participants: [
      entityRef('organization', 'org_acme'),
      entityRef('product_area', 'auth'),
      entityRef('issue', 'sso_redirect_loop'),
      entityRef('user', 'dana'),
    ],
    documents: [
      {
        id: 'gong:transcript:123',
        name: 'Acme discovery call transcript',
        description: 'Transcript from the Acme discovery call.',
        url: 'https://gong.example.com/calls/123/transcript',
        content: transcriptText,
        metadata: { provider: 'gong' },
      },
    ],
    metadata: { provider: 'gong', meetingId: '123' },
  },
  {
    bucketId: 'gong',
    context: {
      userId: UserId('dana'),
      groupId: GroupId('success'),
    },
  },
)
```

In this example, `organization:org_acme`, `product_area:auth`, and
`issue:sso_redirect_loop` are graph/business participants. The `gong` bucket
routes the write into the graph configured for that bucket. Product can ask
cross-customer questions when it searches the graph that contains those records.

`event.ingest()` accepts one event or an array. Attached documents inherit the
selected bucket and therefore the selected bucket's graph.

## Threads

Threads are ordered containers. Turns are intentionally simple message records:

```ts
await tg.thread.upsert(
  {
    id: 'thread_123',
    name: 'Acme renewal workflow',
    description: 'Working thread for Acme renewal risk and next steps.',
    url: 'https://slack.example.com/archives/C123',
    metadata: { crmAccountId: '001-acme' },
  },
  { bucketId: 'gong', context: { groupId: GroupId('success') } },
)

await tg.thread.addTurn(
  'thread_123',
  {
    role: 'user',
    content: 'Acme needs a workaround for the SSO redirect loop before Friday.',
    url: 'https://slack.example.com/archives/C123/p456',
    timestamp: new Date(),
    metadata: { source: 'slack' },
  },
  {
    context: {
      userId: UserId('dana'),
      threadId: 'thread_123',
      groupId: GroupId('success'),
    },
    bucketId: 'gong',
  },
)
```

`thread.addTurn()` creates a linked event internally. A turn does not have
`name`, `description`, or per-turn access fields.

## Search

Search separates identity, target resources, scoring weights, and prompt
assembly.

```ts
const response = await tg.search('Which customers are blocked by SSO issues?', {
  graph: 'internal',
  context: {
    userId: UserId('dana'),
    groupId: GroupId('product'),
  },
  buckets: ['gong', 'zendesk', 'salesforce'],
  resources: ['events', 'documents', 'facts', 'entities'],
  weights: {
    semantic: 1,
    bm25: 0.7,
    graph: 0.8,
    recency: 0.3,
  },
  fusion: { method: 'rrf', k: 60 },
  subqueries: [
    'customers reporting SAML or login blockers',
    'open enterprise deals with authentication issues',
  ],
  rerank: {
    topK: 20,
    query: 'Which customers are blocked by SSO issues?',
  },
  limit: 10,
  promptBuilder: {
    format: 'markdown',
    sections: ['facts', 'entities', 'chunks'],
    maxTotalTokens: 6000,
  },
  explain: true,
})

response.results.chunks
response.results.facts
response.results.entities
response.prompt
response.promptStats
response.explanation
```

`rerank` uses the `reranker` passed to `typegraphInit()`.
When reranking is requested without a configured reranker, search logs a warning
and falls back to fused results. When a reranker is configured, TypeGraph
overfetches candidates before reranking, then slices chunks to `limit`.
Reranking is an internal ordering step over `QueryChunkResult[]`; `tg.search()`
still returns the normal `QueryResponse` shape.

`subqueries` are caller-supplied supplemental retrieval queries. TypeGraph
normalizes and deduplicates up to eight of them, runs the primary and
supplemental searches concurrently, and reranks every pass against
`rerank.query` (or the primary search text by default). It then deduplicates and
merges the per-pass results without making a final network reranker call. Omit
`subqueries` for the unchanged single-search path.

Provider wrappers should map provider rankings back to the original chunk
candidates and retain real provider relevance scores:

```ts
import { cohere } from '@ai-sdk/cohere'
import { rerank } from 'ai'
import type { QueryChunkResult, Reranker } from '@typegraph-ai/sdk'

const cohereReranker: Reranker<QueryChunkResult> = {
  name: 'cohere-rerank',
  async rerank(query, candidates, opts) {
    const { ranking } = await rerank({
      model: cohere.reranking('rerank-v3.5'),
      query,
      documents: candidates,
      topN: opts?.topK,
      abortSignal: opts?.abortSignal,
    })

    return ranking.flatMap(item => {
      const candidate = candidates[item.originalIndex]
      return candidate ? [{ candidate, score: item.score }] : []
    })
  },
}
```

Raw Cohere responses expose `results[].index` and `relevance_score`; Vercel AI
SDK `rerank()` exposes `ranking[].originalIndex`, `score`, and `document`.
TypeGraph accepts both the scored wrapper above and legacy reordered
`QueryChunkResult[]` results. Scores must be finite values in `[0, 1]`. With
scored results, TypeGraph preserves the provider value in
`scores.raw.reranker`, `scores.output.reranker`, and the result's top-level
`score`; `scores.output.fused` continues to hold the original retrieval score.
Legacy ordered arrays—and scored arrays containing invalid scores—use the
existing deterministic rank-position score.

Search resources:

```ts
type SearchResource =
  | 'documents'
  | 'events'
  | 'threads'
  | 'entities'
  | 'facts'
```

Search weights:

```ts
type SearchWeights = {
  semantic?: number | false
  bm25?: number | false
  graph?: number | false
  recency?: number | false
}
```

Defaults are `{ semantic: 1, bm25: 0.7, graph: 0.5, recency: 0.3 }`. Set a
weight to `false` to disable that scoring signal.

Use `promptBuilder` when you want an LLM-ready string. The generated string is
returned as `response.prompt`; prompt assembly statistics are returned as
`response.promptStats`.

`abortSignal` is part of the public options shape and custom embedders or
extractors can honor it through their own contracts. Treat full end-to-end
adapter cancellation as best-effort until every storage and model path supports
it.

```ts
const controller = new AbortController()

await tg.document.ingest(document, {
  context: { userId: UserId('dana') },
  abortSignal: controller.signal,
})
```

## Embedding

TypeGraph uses final `Embedder` naming. Ingest and search embedders can
be configured separately as long as they produce vectors in the same space.

```ts
type EmbedInput = {
  texts: string[]
  inputType?: 'document' | 'search'
  outputDimensions?: number
  abortSignal?: AbortSignal
}

interface Embedder {
  name: string
  dimensions: number
  maxBatchSize?: number
  supportsAsymmetric?: boolean
  embed(input: EmbedInput): Promise<number[][]>
}
```

```ts
await typegraphInit({
  vectorStore,
  embedding: documentEmbedder,
  searchEmbedding,
  additionalEmbeddings: [specializedLegalEmbedder],
})
```

Bucket config can override the defaults with `embeddingModel` and
`searchEmbeddingModel`.

## Extraction And Ontology

`graphExtraction: true` runs the configured extractor. If you pass `llm`,
TypeGraph builds its internal default extractor. If you pass `extractor`, your
extractor wins. Single-pass, two-pass, and prompt staging are not public API.

```ts
await typegraphInit({
  vectorStore,
  embedding,
  llm: { model: gateway.languageModel('openai/gpt-4.1-mini') },
  extractor: customExtractor,
  ontology: {
    version: '2026-05-08',
    profiles: ['saas'],
    entities: {
      organization: {
        description: 'Customer, vendor, partner, or internal org',
        vocabulary: [{ vocabulary: 'schema.org', id: 'Organization', uri: 'https://schema.org/Organization' }],
      },
      product_area: { description: 'Owned product surface or component' },
      issue: { description: 'Product, support, security, or implementation issue' },
    },
    relations: {
      experiences_issue: {
        from: ['organization'],
        to: ['issue'],
        description: 'Organization is affected by an issue',
      },
    },
  },
})
```

Custom extractors implement:

```ts
interface Extractor {
  name: string
  capabilities: ExtractorCapabilities
  extract(input: ExtractorInput, ctx: ExtractorContext): Promise<ExtractionResult>
}
```

Ontology is supplied on deploy/init so every process uses the same
config-driven model. Built-in profiles are `general`, `literary`,
`medical`, `legal`, and `saas`. They use the same config shape as custom
ontologies and include lightweight references to mature vocabularies such as
Schema.org, Wikidata, HL7 FHIR, SNOMED CT, LOINC, RxNorm, ELI, Akoma Ntoso,
LegalRuleML, OpenTelemetry semantic conventions, TM Forum SID, and ITIL. These
references are metadata for grounding, mapping, and future import tooling; they
are not expanded into the extraction prompt.

## Memory

Memory operations share the same `context` and optional `graphExtraction` shape.
Structured memory records remain the recall layer:

```ts
await tg.memory.remember('Dana prefers concise renewal risk summaries.', {
  context: {
    userId: UserId('dana'),
  },
  graphExtraction: true,
})

await tg.memory.correct('Dana no longer owns Acme renewals; Taylor does.', {
  context: {
    userId: UserId('taylor'),
  },
  graphExtraction: true,
})

const recalled = await tg.memory.recall('renewal summary style', {
  context: { userId: UserId('dana') },
  types: ['semantic'],
  limit: 5,
})
```

Conversation memory adds database-backed Markdown-like artifacts for agent
context. Thread turns are stored as linked events, then `extractThread()` writes
raw memory and rollout summary artifacts. `consolidate()` rewrites the durable
handbook and compact prompt summary. `context()` returns the progressive read
path: summary first, relevant handbook blocks, and optional structured recall.

```ts
await tg.thread.addTurn('thread_123', {
  role: 'user',
  content: 'Keep implementation plans concise and decision complete.',
}, {
  context: {
    userId: UserId('dana'),
    threadId: 'thread_123',
  },
})

await tg.memory.extractThread('thread_123', {
  context: { userId: UserId('dana') },
})

await tg.memory.consolidate({
  context: { userId: UserId('dana') },
})

const contextMemory = await tg.memory.context('planning style', {
  context: { userId: UserId('dana') },
  includeStructuredRecall: true,
  format: 'markdown',
})

console.log(contextMemory.prompt)
```

Artifact paths follow the default layout:

- `memory_summary.md`
- `MEMORY.md`
- `raw_memories.md`
- `raw_memories/<thread-id>.md`
- `rollout_summaries/<thread-id>_<slug>.md`
- `phase_two_selection.json`
- `skills/<skill-name>/SKILL.md`

Direct artifact access is available when you need to inspect or manage the
database-backed files explicitly:

```ts
await tg.memory.artifacts.upsert({
  path: 'MEMORY.md',
  kind: 'handbook',
  content: '# Task Group: Planning\n\nscope: Use for implementation plans.\n',
}, {
  context: { userId: UserId('dana') },
})

const summary = await tg.memory.artifacts.get('memory_summary.md', {
  context: { userId: UserId('dana') },
})

const raw = await tg.memory.artifacts.list({
  context: { userId: UserId('dana') },
  prefix: 'raw_memories',
})
```

Conversation memory needs an adapter with artifact persistence, such as
`@typegraph-ai/adapter-pgvector`, and an `llm` for extraction and consolidation.

## Main Exports

| Export | Purpose |
| --- | --- |
| `typegraphInit` | Initialize a TypeGraph runtime instance |
| `typegraphDeploy` | Create required storage objects in Postgres |
| `TenantId`, `UserId`, `GroupId`, `AgentId`, `ThreadId`, `EntityId`, `entityRef` | Branded identity helpers |
| `aiSdkEmbedder`, `aiSdkLlmProvider` | Explicit AI SDK wrappers when needed |
| `Embedder`, `Extractor`, `Reranker`, `OntologyConfig` | Pluggable model/extraction contracts |
| `SearchOptions`, `SearchResource`, `SearchWeights`, `QueryResponse`, `PromptBuilderOptions` | Search and prompt assembly types |
| `DocumentInput`, `EventInput`, `ThreadInput`, `ThreadTurnInput` | Primary write model types |
| `MemoryArtifact`, `MemoryArtifactKind`, `ConversationMemoryExtraction`, `MemoryContextResult` | Memory artifact and conversation memory types |

## Learn More

- [Repository README](../../README.md)
- [TypeGraph docs](https://typegraph.ai/docs)
