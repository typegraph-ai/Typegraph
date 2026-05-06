import { jsonSchema, type Tool } from 'ai'
import type {
  BucketListFilter,
  CorrectOpts,
  CreateBucketInput,
  IngestOptions,
  JobFilter,
  PaginationOpts,
  QueryOpts,
  RememberOpts,
  SourceInput,
  typegraphIdentity,
  typegraphInstance,
} from '@typegraph-ai/sdk'

export type TypegraphToolName =
  | 'typegraph_buckets_list'
  | 'typegraph_buckets_get'
  | 'typegraph_buckets_create'
  | 'typegraph_source_ingest'
  | 'typegraph_query'
  | 'typegraph_memory_remember'
  | 'typegraph_memory_correct'
  | 'typegraph_jobs_list'
  | 'typegraph_jobs_get'

export type TypegraphToolDefinition = Tool<any, unknown>
/** @deprecated Use TypegraphToolDefinition instead. */
export type ToolDefinition = TypegraphToolDefinition

export type TypegraphToolsTarget = Pick<
  typegraphInstance,
  'buckets' | 'ingest' | 'query' | 'remember' | 'correct' | 'jobs'
>

export interface TypegraphMemoryToolsTarget {
  remember: (content: string, opts?: any) => Promise<unknown>
  correct: (correction: string, opts?: any) => Promise<unknown>
}

export interface TypegraphToolsOptions {
  /**
   * Trusted request identity supplied by your server. This is merged into every
   * scoped TypeGraph call so the model cannot select another tenant/user scope.
   */
  identity?: typegraphIdentity | undefined
}

type JsonObject = Record<string, unknown>

interface BucketsListInput {
  filter?: BucketListFilter
  pagination?: PaginationOpts
}

interface BucketsGetInput {
  bucketId: string
}

interface BucketsCreateInput extends Omit<CreateBucketInput, keyof typegraphIdentity> {}

interface SourceIngestInput {
  source?: SourceInput
  sources?: SourceInput[]
  options?: Omit<IngestOptions, keyof typegraphIdentity>
}

interface QueryInput {
  text: string
  options?: Omit<QueryOpts, keyof typegraphIdentity>
}

interface MemoryRememberInput extends Omit<RememberOpts, keyof typegraphIdentity> {
  content: string
}

interface MemoryCorrectInput extends Omit<CorrectOpts, keyof typegraphIdentity> {
  correction: string
}

interface JobsListInput {
  filter?: Omit<JobFilter, 'identity'> & { identity?: never }
}

interface JobsGetInput {
  jobId: string
}

const IDENTITY_KEYS = [
  'tenantId',
  'groupId',
  'userId',
  'agentId',
  'conversationId',
  'agentName',
  'agentDescription',
  'agentVersion',
] as const

function compactObject<T extends JsonObject>(value: T): Partial<T> {
  const out: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) out[key] = item
  }
  return out as Partial<T>
}

function compactIdentity(identity?: typegraphIdentity): typegraphIdentity {
  if (!identity) return {}
  const out: typegraphIdentity = {}
  for (const key of IDENTITY_KEYS) {
    const value = identity[key]
    if (value !== undefined && value !== null) {
      out[key] = value
    }
  }
  return out
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0
}

function scoped<T extends JsonObject>(value: T | undefined, opts: TypegraphToolsOptions): T & typegraphIdentity {
  return {
    ...(value ?? {}),
    ...compactIdentity(opts.identity),
  } as T & typegraphIdentity
}

function scopedQueryOptions(value: QueryInput['options'] | undefined, opts: TypegraphToolsOptions): QueryOpts {
  const identity = compactIdentity(opts.identity)
  const sourceFilter = value?.sourceFilter && typeof value.sourceFilter === 'object'
    ? scoped(value.sourceFilter as JsonObject, opts)
    : value?.sourceFilter

  return compactObject({
    ...(value ?? {}),
    ...identity,
    ...(sourceFilter ? { sourceFilter } : {}),
  }) as QueryOpts
}

function normalizeSource(source: SourceInput): SourceInput {
  return compactObject({
    ...source,
    updatedAt: coerceDate(source.updatedAt),
    createdAt: coerceDate(source.createdAt),
  }) as SourceInput
}

function coerceDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') return new Date(value)
  return undefined
}

function assertMatchesIdentity(
  record: JsonObject | undefined | null,
  identity: typegraphIdentity | undefined,
  label: string,
): void {
  if (!record || !identity) return
  for (const key of IDENTITY_KEYS) {
    const expected = identity[key]
    if (expected === undefined) continue
    const actual = record[key] ?? (record['identity'] as JsonObject | undefined)?.[key]
    if (actual !== undefined && actual !== expected) {
      throw new Error(`${label} is outside the configured TypeGraph identity scope.`)
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
    properties: { type: 'object', additionalProperties: true },
  },
}

const visibilitySchema = { type: 'string', enum: ['tenant', 'group', 'user', 'agent', 'conversation'] }

const sourceSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    content: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    createdAt: { type: 'string', description: 'ISO timestamp.' },
    updatedAt: { type: 'string', description: 'ISO timestamp.' },
    mimeType: { type: 'string' },
    language: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
    subject: subjectSchema,
  },
  required: ['content', 'title'],
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
    visibility: visibilitySchema,
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
        visibility: visibilitySchema,
      },
      required: ['content'],
    }),
    execute: async (input) => {
      const { content, ...rest } = input
      return target.remember(content, scoped(rest as JsonObject, opts) as RememberOpts)
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
      return target.correct(correction, scoped(rest as JsonObject, opts) as CorrectOpts)
    },
  }
}

