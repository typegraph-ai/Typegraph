import { jsonSchema, type Tool } from 'ai'
import type {
  BucketListFilter,
  CorrectOpts,
  CreateBucketInput,
  DocumentIngestOptions,
  DocumentInput,
  JobFilter,
  PaginationOpts,
  QueryOpts,
  RememberOpts,
  TypeGraphContext,
  typegraphInstance,
} from '@typegraph-ai/sdk'

export type TypegraphToolName =
  | 'typegraph_buckets_list'
  | 'typegraph_buckets_get'
  | 'typegraph_buckets_create'
  | 'typegraph_document_ingest'
  | 'typegraph_search'
  | 'typegraph_remember'
  | 'typegraph_correct'
  | 'typegraph_jobs_list'
  | 'typegraph_jobs_get'

export type TypegraphToolDefinition = Tool<any, unknown>
/** @deprecated Use TypegraphToolDefinition instead. */
export type ToolDefinition = TypegraphToolDefinition

export type TypegraphToolsTarget = Pick<
  typegraphInstance,
  'bucket' | 'document' | 'search' | 'remember' | 'correct' | 'job'
>

export interface TypegraphMemoryToolsTarget {
  remember: (content: string, opts?: any) => Promise<unknown>
  correct: (correction: string, opts?: any) => Promise<unknown>
}

export interface TypegraphToolsOptions {
  /**
   * Trusted request context supplied by your server. This is merged into every
   * scoped TypeGraph call so the model cannot select another user/group/agent scope.
   */
  context?: TypeGraphContext | undefined
}

type JsonObject = Record<string, unknown>

interface BucketsListInput {
  filter?: BucketListFilter
  pagination?: PaginationOpts
}

interface BucketsGetInput {
  bucketId: string
}

interface BucketsCreateInput extends CreateBucketInput {}

interface DocumentIngestInput {
  document?: DocumentInput
  documents?: DocumentInput[]
  options?: Omit<DocumentIngestOptions, 'context'>
}

interface QueryInput {
  text: string
  options?: Omit<QueryOpts, 'context'>
}

interface MemoryRememberInput extends Omit<RememberOpts, 'context'> {
  content: string
}

interface MemoryCorrectInput extends Omit<CorrectOpts, 'context'> {
  correction: string
}

interface JobsListInput {
  filter?: JobFilter
}

interface JobsGetInput {
  jobId: string
}

const IDENTITY_KEYS = [
  'groupId',
  'userId',
  'agentId',
  'threadId',
] as const

function compactObject<T extends JsonObject>(value: T): Partial<T> {
  const out: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) out[key] = item
  }
  return out as Partial<T>
}

function compactContext(context?: TypeGraphContext): TypeGraphContext | undefined {
  if (!context) return undefined
  const out: TypeGraphContext = {}
  for (const key of IDENTITY_KEYS) {
    const value = context[key]
    if (value !== undefined && value !== null) {
      ;(out as JsonObject)[key] = value as unknown
    }
  }
  if (context.principals?.length) out.principals = context.principals
  if (context.access?.length) out.access = context.access
  if (context.traceId) out.traceId = context.traceId
  if (context.spanId) out.spanId = context.spanId
  if (context.agentName) out.agentName = context.agentName
  if (context.agentDescription) out.agentDescription = context.agentDescription
  if (context.agentVersion) out.agentVersion = context.agentVersion
  return Object.keys(out).length > 0 ? out : undefined
}

function scopedOptions<T extends JsonObject>(value: T | undefined, opts: TypegraphToolsOptions): T & { context?: TypeGraphContext | undefined } {
  const context = compactContext(opts.context)
  return compactObject({
    ...(value ?? {}),
    ...(context ? { context } : {}),
  }) as T & { context?: TypeGraphContext | undefined }
}

function scopedQueryOptions(value: QueryInput['options'] | undefined, opts: TypegraphToolsOptions): QueryOpts {
  return scopedOptions((value ?? {}) as JsonObject, opts) as QueryOpts
}

function normalizeDocument(document: DocumentInput): DocumentInput {
  return compactObject({
    ...document,
    updatedAt: coerceDate(document.updatedAt),
    createdAt: coerceDate(document.createdAt),
  }) as DocumentInput
}

function coerceDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') return new Date(value)
  return undefined
}

function assertMatchesContext(
  record: JsonObject | undefined | null,
  context: TypeGraphContext | undefined,
  label: string,
): void {
  if (!record || !context) return
  for (const key of IDENTITY_KEYS) {
    const expected = context[key]
    if (expected === undefined) continue
    const actual = record[key] ?? (record['identity'] as JsonObject | undefined)?.[key]
    if (actual !== undefined && actual !== expected) {
      throw new Error(`${label} is outside the configured TypeGraph context.`)
    }
  }
}

function schema<T>(json: JsonObject): ReturnType<typeof jsonSchema<T>> {
  return jsonSchema<T>(json as never)
}

const externalIdSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Stable identifier from your app or source system.' },
    type: { type: 'string', description: 'Identifier namespace, e.g. email, clerk_user_id, slack_user_id.' },
    encoding: { type: 'string', enum: ['none', 'sha256'] },
    metadata: { type: 'object', additionalProperties: true },
  },
  required: ['id', 'type'],
}

const subjectSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    entityId: { type: 'string' },
    externalIds: { type: 'array', items: externalIdSchema },
    name: { type: 'string' },
    entityType: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
  },
}

const documentSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    content: { type: 'string' },
    url: { type: 'string' },
    createdAt: { type: 'string', description: 'ISO timestamp.' },
    updatedAt: { type: 'string', description: 'ISO timestamp.' },
    mimeType: { type: 'string' },
    language: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
  },
  required: ['content', 'name'],
}

const paginationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number' },
    offset: { type: 'number' },
  },
}

const indexDefaultsSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    chunkSize: { type: 'number' },
    chunkOverlap: { type: 'number' },
    stripMarkdownForEmbedding: { type: 'boolean' },
    propagateMetadata: { type: 'array', items: { type: 'string' } },
    graphExtraction: { type: 'boolean' },
  },
}

function memoryRememberTool(target: TypegraphMemoryToolsTarget, opts: TypegraphToolsOptions): Tool<MemoryRememberInput, unknown> {
  return {
    description: 'Store a scoped TypeGraph memory for future recall.',
    inputSchema: schema<MemoryRememberInput>({
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'Memory content to store.' },
        category: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        metadata: { type: 'object', additionalProperties: true },
        subject: subjectSchema,
        relatedEntities: { type: 'array', items: subjectSchema },
      },
      required: ['content'],
    }),
    execute: async (input) => {
      const { content, ...rest } = input
      return target.remember(content, scopedOptions(rest as JsonObject, opts) as RememberOpts)
    },
  }
}

function memoryCorrectTool(target: TypegraphMemoryToolsTarget, opts: TypegraphToolsOptions): Tool<MemoryCorrectInput, unknown> {
  return {
    description: 'Correct scoped TypeGraph memory with a natural language correction.',
    inputSchema: schema<MemoryCorrectInput>({
      type: 'object',
      additionalProperties: false,
      properties: {
        correction: { type: 'string', description: 'Natural language correction to apply.' },
        subject: subjectSchema,
        relatedEntities: { type: 'array', items: subjectSchema },
      },
      required: ['correction'],
    }),
    execute: async (input) => {
      const { correction, ...rest } = input
      return target.correct(correction, scopedOptions(rest as JsonObject, opts) as CorrectOpts)
    },
  }
}

export function typegraphMemoryTools(
  memory: TypegraphMemoryToolsTarget,
  opts: TypegraphToolsOptions = {},
): Pick<Record<TypegraphToolName, TypegraphToolDefinition>, 'typegraph_remember' | 'typegraph_correct'> {
  return {
    typegraph_remember: memoryRememberTool(memory, opts),
    typegraph_correct: memoryCorrectTool(memory, opts),
  }
}