export function typegraphMemoryTools(
  memory: TypegraphMemoryToolsTarget,
  opts: TypegraphToolsOptions = {},
): Pick<Record<TypegraphToolName, TypegraphToolDefinition>, 'typegraph_memory_remember' | 'typegraph_memory_correct'> {
  return {
    typegraph_memory_remember: memoryRememberTool(memory, opts),
    typegraph_memory_correct: memoryCorrectTool(memory, opts),
  }
}

export function typegraphTools(
  typegraph: TypegraphToolsTarget,
  opts: TypegraphToolsOptions = {},
): Record<TypegraphToolName, TypegraphToolDefinition> {
  return {
    typegraph_buckets_list: {
      description: 'List TypeGraph buckets in the configured identity scope.',
      inputSchema: schema<BucketsListInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          filter: {
            type: 'object',
            additionalProperties: false,
            properties: {},
            description: 'Optional non-identity bucket filters. Identity is supplied by the server.',
          },
          pagination: paginationSchema,
        },
      }),
      execute: async (input) => {
        return typegraph.buckets.list(scoped((input.filter ?? {}) as JsonObject, opts), input.pagination)
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
        const bucket = await typegraph.buckets.get(input.bucketId)
        assertMatchesIdentity(bucket as JsonObject | undefined, opts.identity, 'Bucket')
        return bucket
      },
    },

    typegraph_buckets_create: {
      description: 'Create a TypeGraph bucket in the configured identity scope.',
      inputSchema: schema<BucketsCreateInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          embeddingModel: { type: 'string' },
          queryEmbeddingModel: { type: 'string' },
          indexDefaults: indexDefaultsSchema,
        },
        required: ['name'],
      }),
      execute: async (input) => {
        return typegraph.buckets.create(scoped(input as unknown as JsonObject, opts) as unknown as CreateBucketInput)
      },
    },

    typegraph_source_ingest: {
      description: 'Ingest one or more sources into TypeGraph in the configured identity scope.',
      inputSchema: schema<SourceIngestInput>({
        type: 'object',
        additionalProperties: false,
        properties: {
          source: sourceSchema,
          sources: { type: 'array', items: sourceSchema },
          options: {
            type: 'object',
            additionalProperties: true,
            properties: {
              bucketId: { type: 'string' },
              mode: { type: 'string', enum: ['upsert', 'replace'] },
              chunkSize: { type: 'number' },
              chunkOverlap: { type: 'number' },
              visibility: visibilitySchema,
              stripMarkdownForEmbedding: { type: 'boolean' },
              graphExtraction: { type: 'boolean' },
              dryRun: { type: 'boolean' },
              concurrency: { type: 'number' },
              traceId: { type: 'string' },
              spanId: { type: 'string' },
            },
          },
        },
      }),
      execute: async (input) => {
        const sources = [
          ...(input.source ? [input.source] : []),
          ...(input.sources ?? []),
        ].map(normalizeSource)

        if (sources.length === 0) {
          throw new Error('typegraph_source_ingest requires source or sources.')
        }

        return typegraph.ingest(sources, scoped((input.options ?? {}) as JsonObject, opts) as IngestOptions)
      },
    },

    typegraph_query: {
      description: 'Query TypeGraph retrieval results in the configured identity scope.',
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
              count: { type: 'number' },
              signals: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  semantic: { type: 'boolean' },
                  keyword: { type: 'boolean' },
                  graph: { type: 'boolean' },
                  memory: { type: 'boolean' },
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
              context: {
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
              traceId: { type: 'string' },
              spanId: { type: 'string' },
            },
          },
        },
        required: ['text'],
      }),
      execute: async (input) => {
        return typegraph.query(input.text, scopedQueryOptions(input.options, opts))
      },
    },

    typegraph_memory_remember: memoryRememberTool(typegraph, opts),
    typegraph_memory_correct: memoryCorrectTool(typegraph, opts),

    typegraph_jobs_list: {
      description: 'List TypeGraph jobs in the configured identity scope.',
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
              type: { type: 'string', enum: ['ingest', 'remember', 'conversation_turn', 'correct', 'forget'] },
            },
          },
        },
      }),
      execute: async (input) => {
        const identity = compactIdentity(opts.identity)
        return typegraph.jobs.list({
          ...(input.filter ?? {}),
          ...(hasKeys(identity) ? { identity } : {}),
        } as JobFilter)
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
        const job = await typegraph.jobs.get(input.jobId)
        assertMatchesIdentity(job as unknown as JsonObject | undefined, opts.identity, 'Job')
        return job
      },
    },
  }
}