export function typegraphTools(
  typegraph: TypegraphToolsTarget,
  opts: TypegraphToolsOptions = {},
): Record<TypegraphToolName, TypegraphToolDefinition> {
  return {
    typegraph_buckets_list: {
      description: 'List TypeGraph buckets in the configured context.',
      inputSchema: schema<BucketsListInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          filter: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
            },
            description: 'Optional non-context bucket filters. Context is supplied by the server.',
          },
          pagination: paginationSchema,
        },
      }),
      execute: async (input) => {
        return typegraph.bucket.list(input.filter ?? {}, scopedOptions({}, opts), input.pagination)
      },
    },

    typegraph_buckets_get: {
      description: 'Get one TypeGraph bucket by ID.',
      inputSchema: schema<BucketsGetInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          bucketId: { type: 'string' },
        },
        required: ['bucketId'],
      }),
      execute: async (input) => {
        const bucket = await typegraph.bucket.get(input.bucketId)
        assertMatchesContext(bucket as JsonObject | undefined, opts.context, 'Bucket')
        return bucket
      },
    },

    typegraph_buckets_create: {
      description: 'Create a TypeGraph bucket in the configured context.',
      inputSchema: schema<BucketsCreateInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          embeddingModel: { type: 'string' },
          searchEmbeddingModel: { type: 'string' },
          indexDefaults: indexDefaultsSchema,
        },
        required: ['name'],
      }),
      execute: async (input) => {
        return typegraph.bucket.create(input, scopedOptions({}, opts))
      },
    },

    typegraph_document_ingest: {
      description: 'Ingest one or more documents into TypeGraph in the configured context.',
      inputSchema: schema<DocumentIngestInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          document: documentSchema,
          documents: { type: 'array', items: documentSchema },
          options: {
            type: 'object',
            additionalProperties: true,
            properties: {
              bucketId: { type: 'string' },
              mode: { type: 'string', enum: ['upsert', 'replace'] },
              chunkSize: { type: 'number' },
              chunkOverlap: { type: 'number' },
              stripMarkdownForEmbedding: { type: 'boolean' },
              graphExtraction: { type: 'boolean' },
              dryRun: { type: 'boolean' },
              concurrency: { type: 'number' },
            },
          },
        },
      }),
      execute: async (input) => {
        const documents = [
          ...(input.document ? [input.document] : []),
          ...(input.documents ?? []),
        ].map(normalizeDocument)

        if (documents.length === 0) {
          throw new Error('typegraph_document_ingest requires document or documents.')
        }

        return typegraph.document.ingest(documents, {
          ...scopedOptions((input.options ?? {}) as JsonObject, opts),
        } as DocumentIngestOptions)
      },
    },

    typegraph_search: {
      description: 'Search TypeGraph retrieval results in the configured context.',
      inputSchema: schema<QueryInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Natural language query.' },
          options: {
            type: 'object',
            additionalProperties: true,
            properties: {
              buckets: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number' },
              resources: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['documents', 'events', 'threads', 'entities', 'facts', 'memories'],
                },
              },
              weights: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  semantic: { anyOf: [{ type: 'number' }, { const: false }] },
                  bm25: { anyOf: [{ type: 'number' }, { const: false }] },
                  graph: { anyOf: [{ type: 'number' }, { const: false }] },
                  recency: { anyOf: [{ type: 'number' }, { const: false }] },
                },
              },
              fusion: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  method: { type: 'string', enum: ['rrf'] },
                  k: { type: 'number' },
                },
              },
              entityScope: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  entityIds: { type: 'array', items: { type: 'string' } },
                  externalIds: { type: 'array', items: externalIdSchema },
                  mode: { type: 'string', enum: ['filter', 'boost'] },
                },
              },
              promptBuilder: {
                anyOf: [
                  { type: 'boolean' },
                  {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      format: { type: 'string', enum: ['xml', 'markdown', 'plain'] },
                      sections: {
                        type: 'array',
                        items: { type: 'string', enum: ['facts', 'entities', 'chunks', 'memories'] },
                      },
                      maxTotalTokens: { type: 'number' },
                    },
                  },
                ],
              },
              includeInvalidated: { type: 'boolean' },
              explain: { type: 'boolean' },
            },
          },
        },
        required: ['text'],
      }),
      execute: async (input) => {
        return typegraph.search(input.text, scopedQueryOptions(input.options, opts))
      },
    },

    typegraph_remember: memoryRememberTool(typegraph, opts),
    typegraph_correct: memoryCorrectTool(typegraph, opts),

    typegraph_jobs_list: {
      description: 'List TypeGraph jobs in the configured context.',
      inputSchema: schema<JobsListInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          filter: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bucketId: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'processing', 'complete', 'failed'] },
              type: { type: 'string', enum: ['ingest', 'remember', 'thread_turn', 'correct', 'forget'] },
            },
          },
        },
      }),
      execute: async (input) => {
        return typegraph.job.list((input.filter ?? {}) as JobFilter)
      },
    },

    typegraph_jobs_get: {
      description: 'Get one TypeGraph job by ID.',
      inputSchema: schema<JobsGetInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string' },
        },
        required: ['jobId'],
      }),
      execute: async (input) => {
        const job = await typegraph.job.get(input.jobId)
        assertMatchesContext(job as unknown as JsonObject | undefined, opts.context, 'Job')
        return job
      },
    },
  }
}
