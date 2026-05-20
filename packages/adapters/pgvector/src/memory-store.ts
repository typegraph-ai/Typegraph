/**
 * PostgreSQL + pgvector implementation of MemoryStoreAdapter.
 * Provides persistent storage for memories, semantic entities, and edges.
 *
 * Uses the same SqlExecutor pattern as @typegraph-ai/adapter-pgvector for
 * driver-agnostic Postgres access (Neon, node-postgres, Drizzle, etc.).
 */

import type {
  MemoryStoreAdapter,
  MemoryArtifact,
  MemoryArtifactFilter,
  MemoryArtifactKind,
  MemoryArtifactUpsertInput,
  MemoryFilter,
  MemorySearchOpts,
  MemoryRecord,
  ExternalId,
  ChunkBackfillRecord,
  ChunkMentionBackfillRow,
  SemanticEntity,
  SemanticEntityMention,
  SemanticEdge,
  SemanticGraphEdge,
  SemanticEntityChunkEdge,
  SemanticChunkRecord,
  SemanticFactRecord,
  ChunkRef,
  MergeGraphEntitiesInput,
  MergeGraphEntitiesResult,
  DeleteGraphEntityOpts,
  DeleteGraphEntityResult,
  GraphFactLookupOptions,
  GraphFactTripleLookup,
  GraphInvalidationOptions,
  GraphTemporalQueryOptions,
} from '@typegraph-ai/sdk'
import { generateId } from '@typegraph-ai/sdk'
import type { TypeGraphStorageIdentity } from './identity.js'

type SqlExecutor = (
  query: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>

function isDuplicateFactIdError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const constraint = (err as { constraint?: string })?.constraint
  const message = err instanceof Error ? err.message : String(err)
  return code === '23505' && (
    constraint?.endsWith('_pkey') === true ||
    /Key \(id\)=/i.test(message)
  )
}

export interface PgMemoryAdapterConfig {
  sql: SqlExecutor
  /** Postgres schema name. Defaults to 'public'. */
  schema?: string | undefined
  memoriesTable?: string | undefined
  entitiesTable?: string | undefined
  edgesTable?: string | undefined
  entityExternalIdsTable?: string | undefined
  chunkMentionsTable?: string | undefined
  factRecordsTable?: string | undefined
  artifactsTable?: string | undefined
  /** Embedding vector dimensions (e.g. 1536 for text-embedding-3-small). Used for HNSW index creation. */
  embeddingDimensions?: number | undefined
}

// ── DDL ──

// Index prefix: replace dots with underscores so schema-qualified table names
// produce valid Postgres index names (e.g. "myschema.typegraph_memories" → "myschema_typegraph_memories").
const idxPrefix = (t: string) => t.replace(/"/g, '').replace(/\./g, '_')

// Postgres limits identifiers to 63 chars. Truncate + hash when needed.
const PG_IDENT_MAX = 63
function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h >>> 0
}
function safeIdx(tablePrefix: string, suffix: string): string {
  const full = `${tablePrefix}_${suffix}`
  if (full.length <= PG_IDENT_MAX) return full
  const hash = djb2(full).toString(36).padStart(6, '0').slice(0, 6)
  const available = PG_IDENT_MAX - suffix.length - 1 - 6 - 1
  return `${tablePrefix.slice(0, available)}_${hash}_${suffix}`
}

const MEMORY_ROW_COLUMNS = [
  'id', 'category', 'status', 'content', 'importance', 'access_count',
  'last_accessed_at', 'metadata', 'tenant_id', 'organization_id', 'group_id', 'user_id',
  'agent_id', 'thread_id', 'graph_id', 'event_type', 'participants',
  'episodic_thread_id', 'sequence', 'consolidated_at', 'subject',
  'predicate', 'object', 'confidence', 'source_memory_ids', 'trigger', 'steps',
  'success_count', 'failure_count', 'last_outcome', 'valid_at', 'invalid_at',
  'expired_at', 'created_at', 'updated_at',
]

const ENTITY_ROW_COLUMNS = [
  'id', 'name', 'entity_type', 'aliases', 'properties', 'status',
  'merged_into_entity_id', 'deleted_at', 'description_embedding', 'tenant_id',
  'organization_id', 'group_id', 'user_id', 'agent_id', 'thread_id', 'graph_id',
  'valid_at', 'invalid_at', 'created_at', 'updated_at',
]

const EDGE_ROW_COLUMNS = [
  'id', 'source_type', 'source_id', 'target_type', 'target_id', 'relation',
  'weight', 'properties', 'from_bucket_id', 'from_document_id',
  'from_chunk_index', 'from_embedding_model', 'from_chunk_id', 'to_bucket_id',
  'to_document_id', 'to_chunk_index', 'to_embedding_model', 'to_chunk_id',
  'tenant_id', 'organization_id', 'group_id', 'user_id', 'agent_id', 'thread_id',
  'graph_id', 'evidence', 'valid_at', 'invalid_at', 'expired_at',
  'supersession_key', 'superseded_by_id', 'superseded_at', 'created_at', 'updated_at',
]

const FACT_ROW_COLUMNS = [
  'id', 'edge_id', 'source_entity_id', 'target_entity_id', 'relation',
  'fact_text', 'description', 'evidence_text', 'fact_search_text',
  'from_chunk_id', 'weight', 'evidence_count', 'tenant_id', 'organization_id', 'group_id',
  'user_id', 'agent_id', 'thread_id', 'graph_id', 'valid_at', 'invalid_at',
  'expired_at', 'supersession_key', 'superseded_by_id', 'superseded_at',
  'created_at', 'updated_at',
]

const ARTIFACT_ROW_COLUMNS = [
  'tenant_id', 'graph_id', 'layout_id', 'path', 'kind', 'content',
  'metadata', 'content_hash', 'created_at', 'updated_at',
]

function selectColumns(columns: string[], alias?: string): string {
  return columns.map(column => alias ? `${alias}.${column}` : column).join(', ')
}

const MEMORIES_DDL = (t: string, dims?: number) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT NOT NULL,
    category         TEXT NOT NULL CHECK (category IN ('episodic', 'semantic', 'procedural')),
    status           TEXT NOT NULL DEFAULT 'pending',
    content          TEXT NOT NULL,
    embedding        HALFVEC${dims ? `(${dims})` : ''},
    importance       REAL NOT NULL DEFAULT 0.5,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata         JSONB NOT NULL DEFAULT '{}',
    -- Identity columns
    tenant_id        TEXT NOT NULL,
    organization_id  TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    thread_id        TEXT,
    graph_id         TEXT NOT NULL DEFAULT 'public',
    -- Episodic
    event_type       TEXT,
    participants     TEXT[],
    episodic_thread_id TEXT,
    sequence         INTEGER,
    consolidated_at  TIMESTAMPTZ,
    -- Semantic (fact triples)
    subject          TEXT,
    predicate        TEXT,
    object           TEXT,
    confidence       REAL,
    source_memory_ids TEXT[] DEFAULT '{}',
    -- Procedural
    trigger          TEXT,
    steps            TEXT[],
    success_count    INTEGER DEFAULT 0,
    failure_count    INTEGER DEFAULT 0,
    last_outcome     TEXT,
    -- Temporal
    valid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at       TIMESTAMPTZ,
    expired_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Full-text search for BM25/keyword search against memories
    search_vector    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    PRIMARY KEY (tenant_id, graph_id, id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('category_idx')} ON ${t} (category);
  CREATE INDEX IF NOT EXISTS ${idx('status_idx')} ON ${t} (status);
  CREATE INDEX IF NOT EXISTS ${idx('subject_idx')} ON ${t} (subject);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_org_idx')} ON ${t} (tenant_id, organization_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_thread_idx')} ON ${t} (tenant_id, thread_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('thread_idx')} ON ${t} (thread_id);
  CREATE INDEX IF NOT EXISTS ${idx('search_vector_idx')} ON ${t} USING gin (search_vector);
`
}

const ENTITIES_DDL = (t: string, dims?: number) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    aliases     TEXT[] DEFAULT '{}',
    properties  JSONB NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'invalidated')),
    merged_into_entity_id TEXT,
    deleted_at  TIMESTAMPTZ,
    embedding   HALFVEC${dims ? `(${dims})` : ''},
    description_embedding HALFVEC${dims ? `(${dims})` : ''},
    -- Identity columns
    tenant_id   TEXT NOT NULL,
    organization_id TEXT,
    group_id    TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    thread_id  TEXT,
    graph_id    TEXT NOT NULL DEFAULT 'public',
    valid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, graph_id, id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('name_idx')} ON ${t} (name);
  CREATE INDEX IF NOT EXISTS ${idx('type_idx')} ON ${t} (entity_type);
  CREATE INDEX IF NOT EXISTS ${idx('status_idx')} ON ${t} (status);
  CREATE INDEX IF NOT EXISTS ${idx('merged_into_idx')} ON ${t} (merged_into_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_org_idx')} ON ${t} (tenant_id, organization_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_thread_idx')} ON ${t} (tenant_id, thread_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('thread_idx')} ON ${t} (thread_id);
`
}

const ENTITY_EXTERNAL_IDS_DDL = (t: string, entitiesTable: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT NOT NULL,
    entity_id        TEXT NOT NULL,
    type             TEXT NOT NULL,
    id_value         TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    encoding         TEXT NOT NULL DEFAULT 'none' CHECK (encoding IN ('none', 'sha256')),
    metadata         JSONB NOT NULL DEFAULT '{}',
    tenant_id        TEXT NOT NULL,
    graph_id         TEXT NOT NULL DEFAULT 'public',
    organization_id  TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    thread_id  TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, graph_id, id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('entity_idx')} ON ${t} (tenant_id, graph_id, entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('lookup_idx')} ON ${t} (type, normalized_value, encoding);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_org_idx')} ON ${t} (tenant_id, organization_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_thread_idx')} ON ${t} (tenant_id, thread_id);
  CREATE UNIQUE INDEX IF NOT EXISTS ${idx('scoped_external_id_uniq_idx')}
    ON ${t} (
      type,
      normalized_value,
      encoding,
      COALESCE(tenant_id, ''),
      COALESCE(graph_id, ''),
      COALESCE(organization_id, ''),
      COALESCE(group_id, ''),
      COALESCE(user_id, ''),
      COALESCE(agent_id, ''),
      COALESCE(thread_id, '')
    );
`
}

const EDGES_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT NOT NULL,
    source_type      TEXT NOT NULL CHECK (source_type IN ('entity', 'chunk', 'memory')),
    source_id        TEXT NOT NULL,
    target_type      TEXT NOT NULL CHECK (target_type IN ('entity', 'chunk', 'memory')),
    target_id        TEXT NOT NULL,
    relation         TEXT NOT NULL,
    weight           REAL NOT NULL DEFAULT 1.0,
    properties       JSONB NOT NULL DEFAULT '{}',
    from_bucket_id       TEXT,
    from_document_id   TEXT,
    from_chunk_index     INTEGER,
    from_embedding_model TEXT,
    from_chunk_id        TEXT,
    to_bucket_id       TEXT,
    to_document_id     TEXT,
    to_chunk_index     INTEGER,
    to_embedding_model TEXT,
    to_chunk_id        TEXT,
    -- Identity columns
    tenant_id        TEXT NOT NULL,
    organization_id  TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    thread_id        TEXT,
    graph_id         TEXT NOT NULL DEFAULT 'public',
    evidence         TEXT[] DEFAULT '{}',
    valid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at       TIMESTAMPTZ,
    expired_at       TIMESTAMPTZ,
    supersession_key TEXT,
    superseded_by_id TEXT,
    superseded_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, graph_id, id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('source_idx')} ON ${t} (source_type, source_id);
  CREATE INDEX IF NOT EXISTS ${idx('target_idx')} ON ${t} (target_type, target_id);
  CREATE INDEX IF NOT EXISTS ${idx('entity_source_idx')} ON ${t} (source_id) WHERE source_type = 'entity';
  CREATE INDEX IF NOT EXISTS ${idx('entity_target_idx')} ON ${t} (target_id) WHERE target_type = 'entity';
  CREATE INDEX IF NOT EXISTS ${idx('memory_source_idx')} ON ${t} (source_id) WHERE source_type = 'memory';
  CREATE INDEX IF NOT EXISTS ${idx('memory_target_idx')} ON ${t} (target_id) WHERE target_type = 'memory';
  CREATE INDEX IF NOT EXISTS ${idx('to_chunk_ref_idx')} ON ${t} (tenant_id, graph_id, to_bucket_id, to_document_id, to_chunk_index) WHERE target_type = 'chunk';
  CREATE INDEX IF NOT EXISTS ${idx('from_chunk_ref_idx')} ON ${t} (tenant_id, graph_id, from_bucket_id, from_document_id, from_chunk_index) WHERE source_type = 'chunk';
  CREATE INDEX IF NOT EXISTS ${idx('relation_idx')} ON ${t} (relation);
  CREATE INDEX IF NOT EXISTS ${idx('valid_at_idx')} ON ${t} (valid_at);
  CREATE INDEX IF NOT EXISTS ${idx('invalid_at_idx')} ON ${t} (invalid_at);
  CREATE INDEX IF NOT EXISTS ${idx('expired_at_idx')} ON ${t} (expired_at);
  CREATE INDEX IF NOT EXISTS ${idx('supersession_idx')} ON ${t} (tenant_id, graph_id, supersession_key, valid_at) WHERE supersession_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ${idx('tenant_org_idx')} ON ${t} (tenant_id, organization_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_thread_idx')} ON ${t} (tenant_id, thread_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('thread_idx')} ON ${t} (thread_id);
`
}

const CHUNK_MENTIONS_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id              TEXT NOT NULL,
    tenant_id       TEXT NOT NULL,
    graph_id        TEXT NOT NULL DEFAULT 'public',
    organization_id TEXT,
    entity_id       TEXT NOT NULL,
    document_id     TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    bucket_id       TEXT NOT NULL,
    mention_type    TEXT NOT NULL
                    CHECK (mention_type IN ('subject', 'object', 'co_occurrence', 'entity', 'alias', 'document_subject')),
    surface_text    TEXT,
    normalized_surface_text TEXT NOT NULL DEFAULT '',
    confidence      REAL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, graph_id, id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('entity_idx')} ON ${t} (tenant_id, graph_id, entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('chunk_idx')} ON ${t} (tenant_id, graph_id, document_id, chunk_index);
  CREATE INDEX IF NOT EXISTS ${idx('bucket_entity_idx')} ON ${t} (tenant_id, graph_id, bucket_id, entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('surface_idx')} ON ${t} (normalized_surface_text);
  CREATE UNIQUE INDEX IF NOT EXISTS ${idx('mention_uniq_idx')}
    ON ${t} (tenant_id, graph_id, entity_id, document_id, chunk_index, mention_type, normalized_surface_text);
`
}

const FACT_RECORDS_DDL = (t: string, dims?: number) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT NOT NULL,
    edge_id          TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation         TEXT NOT NULL,
    fact_text        TEXT NOT NULL,
    description      TEXT,
    evidence_text    TEXT,
    fact_search_text TEXT NOT NULL,
    from_chunk_id  TEXT,
    weight           REAL NOT NULL DEFAULT 1.0,
    evidence_count   INTEGER NOT NULL DEFAULT 1,
    embedding        HALFVEC${dims ? `(${dims})` : ''},
    tenant_id        TEXT NOT NULL,
    organization_id  TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    thread_id        TEXT,
    graph_id         TEXT NOT NULL DEFAULT 'public',
    valid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at       TIMESTAMPTZ,
    expired_at       TIMESTAMPTZ,
    supersession_key TEXT,
    superseded_by_id TEXT,
    superseded_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', fact_search_text)) STORED,
    PRIMARY KEY (tenant_id, graph_id, id),
    UNIQUE (tenant_id, graph_id, edge_id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('source_idx')} ON ${t} (source_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('target_idx')} ON ${t} (target_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('relation_idx')} ON ${t} (relation);
  CREATE INDEX IF NOT EXISTS ${idx('valid_at_idx')} ON ${t} (valid_at);
  CREATE INDEX IF NOT EXISTS ${idx('invalid_at_idx')} ON ${t} (invalid_at);
  CREATE INDEX IF NOT EXISTS ${idx('expired_at_idx')} ON ${t} (expired_at);
  CREATE INDEX IF NOT EXISTS ${idx('supersession_idx')} ON ${t} (tenant_id, graph_id, supersession_key, valid_at) WHERE supersession_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ${idx('tenant_org_idx')} ON ${t} (tenant_id, organization_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_thread_idx')} ON ${t} (tenant_id, thread_id);
  CREATE INDEX IF NOT EXISTS ${idx('embedding_idx')} ON ${t} USING hnsw (embedding halfvec_cosine_ops);
  CREATE INDEX IF NOT EXISTS ${idx('search_vector_idx')} ON ${t} USING gin (search_vector);
`
}

const ARTIFACTS_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    tenant_id     TEXT NOT NULL,
    graph_id      TEXT NOT NULL DEFAULT 'public',
    layout_id     TEXT NOT NULL,
    path          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('summary', 'handbook', 'raw_memory', 'raw_memories', 'rollout_summary', 'phase_two_selection', 'skill', 'other')),
    content       TEXT NOT NULL,
    metadata      JSONB NOT NULL DEFAULT '{}',
    content_hash  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    PRIMARY KEY (tenant_id, graph_id, layout_id, path)
  );

  CREATE INDEX IF NOT EXISTS ${idx('layout_kind_idx')} ON ${t} (tenant_id, graph_id, layout_id, kind);
  CREATE INDEX IF NOT EXISTS ${idx('layout_updated_idx')} ON ${t} (tenant_id, graph_id, layout_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS ${idx('path_pattern_idx')} ON ${t} (path text_pattern_ops);
  CREATE INDEX IF NOT EXISTS ${idx('search_vector_idx')} ON ${t} USING gin (search_vector);
`
}

// ── Adapter Implementation ──

/** Strip schema prefix from a qualified table name for use in ON CONFLICT column refs. */
const unqualified = (table: string) => table.includes('.') ? table.split('.').pop()! : table

export class PgMemoryStoreAdapter implements MemoryStoreAdapter {
  private sql: SqlExecutor
  private memoriesTable: string
  private entitiesTable: string
  private entityExternalIdsTable: string
  private edgesTable: string
  private chunkMentionsTable: string
  private factRecordsTable: string
  private artifactsTable: string
  private schema: string | undefined
  private hnswEntityIndexCreated = false
  private hnswMemoryIndexCreated = false
  private readonly embeddingDimensions: number

  constructor(config: PgMemoryAdapterConfig) {
    this.sql = config.sql
    this.schema = config.schema
    const prefix = config.schema ? `"${config.schema}".` : ''
    this.memoriesTable = config.memoriesTable ?? `${prefix}typegraph_memories`
    this.entitiesTable = config.entitiesTable ?? `${prefix}typegraph_semantic_entities`
    this.entityExternalIdsTable = config.entityExternalIdsTable ?? `${prefix}typegraph_entity_external_ids`
    this.edgesTable = config.edgesTable ?? `${prefix}typegraph_graph_edges`
    this.chunkMentionsTable = config.chunkMentionsTable ?? `${prefix}typegraph_entity_chunk_mentions`
    this.factRecordsTable = config.factRecordsTable ?? `${prefix}typegraph_fact_records`
    this.artifactsTable = config.artifactsTable ?? `${prefix}typegraph_memory_artifacts`
    this.embeddingDimensions = config.embeddingDimensions ?? 1536
  }

  async initialize(): Promise<void> {
    // Create schema if specified
    if (this.schema) {
      await this.sql(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`)
    }

    // Neon cannot execute multi-statement prepared statements,
    // so split each DDL block on semicolons and execute individually.
    const allDdl = [
      MEMORIES_DDL(this.memoriesTable, this.embeddingDimensions),

      ENTITIES_DDL(this.entitiesTable, this.embeddingDimensions),
      ENTITY_EXTERNAL_IDS_DDL(this.entityExternalIdsTable, this.entitiesTable),
      EDGES_DDL(this.edgesTable),
      CHUNK_MENTIONS_DDL(this.chunkMentionsTable),
      FACT_RECORDS_DDL(this.factRecordsTable, this.embeddingDimensions),
      ARTIFACTS_DDL(this.artifactsTable),
    ]
    for (const ddl of allDdl) {
      const statements = ddl
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      for (const stmt of statements) {
        await this.sql(stmt)
      }
    }
    // Try to create HNSW indexes on entity and memory embeddings.
    // May fail if tables are empty (no embedding dimensions known yet).
    // In that case, created lazily after first entity/memory with embedding is inserted.
    await this.ensureHnswIndex('entity')
    await this.ensureHnswIndex('memory')
  }

  private async sqlWithRetry(
    query: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> {
    return this.sql(query, params)
  }

  private async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.sql('BEGIN')
    try {
      const result = await fn()
      await this.sql('COMMIT')
      return result
    } catch (err) {
      await this.sql('ROLLBACK')
      throw err
    }
  }

  private async ensureHnswIndex(target: 'entity' | 'memory'): Promise<void> {
    const table = target === 'entity' ? this.entitiesTable : this.memoriesTable
    const created = target === 'entity' ? this.hnswEntityIndexCreated : this.hnswMemoryIndexCreated
    if (created) return
    const idxName = safeIdx(idxPrefix(table), 'embedding_idx')
    try {
      await this.sql(
        `CREATE INDEX IF NOT EXISTS ${idxName}
         ON ${table} USING hnsw (embedding halfvec_cosine_ops)
         WITH (m = 16, ef_construction = 200)`
      )
      if (target === 'entity') this.hnswEntityIndexCreated = true
      else this.hnswMemoryIndexCreated = true
    } catch (err: unknown) {
      console.warn(`[typegraph] HNSW index creation on ${table} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── CRUD ──

  async upsert(record: MemoryRecord): Promise<MemoryRecord> {
    const embeddingStr = record.embedding ? `[${record.embedding.join(',')}]` : null
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.memoriesTable}
        (id, category, status, content, embedding, importance, access_count,
         last_accessed_at, metadata,
         tenant_id, organization_id, group_id, user_id, agent_id, thread_id, graph_id,
         event_type, participants, episodic_thread_id, sequence, consolidated_at,
         subject, predicate, object, confidence, source_memory_ids,
         trigger, steps, success_count, failure_count, last_outcome,
         valid_at, invalid_at, expired_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::halfvec,$6,$7,$8,$9,
               $10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
               $27,$28,$29,$30,$31,$32,$33,$34,NOW())
       ON CONFLICT (tenant_id, graph_id, id) DO UPDATE SET
         status = EXCLUDED.status, content = EXCLUDED.content,
         embedding = EXCLUDED.embedding, importance = EXCLUDED.importance,
         access_count = EXCLUDED.access_count, last_accessed_at = EXCLUDED.last_accessed_at,
         metadata = EXCLUDED.metadata,
         organization_id = EXCLUDED.organization_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         event_type = EXCLUDED.event_type, participants = EXCLUDED.participants,
         episodic_thread_id = EXCLUDED.episodic_thread_id, sequence = EXCLUDED.sequence,
         consolidated_at = EXCLUDED.consolidated_at,
         subject = EXCLUDED.subject, predicate = EXCLUDED.predicate,
         object = EXCLUDED.object, confidence = EXCLUDED.confidence,
         source_memory_ids = EXCLUDED.source_memory_ids,
         trigger = EXCLUDED.trigger, steps = EXCLUDED.steps,
         success_count = EXCLUDED.success_count, failure_count = EXCLUDED.failure_count,
         last_outcome = EXCLUDED.last_outcome,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at, updated_at = NOW()
       RETURNING ${selectColumns(MEMORY_ROW_COLUMNS)}`,
      [
        record.id, record.category, record.status, record.content,
        embeddingStr, record.importance, record.accessCount,
        record.lastAccessedAt.toISOString(),
        JSON.stringify(record.metadata),
        // Identity
        record.scope.tenantId ?? 'public',
        record.scope.organizationId ?? null,
        record.scope.groupId ?? null,
        record.scope.userId ?? null,
        record.scope.agentId ?? null,
        record.scope.threadId ?? null,
        record.graphId ?? record.scope.graphId ?? 'public',
        // Episodic
        (record as any).eventType ?? null,
        (record as any).participants ?? null,
        (record as any).threadId ?? null,  // episodic threadId → episodic_thread_id column
        (record as any).sequence ?? null,
        (record as any).consolidatedAt?.toISOString() ?? null,
        // Semantic
        (record as any).subject ?? null,
        (record as any).predicate ?? null,
        (record as any).object ?? null,
        (record as any).confidence ?? null,
        (record as any).sourceMemoryIds ?? null,
        // Procedural
        (record as any).trigger ?? null,
        (record as any).steps ?? null,
        (record as any).successCount ?? null,
        (record as any).failureCount ?? null,
        (record as any).lastOutcome ?? null,
        // Temporal
        record.validAt.toISOString(),
        record.invalidAt?.toISOString() ?? null,
        record.expiredAt?.toISOString() ?? null,
      ]
    )
    return mapRowToMemory(rows[0]!)
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const rows = await this.sqlWithRetry(`SELECT ${selectColumns(MEMORY_ROW_COLUMNS)} FROM ${this.memoriesTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToMemory(rows[0]!) : null
  }

  async list(filter: MemoryFilter, limit?: number): Promise<MemoryRecord[]> {
    const { where, params } = buildMemoryWhere(filter)
    const whereClause = where ? `WHERE ${where}` : ''
    params.push(limit ?? 100)
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(MEMORY_ROW_COLUMNS)} FROM ${this.memoriesTable} ${whereClause}
       ORDER BY last_accessed_at DESC LIMIT $${params.length}`,
      params
    )
    return rows.map(mapRowToMemory)
  }

  async delete(id: string): Promise<void> {
    await this.sqlWithRetry(`DELETE FROM ${this.memoriesTable} WHERE id = $1`, [id])
  }

  // ── Temporal Operations ──

  async invalidate(id: string, invalidAt?: Date): Promise<void> {
    await this.sqlWithRetry(
      `UPDATE ${this.memoriesTable}
       SET status = 'invalidated', invalid_at = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, (invalidAt ?? new Date()).toISOString()]
    )
  }

  async expire(id: string): Promise<void> {
    await this.sqlWithRetry(
      `UPDATE ${this.memoriesTable}
       SET status = 'expired', expired_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    )
  }

  async getHistory(id: string): Promise<MemoryRecord[]> {
    // Return the record itself — in a full bi-temporal system, we's
    // query all versions sharing a lineage ID. For now, return the single record.
    const row = await this.get(id)
    return row ? [row] : []
  }

  // ── Search ──

  async search(embedding: number[], opts: MemorySearchOpts): Promise<MemoryRecord[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const conditions: string[] = ['embedding IS NOT NULL']
    const params: unknown[] = []

    if (!opts.includeExpired) {
      conditions.push(`status NOT IN ('invalidated', 'expired')`)
    }
    if (opts.temporalAt) {
      params.push(opts.temporalAt.toISOString())
      conditions.push(`valid_at <= $${params.length}`)
      conditions.push(`(invalid_at IS NULL OR invalid_at > $${params.length})`)
    }
    if (opts.filter) {
      const { where: filterWhere, params: filterParams } = buildMemoryWhere(opts.filter, params.length)
      if (filterWhere) {
        conditions.push(filterWhere)
        params.push(...filterParams)
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(vectorStr)
    params.push(opts.count)

    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(MEMORY_ROW_COLUMNS)}, 1 - (embedding <=> $${params.length - 1}::halfvec) AS similarity
       FROM ${this.memoriesTable}
       ${whereClause}
       ORDER BY embedding <=> $${params.length - 1}::halfvec
       LIMIT $${params.length}`,
      params
    )
    return rows.map(mapRowToMemory)
  }

  async hybridSearch(embedding: number[], query: string, opts: MemorySearchOpts): Promise<MemoryRecord[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const conditions: string[] = ['embedding IS NOT NULL']
    const params: unknown[] = []

    if (!opts.includeExpired) {
      conditions.push(`status NOT IN ('invalidated', 'expired')`)
    }
    if (opts.temporalAt) {
      params.push(opts.temporalAt.toISOString())
      conditions.push(`valid_at <= $${params.length}`)
      conditions.push(`(invalid_at IS NULL OR invalid_at > $${params.length})`)
    }
    if (opts.filter) {
      const { where: filterWhere, params: filterParams } = buildMemoryWhere(opts.filter, params.length)
      if (filterWhere) {
        conditions.push(filterWhere)
        params.push(...filterParams)
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const vecParamIdx = params.length + 1
    params.push(vectorStr)
    const queryParamIdx = params.length + 1
    params.push(query)
    const limitParamIdx = params.length + 1
    params.push(opts.count)

    // RRF fusion of vector and keyword ranked lists.
    // Vector gets 0.7 weight, keyword gets 0.3 — semantic matching is more reliable
    // for typically short memory content. Keyword rank of 1000 for non-matches
    // ensures they aren't overly penalized.
    const sql = `
      WITH vector_ranked AS (
        SELECT ${selectColumns(MEMORY_ROW_COLUMNS)}, 1 - (embedding <=> $${vecParamIdx}::halfvec) AS similarity,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $${vecParamIdx}::halfvec) AS vrank
        FROM ${this.memoriesTable}
        ${whereClause}
        ORDER BY embedding <=> $${vecParamIdx}::halfvec
        LIMIT $${limitParamIdx} * 3
      ),
      keyword_ranked AS (
        SELECT id, ts_rank_cd(search_vector, websearch_to_tsquery('english', $${queryParamIdx})) AS kw_score,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $${queryParamIdx})) DESC) AS krank
        FROM ${this.memoriesTable}
        ${whereClause}
        AND search_vector @@ websearch_to_tsquery('english', $${queryParamIdx})
        ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $${queryParamIdx})) DESC
        LIMIT $${limitParamIdx} * 3
      )
      SELECT ${selectColumns(MEMORY_ROW_COLUMNS, 'v')},
             v.similarity,
             k.kw_score AS keyword_score,
             (0.7 / (60 + v.vrank) + 0.3 / (60 + COALESCE(k.krank, 1000)))::double precision AS rrf_score
      FROM vector_ranked v
      LEFT JOIN keyword_ranked k ON v.id = k.id
      ORDER BY (0.7 / (60 + v.vrank) + 0.3 / (60 + COALESCE(k.krank, 1000))) DESC
      LIMIT $${limitParamIdx}
    `

    const rows = await this.sqlWithRetry(sql, params)
    return rows.map(row => {
      const mem = mapRowToMemory(row)
      // Stash keyword score for memory runner composite scoring
      if (row.keyword_score != null) {
        mem.metadata._keywordScore = row.keyword_score as number
      }
      return mem
    })
  }

  // ── Access Tracking ──

  async recordAccess(id: string): Promise<void> {
    await this.sqlWithRetry(
      `UPDATE ${this.memoriesTable}
       SET access_count = access_count + 1, last_accessed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    )
  }

  // ── Agent-Facing Memory Artifacts ──

  async upsertArtifact(input: MemoryArtifactUpsertInput): Promise<MemoryArtifact> {
    const tenantId = input.identity.tenantId ?? 'public'
    const graphId = input.identity.graphId ?? 'public'
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.artifactsTable}
        (tenant_id, graph_id, layout_id, path, kind, content, metadata, content_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (tenant_id, graph_id, layout_id, path) DO UPDATE SET
         kind = EXCLUDED.kind,
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata,
         content_hash = EXCLUDED.content_hash,
         updated_at = NOW()
       RETURNING ${selectColumns(ARTIFACT_ROW_COLUMNS)}`,
      [
        tenantId,
        graphId,
        input.layoutId,
        input.path,
        input.kind,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        input.contentHash,
      ]
    )
    return mapRowToArtifact(rows[0]!)
  }

  async getArtifact(identity: TypeGraphStorageIdentity, layoutId: string, path: string): Promise<MemoryArtifact | null> {
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ARTIFACT_ROW_COLUMNS)}
         FROM ${this.artifactsTable}
        WHERE tenant_id = $1
          AND graph_id = $2
          AND layout_id = $3
          AND path = $4
        LIMIT 1`,
      [
        identity.tenantId ?? 'public',
        identity.graphId ?? 'public',
        layoutId,
        path,
      ]
    )
    return rows[0] ? mapRowToArtifact(rows[0]) : null
  }

  async listArtifacts(filter: MemoryArtifactFilter): Promise<MemoryArtifact[]> {
    const { where, params } = buildArtifactWhere(filter)
    const whereClause = where ? `WHERE ${where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ARTIFACT_ROW_COLUMNS)}
         FROM ${this.artifactsTable}
         ${whereClause}
        ORDER BY updated_at DESC, path ASC`,
      params
    )
    return rows.map(mapRowToArtifact)
  }

  async deleteArtifact(identity: TypeGraphStorageIdentity, layoutId: string, path: string): Promise<void> {
    await this.sqlWithRetry(
      `DELETE FROM ${this.artifactsTable}
        WHERE tenant_id = $1
          AND graph_id = $2
          AND layout_id = $3
          AND path = $4`,
      [
        identity.tenantId ?? 'public',
        identity.graphId ?? 'public',
        layoutId,
        path,
      ]
    )
  }

  // ── Entity Storage ──

  private async attachExternalIds(entities: SemanticEntity[]): Promise<SemanticEntity[]> {
    if (entities.length === 0) return entities
    const rows = await this.sqlWithRetry(
      `SELECT entity_id, type, id_value, encoding, metadata
         FROM ${this.entityExternalIdsTable}
        WHERE (tenant_id, graph_id, entity_id) IN (
          SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
        )
        ORDER BY created_at ASC`,
      [
        entities.map(entity => entity.scope.tenantId ?? 'public'),
        entities.map(entity => entity.graphId ?? entity.scope.graphId ?? 'public'),
        entities.map(entity => entity.id),
      ]
    )
    const byEntity = new Map<string, ExternalId[]>()
    for (const row of rows) {
      const entityId = row.entity_id as string
      const externalId: ExternalId = {
        type: row.type as string,
        id: row.id_value as string,
        encoding: (row.encoding as ExternalId['encoding']) ?? 'none',
        metadata: parseJson(row.metadata),
      }
      const list = byEntity.get(entityId) ?? []
      list.push(externalId)
      byEntity.set(entityId, list)
    }
    return entities.map(entity => ({
      ...entity,
      externalIds: byEntity.get(entity.id) ?? entity.externalIds,
    }))
  }

  async upsertEntity(entity: SemanticEntity): Promise<SemanticEntity> {
    const embeddingStr = entity.embedding ? `[${entity.embedding.join(',')}]` : null
    const descEmbeddingStr = entity.descriptionEmbedding ? `[${entity.descriptionEmbedding.join(',')}]` : null
    // Strip transient _similarity before persisting to JSONB — it's a per-query
    // score stashed by mapRowToEntity from searchEntities results, not a stored property
    const { _similarity, ...cleanProps } = entity.metadata
    const tbl = unqualified(this.entitiesTable)
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.entitiesTable}
        (id, name, entity_type, aliases, properties, status, merged_into_entity_id, deleted_at, embedding, description_embedding,
         tenant_id, organization_id, group_id, user_id, agent_id, thread_id, graph_id,
         valid_at, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::halfvec,$10::halfvec,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
       ON CONFLICT (tenant_id, graph_id, id) DO UPDATE SET
         name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
         aliases = EXCLUDED.aliases, properties = EXCLUDED.properties,
         status = EXCLUDED.status,
         merged_into_entity_id = EXCLUDED.merged_into_entity_id,
         deleted_at = EXCLUDED.deleted_at,
         embedding = COALESCE(EXCLUDED.embedding, ${tbl}.embedding),
         description_embedding = COALESCE(EXCLUDED.description_embedding, ${tbl}.description_embedding),
         organization_id = EXCLUDED.organization_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at, updated_at = NOW()
       RETURNING ${selectColumns(ENTITY_ROW_COLUMNS)}`,
      [
        entity.id, entity.name, entity.entityType,
        entity.aliases, JSON.stringify(cleanProps),
        entity.status ?? 'active',
        entity.mergedIntoEntityId ?? null,
        entity.deletedAt?.toISOString() ?? null,
        embeddingStr, descEmbeddingStr,
        entity.scope.tenantId ?? 'public',
        entity.scope.organizationId ?? null,
        entity.scope.groupId ?? null,
        entity.scope.userId ?? null,
        entity.scope.agentId ?? null,
        entity.scope.threadId ?? null,
        entity.graphId ?? entity.scope.graphId ?? 'public',
        entity.temporal.validAt.toISOString(),
        entity.temporal.invalidAt?.toISOString() ?? null,
      ]
    )


    // Lazily create HNSW index after first entity with embedding is persisted
    if (embeddingStr && !this.hnswEntityIndexCreated) {
      await this.ensureHnswIndex('entity')
    }

    if (entity.externalIds && entity.externalIds.length > 0) {
      await this.upsertEntityExternalIds(entity.id, entity.externalIds, entity.scope)
    }

    const [mapped] = await this.attachExternalIds([mapRowToEntity(rows[0]!)])
    return mapped!
  }

  async upsertEntityExternalIds(entityId: string, externalIds: ExternalId[], scope: TypeGraphStorageIdentity): Promise<void> {
    if (externalIds.length === 0) return

    const values: string[] = []
    const params: unknown[] = []
    for (const externalId of externalIds) {
      const normalized = normalizeExternalId(externalId)
      if (!normalized) continue
      const base = params.length
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`)
      params.push(
        generateId('xid'),
        entityId,
        normalized.type,
        normalized.id,
        normalized.normalizedValue,
        normalized.encoding,
        JSON.stringify(normalized.metadata ?? {}),
        scope.tenantId ?? 'public',
        scope.graphId ?? 'public',
        scope.organizationId ?? null,
        scope.groupId ?? null,
        scope.userId ?? null,
        scope.agentId ?? null,
        scope.threadId ?? null,
      )
    }
    if (values.length === 0) return

    const tbl = unqualified(this.entityExternalIdsTable)
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.entityExternalIdsTable}
        (id, entity_id, type, id_value, normalized_value, encoding, metadata,
         tenant_id, graph_id, organization_id, group_id, user_id, agent_id, thread_id)
       VALUES ${values.join(',')}
       ON CONFLICT (
         type,
         normalized_value,
         encoding,
         COALESCE(tenant_id, ''),
         COALESCE(graph_id, ''),
         COALESCE(organization_id, ''),
         COALESCE(group_id, ''),
         COALESCE(user_id, ''),
         COALESCE(agent_id, ''),
         COALESCE(thread_id, '')
       ) DO UPDATE SET
         id_value = EXCLUDED.id_value,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       WHERE ${tbl}.tenant_id = EXCLUDED.tenant_id
         AND ${tbl}.graph_id = EXCLUDED.graph_id
         AND ${tbl}.entity_id = EXCLUDED.entity_id
       RETURNING id`,
      params
    )
    if (rows.length !== values.length) {
      throw new Error('One or more external IDs are already linked to a different entity')
    }
  }

  async findEntityByExternalId(externalId: ExternalId, scope?: TypeGraphStorageIdentity): Promise<SemanticEntity | null> {
    const normalized = normalizeExternalId(externalId)
    if (!normalized) return null
    const identity = buildGraphVisibilityWhere(scope, 3, 'e')
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS, 'e')}
         FROM ${this.entityExternalIdsTable} xid
         JOIN ${this.entitiesTable} e
           ON e.tenant_id = xid.tenant_id
          AND e.graph_id = xid.graph_id
          AND e.id = xid.entity_id
        WHERE xid.type = $1
          AND xid.normalized_value = $2
          AND xid.encoding = $3
          ${scopeClause}
          AND e.invalid_at IS NULL
          AND e.status = 'active'
        LIMIT 1`,
      [
        normalized.type,
        normalized.normalizedValue,
        normalized.encoding,
        ...identity.params,
      ]
    )
    if (rows.length === 0) return null
    const [mapped] = await this.attachExternalIds(dedupeEntitiesByGraphPreference(rows.map(mapRowToEntity), scope))
    return mapped!
  }

  async getEntity(id: string, scope?: TypeGraphStorageIdentity): Promise<SemanticEntity | null> {
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS)}
       FROM ${this.entitiesTable}
       WHERE id = $1
         ${scopeClause}`,
      [id, ...identity.params]
    )
    if (rows.length === 0) return null
    const [mapped] = await this.attachExternalIds(dedupeEntitiesByGraphPreference(rows.map(mapRowToEntity), scope))
    return mapped!
  }

  async getEntitiesBatch(ids: string[], scope?: TypeGraphStorageIdentity): Promise<SemanticEntity[]> {
    if (ids.length === 0) return []
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS)}
       FROM ${this.entitiesTable}
       WHERE id = ANY($1::text[])
         ${scopeClause}`,
      [ids, ...identity.params]
    )
    return this.attachExternalIds(dedupeEntitiesByGraphPreference(rows.map(mapRowToEntity), scope))
  }

  async findEntities(query: string, scope: TypeGraphStorageIdentity, limit?: number): Promise<SemanticEntity[]> {
    const { where, params } = buildGraphVisibilityWhere(scope)
    const baseIdx = params.length
    params.push(`%${query}%`)
    const nameParam = `$${baseIdx + 1}`
    params.push(limit ?? 20)
    const limitParam = `$${baseIdx + 2}`
    const scopeClause = where ? ` AND ${where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS)}
       FROM ${this.entitiesTable}
       WHERE (name ILIKE ${nameParam}
              OR EXISTS (SELECT 1 FROM unnest(aliases) AS a WHERE a ILIKE ${nameParam})
              OR EXISTS (
                SELECT 1 FROM ${this.chunkMentionsTable} m
                WHERE m.entity_id = ${this.entitiesTable}.id
                  AND m.tenant_id = ${this.entitiesTable}.tenant_id
                  AND m.graph_id = ${this.entitiesTable}.graph_id
                  AND m.surface_text ILIKE ${nameParam}
              ))
         ${scopeClause}
         AND invalid_at IS NULL
         AND status = 'active'
       LIMIT ${limitParam}`,
      params
    )
    return this.attachExternalIds(dedupeEntitiesByGraphPreference(rows.map(mapRowToEntity), scope))
  }

  async searchEntities(embedding: number[], scope: TypeGraphStorageIdentity, limit?: number): Promise<SemanticEntity[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = where ? ` AND ${where}` : ''
    params.push(limit ?? 20)
    const limitParam = `$${1 + params.length}`
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS)}, 1 - (embedding <=> $1::halfvec) AS similarity
       FROM ${this.entitiesTable}
       WHERE embedding IS NOT NULL
         AND invalid_at IS NULL
          AND status = 'active'
          ${scopeClause}
       ORDER BY embedding <=> $1::halfvec
       LIMIT ${limitParam}`,
      [vectorStr, ...params]
    )
    return this.attachExternalIds(dedupeEntitiesByGraphPreference(rows.map(mapRowToEntity), scope))
  }

  async searchEntitiesHybrid(query: string, embedding: number[], scope: TypeGraphStorageIdentity, limit?: number): Promise<SemanticEntity[]> {
    const normalizedQuery = normalizeEntityText(query)
    const likeQuery = `%${escapeLike(query.trim())}%`
    const lowerQuery = query.trim().toLowerCase()
    const maxRows = limit ?? 20

    const identity = buildGraphVisibilityWhere(scope, 4, 'e')
    const scopeClause = identity.where ? ` AND ${identity.where}` : ''

    const lexicalParams: unknown[] = [lowerQuery, normalizedQuery, likeQuery, maxRows * 4, ...identity.params]
    const lowerParam = '$1'
    const normalizedParam = '$2'
    const likeParam = '$3'
    const lexicalLimitParam = '$4'
    const lexicalRows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS, 'e')},
              GREATEST(
                CASE WHEN lower(e.name) = ${lowerParam} THEN 1.0 ELSE 0 END,
                CASE WHEN EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE lower(a) = ${lowerParam}) THEN 0.98 ELSE 0 END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM ${this.chunkMentionsTable} m
                  WHERE m.entity_id = e.id
                    AND m.tenant_id = e.tenant_id
                    AND m.graph_id = e.graph_id
                    AND m.normalized_surface_text = ${normalizedParam}
                ) THEN 0.97 ELSE 0 END,
                CASE WHEN e.name ILIKE ${likeParam} THEN 0.88 ELSE 0 END,
                CASE WHEN EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE a ILIKE ${likeParam}) THEN 0.86 ELSE 0 END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM ${this.chunkMentionsTable} m
                  WHERE m.entity_id = e.id
                    AND m.tenant_id = e.tenant_id
                    AND m.graph_id = e.graph_id
                    AND m.surface_text ILIKE ${likeParam}
                ) THEN 0.84 ELSE 0 END
              ) AS similarity
        FROM ${this.entitiesTable} e
        WHERE e.invalid_at IS NULL
          AND e.status = 'active'
          ${scopeClause}
          AND (
            lower(e.name) = ${lowerParam}
            OR EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE lower(a) = ${lowerParam})
            OR EXISTS (SELECT 1 FROM ${this.chunkMentionsTable} m WHERE m.entity_id = e.id AND m.tenant_id = e.tenant_id AND m.graph_id = e.graph_id AND m.normalized_surface_text = ${normalizedParam})
            OR e.name ILIKE ${likeParam}
            OR EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE a ILIKE ${likeParam})
            OR EXISTS (SELECT 1 FROM ${this.chunkMentionsTable} m WHERE m.entity_id = e.id AND m.tenant_id = e.tenant_id AND m.graph_id = e.graph_id AND m.surface_text ILIKE ${likeParam})
          )
        ORDER BY similarity DESC, e.name ASC
        LIMIT ${lexicalLimitParam}`,
      lexicalParams
    )

    const vectorStr = `[${embedding.join(',')}]`
    const vectorWhere = buildGraphVisibilityWhere(scope, 1)
    const vectorScopeClause = vectorWhere.where ? ` AND ${vectorWhere.where}` : ''
    const vectorLimitParam = `$${2 + vectorWhere.params.length}`
    const vectorRows = await this.sqlWithRetry(
      `SELECT ${selectColumns(ENTITY_ROW_COLUMNS)},
              GREATEST(
                1 - (embedding <=> $1::halfvec),
                COALESCE(1 - (description_embedding <=> $1::halfvec), 0)
              ) AS similarity
        FROM ${this.entitiesTable}
        WHERE embedding IS NOT NULL
          ${vectorScopeClause}
          AND invalid_at IS NULL
          AND status = 'active'
        ORDER BY embedding <=> $1::halfvec
        LIMIT ${vectorLimitParam}`,
      [vectorStr, ...vectorWhere.params, maxRows * 3]
    )

    const byId = new Map<string, SemanticEntity>()
    const graphRank = graphPreferenceRank(scope)
    for (const row of [...lexicalRows, ...vectorRows]) {
      const entity = mapRowToEntity(row)
      const existing = byId.get(entity.id)
      if (
        !existing ||
        graphRank(entity.graphId) < graphRank(existing.graphId) ||
        (graphRank(entity.graphId) === graphRank(existing.graphId) &&
          ((entity.metadata._similarity as number | undefined) ?? 0) > ((existing.metadata._similarity as number | undefined) ?? 0))
      ) {
        byId.set(entity.id, entity)
      }
    }

    const merged = [...byId.values()]
      .sort((a, b) => ((b.metadata._similarity as number | undefined) ?? 0) - ((a.metadata._similarity as number | undefined) ?? 0))
      .slice(0, maxRows)
    return this.attachExternalIds(merged)
  }

  // ── Chunk + Fact Graph Storage ──

  async upsertGraphEdges(edges: SemanticGraphEdge[]): Promise<void> {
    if (edges.length === 0) return

    const values: string[] = []
    const params: unknown[] = []
    for (const edge of edges) {
      const base = params.length
      const scope = edge.scope ?? {}
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17},$${base + 18},$${base + 19},$${base + 20},$${base + 21},$${base + 22},$${base + 23},$${base + 24},$${base + 25},$${base + 26},$${base + 27},$${base + 28},$${base + 29},$${base + 30},$${base + 31},$${base + 32})`)
      params.push(
        edge.id,
        edge.sourceType,
        edge.sourceId,
        edge.targetType,
        edge.targetId,
        edge.relation,
        edge.weight,
        JSON.stringify(edge.metadata ?? {}),
        edge.sourceChunkRef?.bucketId ?? null,
        edge.sourceChunkRef?.documentId ?? null,
        edge.sourceChunkRef?.chunkIndex ?? null,
        edge.sourceChunkRef?.embeddingModel ?? null,
        edge.sourceChunkRef?.chunkId ?? null,
        edge.targetChunkRef?.bucketId ?? null,
        edge.targetChunkRef?.documentId ?? null,
        edge.targetChunkRef?.chunkIndex ?? null,
        edge.targetChunkRef?.embeddingModel ?? null,
        edge.targetChunkRef?.chunkId ?? null,
        scope.tenantId ?? 'public',
        scope.organizationId ?? null,
        scope.groupId ?? null,
        scope.userId ?? null,
        scope.agentId ?? null,
        scope.threadId ?? null,
        edge.graphId ?? scope.graphId ?? 'public',
        edge.evidence ?? [],
        edge.temporal.validAt.toISOString(),
        edge.temporal.invalidAt?.toISOString() ?? null,
        edge.temporal.expiredAt?.toISOString() ?? null,
        edge.supersessionKey ?? null,
        edge.supersededById ?? null,
        edge.supersededAt?.toISOString() ?? null,
      )
    }

    const tbl = unqualified(this.edgesTable)
    await this.sqlWithRetry(
      `INSERT INTO ${this.edgesTable}
        (id, source_type, source_id, target_type, target_id, relation, weight, properties,
         from_bucket_id, from_document_id, from_chunk_index, from_embedding_model, from_chunk_id,
         to_bucket_id, to_document_id, to_chunk_index, to_embedding_model, to_chunk_id,
         tenant_id, organization_id, group_id, user_id, agent_id, thread_id, graph_id, evidence,
         valid_at, invalid_at, expired_at, supersession_key, superseded_by_id, superseded_at)
       VALUES ${values.join(',')}
       ON CONFLICT (tenant_id, graph_id, id) DO UPDATE SET
         weight = LEAST(5.0, ${tbl}.weight + EXCLUDED.weight),
         properties = ${tbl}.properties || EXCLUDED.properties,
         from_bucket_id = COALESCE(EXCLUDED.from_bucket_id, ${tbl}.from_bucket_id),
         from_document_id = COALESCE(EXCLUDED.from_document_id, ${tbl}.from_document_id),
         from_chunk_index = COALESCE(EXCLUDED.from_chunk_index, ${tbl}.from_chunk_index),
         from_embedding_model = COALESCE(EXCLUDED.from_embedding_model, ${tbl}.from_embedding_model),
         from_chunk_id = COALESCE(EXCLUDED.from_chunk_id, ${tbl}.from_chunk_id),
         to_bucket_id = COALESCE(EXCLUDED.to_bucket_id, ${tbl}.to_bucket_id),
         to_document_id = COALESCE(EXCLUDED.to_document_id, ${tbl}.to_document_id),
         to_chunk_index = COALESCE(EXCLUDED.to_chunk_index, ${tbl}.to_chunk_index),
         to_embedding_model = COALESCE(EXCLUDED.to_embedding_model, ${tbl}.to_embedding_model),
         to_chunk_id = COALESCE(EXCLUDED.to_chunk_id, ${tbl}.to_chunk_id),
         organization_id = EXCLUDED.organization_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         evidence = ARRAY(SELECT DISTINCT v FROM unnest(${tbl}.evidence || EXCLUDED.evidence) AS v WHERE v <> ''),
         valid_at = LEAST(${tbl}.valid_at, EXCLUDED.valid_at),
         invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at,
         supersession_key = EXCLUDED.supersession_key,
         superseded_by_id = EXCLUDED.superseded_by_id,
         superseded_at = EXCLUDED.superseded_at,
         updated_at = NOW()`,
      params
    )
  }

  async upsertFactRecord(fact: SemanticFactRecord): Promise<SemanticFactRecord> {
    const embeddingStr = fact.embedding ? `[${fact.embedding.join(',')}]` : null
    const description = fact.description ?? fact.evidenceText ?? ''
    const params = [
      fact.id,
      fact.edgeId,
      fact.sourceEntityId,
      fact.targetEntityId,
      fact.relation,
      description,
      fact.description ?? description,
      fact.evidenceText ?? null,
      description,
      fact.chunkId ?? null,
      fact.weight,
      fact.evidenceText ? 1 : 0,
      embeddingStr,
      fact.scope.tenantId ?? 'public',
      fact.scope.organizationId ?? null,
      fact.scope.groupId ?? null,
      fact.scope.userId ?? null,
      fact.scope.agentId ?? null,
      fact.scope.threadId ?? null,
      fact.graphId ?? fact.scope.graphId ?? 'public',
      fact.validAt.toISOString(),
      fact.invalidAt?.toISOString() ?? null,
      fact.expiredAt?.toISOString() ?? null,
      fact.supersessionKey ?? null,
      fact.supersededById ?? null,
      fact.supersededAt?.toISOString() ?? null,
      fact.createdAt.toISOString(),
      fact.updatedAt.toISOString(),
    ]
    const table = unqualified(this.factRecordsTable)
    const buildSql = (conflictTarget: 'edge' | 'id') => `INSERT INTO ${this.factRecordsTable}
        (id, edge_id, source_entity_id, target_entity_id, relation, fact_text,
         description, evidence_text, fact_search_text, from_chunk_id, weight,
         evidence_count, embedding, tenant_id, organization_id, group_id, user_id, agent_id,
         thread_id, graph_id, valid_at, invalid_at, expired_at, supersession_key,
         superseded_by_id, superseded_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::halfvec,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (${conflictTarget === 'edge' ? 'tenant_id, graph_id, edge_id' : 'tenant_id, graph_id, id'}) DO UPDATE SET
         ${conflictTarget === 'id'
           ? `edge_id = EXCLUDED.edge_id,
         source_entity_id = EXCLUDED.source_entity_id,
         target_entity_id = EXCLUDED.target_entity_id,`
           : ''}
         relation = EXCLUDED.relation,
         fact_text = EXCLUDED.fact_text,
         description = EXCLUDED.description,
         evidence_text = EXCLUDED.evidence_text,
         fact_search_text = EXCLUDED.fact_search_text,
         from_chunk_id = COALESCE(EXCLUDED.from_chunk_id, ${table}.from_chunk_id),
         weight = GREATEST(${table}.weight, EXCLUDED.weight),
         evidence_count = GREATEST(${table}.evidence_count, EXCLUDED.evidence_count),
         embedding = COALESCE(EXCLUDED.embedding, ${table}.embedding),
         organization_id = EXCLUDED.organization_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         valid_at = EXCLUDED.valid_at,
         invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at,
         supersession_key = EXCLUDED.supersession_key,
         superseded_by_id = EXCLUDED.superseded_by_id,
         superseded_at = EXCLUDED.superseded_at,
         created_at = ${table}.created_at,
         updated_at = EXCLUDED.updated_at
       RETURNING ${selectColumns(FACT_ROW_COLUMNS)}`
    let rows: Record<string, unknown>[]
    try {
      rows = await this.sqlWithRetry(buildSql('edge'), params)
    } catch (err) {
      if (!isDuplicateFactIdError(err)) throw err
      rows = await this.sqlWithRetry(buildSql('id'), params)
    }
    const stored = mapRowToFact(rows[0]!)
    return this.applyFactSupersession(stored)
  }

  private async applyFactSupersession(fact: SemanticFactRecord): Promise<SemanticFactRecord> {
    if (!fact.supersessionKey) return fact
    const tenantId = fact.scope.tenantId ?? 'public'
    const graphId = fact.graphId ?? fact.scope.graphId ?? 'public'
    const validAt = fact.validAt.toISOString()
    const nextRows = await this.sqlWithRetry(
      `SELECT id, valid_at
         FROM ${this.factRecordsTable}
        WHERE tenant_id = $1
          AND graph_id = $2
          AND supersession_key = $3
          AND id <> $4
          AND valid_at > $5
        ORDER BY valid_at ASC
        LIMIT 1`,
      [tenantId, graphId, fact.supersessionKey, fact.id, validAt]
    )
    const next = nextRows[0]
    if (next) {
      await this.sqlWithRetry(
        `UPDATE ${this.factRecordsTable}
            SET invalid_at = CASE
                  WHEN invalid_at IS NULL OR invalid_at > $5 THEN $5::timestamptz
                  ELSE invalid_at
                END,
                expired_at = COALESCE(expired_at, NOW()),
                superseded_by_id = COALESCE(superseded_by_id, $6),
                superseded_at = COALESCE(superseded_at, NOW()),
                updated_at = NOW()
          WHERE tenant_id = $1
            AND graph_id = $2
            AND supersession_key = $3
            AND id = $4`,
        [tenantId, graphId, fact.supersessionKey, fact.id, new Date(next.valid_at as string).toISOString(), next.id as string]
      )
    }

    const prevRows = await this.sqlWithRetry(
      `SELECT id, invalid_at
         FROM ${this.factRecordsTable}
        WHERE tenant_id = $1
          AND graph_id = $2
          AND supersession_key = $3
          AND id <> $4
          AND valid_at < $5
        ORDER BY valid_at DESC
        LIMIT 1`,
      [tenantId, graphId, fact.supersessionKey, fact.id, validAt]
    )
    const previous = prevRows[0]
    if (previous) {
      await this.sqlWithRetry(
        `UPDATE ${this.factRecordsTable}
            SET invalid_at = $5,
                expired_at = COALESCE(expired_at, NOW()),
                superseded_by_id = $4,
                superseded_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1
            AND graph_id = $2
            AND supersession_key = $3
            AND id = $6
            AND (invalid_at IS NULL OR invalid_at > $5)`,
        [tenantId, graphId, fact.supersessionKey, fact.id, validAt, previous.id as string]
      )
    }

    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(FACT_ROW_COLUMNS)}
         FROM ${this.factRecordsTable}
        WHERE tenant_id = $1 AND graph_id = $2 AND id = $3
        LIMIT 1`,
      [tenantId, graphId, fact.id]
    )
    return rows[0] ? mapRowToFact(rows[0]) : fact
  }

  private async selectFactRecords(
    clauses: string[],
    params: unknown[],
    scope?: TypeGraphStorageIdentity,
    temporal?: GraphFactLookupOptions,
    suffix = '',
  ): Promise<SemanticFactRecord[]> {
    const identity = buildGraphVisibilityWhere(scope, params.length)
    if (identity.where) clauses.push(identity.where)
    params.push(...identity.params)
    const temporalWhere = buildGraphTemporalWhere(temporal, params.length)
    if (temporalWhere.where) clauses.push(temporalWhere.where)
    params.push(...temporalWhere.params)
    const where = clauses.length > 0 ? clauses.join(' AND ') : 'TRUE'
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(FACT_ROW_COLUMNS)}
         FROM ${this.factRecordsTable}
        WHERE ${where}
        ${suffix}`,
      params
    )
    return rows.map(mapRowToFact)
  }

  async getFactRecord(id: string, scope?: TypeGraphStorageIdentity, temporal?: GraphFactLookupOptions): Promise<SemanticFactRecord | null> {
    const factId = id.trim()
    if (!factId) return null
    const rows = await this.selectFactRecords(
      ['id = $1'],
      [factId],
      scope,
      temporal,
      'LIMIT 1',
    )
    return rows[0] ?? null
  }

  async getFactRecordsByIds(ids: string[], scope?: TypeGraphStorageIdentity, temporal?: GraphFactLookupOptions): Promise<SemanticFactRecord[]> {
    const factIds = [...new Set(ids.map(id => id.trim()).filter(Boolean))]
    if (factIds.length === 0) return []
    return this.selectFactRecords(
      ['id = ANY($1::text[])'],
      [factIds],
      scope,
      temporal,
      'ORDER BY array_position($1::text[], id)',
    )
  }

  async findFactRecordsBySupersessionKey(key: string, scope?: TypeGraphStorageIdentity, temporal?: GraphFactLookupOptions): Promise<SemanticFactRecord[]> {
    const supersessionKey = key.trim()
    if (!supersessionKey) return []
    return this.selectFactRecords(
      ['supersession_key = $1'],
      [supersessionKey],
      scope,
      temporal,
      'ORDER BY valid_at ASC, created_at ASC',
    )
  }

  async findFactRecordsByTriple(triple: GraphFactTripleLookup, scope?: TypeGraphStorageIdentity, temporal?: GraphFactLookupOptions): Promise<SemanticFactRecord[]> {
    const sourceEntityId = triple.sourceEntityId.trim()
    const relation = triple.relation.trim()
    const targetEntityId = triple.targetEntityId.trim()
    if (!sourceEntityId || !relation || !targetEntityId) return []
    return this.selectFactRecords(
      ['source_entity_id = $1', 'relation = $2', 'target_entity_id = $3'],
      [sourceEntityId, relation, targetEntityId],
      scope,
      temporal,
      'ORDER BY valid_at DESC, created_at DESC',
    )
  }

  async searchFacts(embedding: number[], scope: TypeGraphStorageIdentity, limit?: number, temporal?: GraphTemporalQueryOptions): Promise<SemanticFactRecord[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? ` AND ${identity.where}` : ''
    const temporalWhere = buildGraphTemporalWhere(temporal, 1 + identity.params.length)
    const temporalClause = temporalWhere.where ? ` AND ${temporalWhere.where}` : ''
    const limitParam = `$${2 + identity.params.length + temporalWhere.params.length}`
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(FACT_ROW_COLUMNS)}, 1 - (embedding <=> $1::halfvec) AS similarity
         FROM ${this.factRecordsTable}
        WHERE embedding IS NOT NULL
          ${scopeClause}
          ${temporalClause}
        ORDER BY embedding <=> $1::halfvec
        LIMIT ${limitParam}`,
      [vectorStr, ...identity.params, ...temporalWhere.params, limit ?? 20]
    )
    return rows.map(mapRowToFact)
  }

  async searchFactsHybrid(query: string, embedding: number[] | undefined, scope: TypeGraphStorageIdentity, limit?: number, temporal?: GraphTemporalQueryOptions): Promise<SemanticFactRecord[]> {
    const maxRows = limit ?? 20
    const identity = buildGraphVisibilityWhere(scope, 2)
    const scopeClause = identity.where ? ` AND ${identity.where}` : ''
    const temporalWhere = buildGraphTemporalWhere(temporal, 2 + identity.params.length, 'f')
    const temporalClause = temporalWhere.where ? ` AND ${temporalWhere.where}` : ''
    const relaxedQuery = normalizeEntityText(query)
    const lexicalRows = await this.sqlWithRetry(
      `WITH tsq AS (
         SELECT websearch_to_tsquery('english', $1::text) AS strict_q,
                websearch_to_tsquery('english', $2::text) AS relaxed_q
       )
       SELECT ${selectColumns(FACT_ROW_COLUMNS, 'f')},
              GREATEST(ts_rank(f.search_vector, tsq.strict_q), ts_rank(f.search_vector, tsq.relaxed_q) * 0.75) AS similarity
         FROM ${this.factRecordsTable} f, tsq
        WHERE TRUE
          AND (f.search_vector @@ tsq.strict_q OR f.search_vector @@ tsq.relaxed_q)
          ${scopeClause}
          ${temporalClause}
        ORDER BY similarity DESC
        LIMIT $${2 + identity.params.length + temporalWhere.params.length + 1}`,
      [query, relaxedQuery, ...identity.params, ...temporalWhere.params, maxRows * 3]
    )

    const vectorRows = embedding
      ? await this.searchFacts(embedding, scope, maxRows * 3, temporal)
      : []

    const byId = new Map<string, SemanticFactRecord>()
    for (const row of [...lexicalRows.map(mapRowToFact), ...vectorRows]) {
      const existing = byId.get(row.id)
      if (!existing || (row.similarity ?? 0) > (existing.similarity ?? 0)) byId.set(row.id, row)
    }
    return [...byId.values()]
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, maxRows)
  }

  async getChunkEdgesForEntities(
    entityIds: string[],
    opts?: {
      scope?: TypeGraphStorageIdentity | undefined
      bucketIds?: string[] | undefined
      limit?: number | undefined
      temporal?: GraphTemporalQueryOptions | undefined
    }
  ): Promise<SemanticEntityChunkEdge[]> {
    if (entityIds.length === 0) return []

    const params: unknown[] = [entityIds]
    let bucketClause = ''
    if (opts?.bucketIds && opts.bucketIds.length > 0) {
      params.push(opts.bucketIds)
      bucketClause = `AND e.to_bucket_id = ANY($${params.length}::text[])`
    }
    const edgeIdentity = buildGraphVisibilityWhere(opts?.scope, params.length, 'e')
    params.push(...edgeIdentity.params)
    const temporalWhere = buildGraphTemporalWhere(opts?.temporal, params.length, 'e')
    params.push(...temporalWhere.params)
    params.push(opts?.limit ?? entityIds.length * 200)
    const limitParam = `$${params.length}`
    const edgeScopeClause = edgeIdentity.where ? `AND ${edgeIdentity.where}` : ''
    const temporalClause = temporalWhere.where ? `AND ${temporalWhere.where}` : ''

    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(EDGE_ROW_COLUMNS, 'e')}
         FROM ${this.edgesTable} e
        WHERE e.source_type = 'entity'
          AND e.target_type = 'chunk'
          AND e.source_id = ANY($1::text[])
          ${bucketClause}
          ${edgeScopeClause}
          ${temporalClause}
        ORDER BY e.weight DESC
        LIMIT ${limitParam}`,
      params
    )
    return rows.map(mapRowToEntityChunkEdge)
  }

  async getChunksByRefs(
    chunkRefs: ChunkRef[],
    opts: {
      chunksTable: string
      scope?: TypeGraphStorageIdentity | undefined
      bucketIds?: string[] | undefined
    }
  ): Promise<SemanticChunkRecord[]> {
    if (chunkRefs.length === 0) return []
    const params: unknown[] = [
      chunkRefs.map(ref => ref.bucketId),
      chunkRefs.map(ref => ref.documentId),
      chunkRefs.map(ref => ref.chunkIndex),
    ]
    let bucketClause = ''
    if (opts.bucketIds && opts.bucketIds.length > 0) {
      params.push(opts.bucketIds)
      bucketClause = `AND c.bucket_id = ANY($${params.length}::text[])`
    }
    const chunkIdentity = buildGraphVisibilityWhere(opts.scope, params.length, 'c')
    params.push(...chunkIdentity.params)
    const chunkScopeClause = chunkIdentity.where ? `AND ${chunkIdentity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT c.id AS chunk_id, c.content, c.bucket_id, c.document_id, c.chunk_index,
              c.embedding_model, c.total_chunks, c.metadata, c.tenant_id, c.group_id,
              c.organization_id, c.user_id, c.agent_id, c.thread_id, c.graph_id
         FROM ${opts.chunksTable} c
        WHERE (c.bucket_id, c.document_id, c.chunk_index) IN (
          SELECT * FROM unnest($1::text[], $2::text[], $3::int[])
        )
          ${bucketClause}
          ${chunkScopeClause}`,
      params
    )
    return rows.map(mapRowToChunkContent)
  }

  async searchChunks(
    embedding: number[],
    scope: TypeGraphStorageIdentity,
    opts: {
      chunksTable: string
      bucketIds?: string[] | undefined
      limit?: number | undefined
      chunkRefs?: ChunkRef[] | undefined
    }
  ): Promise<SemanticChunkRecord[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const params: unknown[] = [vectorStr]
    let bucketClause = ''
    if (opts.bucketIds && opts.bucketIds.length > 0) {
      params.push(opts.bucketIds)
      bucketClause = `AND c.bucket_id = ANY($${params.length}::text[])`
    }
    let chunkRefClause = ''
    if (opts.chunkRefs) {
      if (opts.chunkRefs.length === 0) {
        chunkRefClause = 'AND FALSE'
      } else {
        params.push(opts.chunkRefs.map(ref => ref.bucketId))
        const bucketParam = `$${params.length}`
        params.push(opts.chunkRefs.map(ref => ref.documentId))
        const sourceParam = `$${params.length}`
        params.push(opts.chunkRefs.map(ref => ref.chunkIndex))
        const chunkParam = `$${params.length}`
        chunkRefClause = `AND (c.bucket_id, c.document_id, c.chunk_index) IN (SELECT * FROM unnest(${bucketParam}::text[], ${sourceParam}::text[], ${chunkParam}::int[]))`
      }
    }
    const chunkIdentity = buildGraphVisibilityWhere(scope, params.length, 'c')
    params.push(...chunkIdentity.params)
    params.push(opts.limit ?? 200)
    const limitParam = `$${params.length}`
    const chunkScopeClause = chunkIdentity.where ? `AND ${chunkIdentity.where}` : ''

    const rows = await this.sqlWithRetry(
      `SELECT c.id AS chunk_id, c.content, c.bucket_id, c.document_id, c.chunk_index,
              c.embedding_model, c.total_chunks, c.metadata, c.tenant_id, c.group_id,
              c.organization_id, c.user_id, c.agent_id, c.thread_id, c.graph_id,
              1 - (c.embedding <=> $1::halfvec) AS similarity
         FROM ${opts.chunksTable} c
        WHERE c.embedding IS NOT NULL
          ${bucketClause}
          ${chunkRefClause}
          ${chunkScopeClause}
        ORDER BY c.embedding <=> $1::halfvec
        LIMIT ${limitParam}`,
      params
    )

    return rows.map(row => ({
      ...mapRowToChunkContent(row),
      similarity: row.similarity as number,
    }))
  }

  // ── Edge Storage ──

  async upsertEdge(edge: SemanticEdge): Promise<SemanticEdge> {
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.edgesTable}
        (id, source_type, source_id, target_type, target_id, relation, weight, properties,
         tenant_id, organization_id, group_id, user_id, agent_id, thread_id, graph_id,
         evidence, valid_at, invalid_at, expired_at, supersession_key, superseded_by_id,
         superseded_at, updated_at)
       VALUES ($1,'entity',$2,'entity',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
       ON CONFLICT (tenant_id, graph_id, id) DO UPDATE SET
         weight = ${unqualified(this.edgesTable)}.weight + EXCLUDED.weight,
         properties = ${unqualified(this.edgesTable)}.properties || EXCLUDED.properties,
         organization_id = EXCLUDED.organization_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         valid_at = EXCLUDED.valid_at,
         invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at,
         supersession_key = EXCLUDED.supersession_key,
         superseded_by_id = EXCLUDED.superseded_by_id,
         superseded_at = EXCLUDED.superseded_at,
         updated_at = NOW()
       RETURNING ${selectColumns(EDGE_ROW_COLUMNS)}`,
      [
        edge.id, edge.sourceEntityId, edge.targetEntityId,
        edge.relation, edge.weight, JSON.stringify(edge.metadata),
        edge.scope.tenantId ?? 'public',
        edge.scope.organizationId ?? null,
        edge.scope.groupId ?? null,
        edge.scope.userId ?? null,
        edge.scope.agentId ?? null,
        edge.scope.threadId ?? null,
        edge.graphId ?? edge.scope.graphId ?? 'public',
        edge.evidence,
        edge.temporal.validAt.toISOString(),
        edge.temporal.invalidAt?.toISOString() ?? null,
        edge.temporal.expiredAt?.toISOString() ?? null,
        edge.supersessionKey ?? null,
        edge.supersededById ?? null,
        edge.supersededAt?.toISOString() ?? null,
      ]
    )
    const stored = mapRowToEdge(rows[0]!)
    return this.applyEdgeSupersession(stored)
  }

  private async applyEdgeSupersession(edge: SemanticEdge): Promise<SemanticEdge> {
    if (!edge.supersessionKey) return edge
    const tenantId = edge.scope.tenantId ?? 'public'
    const graphId = edge.graphId ?? edge.scope.graphId ?? 'public'
    const validAt = edge.temporal.validAt.toISOString()
    const nextRows = await this.sqlWithRetry(
      `SELECT id, valid_at
         FROM ${this.edgesTable}
        WHERE tenant_id = $1
          AND graph_id = $2
          AND supersession_key = $3
          AND id <> $4
          AND valid_at > $5
        ORDER BY valid_at ASC
        LIMIT 1`,
      [tenantId, graphId, edge.supersessionKey, edge.id, validAt]
    )
    const next = nextRows[0]
    if (next) {
      await this.sqlWithRetry(
        `UPDATE ${this.edgesTable}
            SET invalid_at = CASE
                  WHEN invalid_at IS NULL OR invalid_at > $5 THEN $5::timestamptz
                  ELSE invalid_at
                END,
                expired_at = COALESCE(expired_at, NOW()),
                superseded_by_id = COALESCE(superseded_by_id, $6),
                superseded_at = COALESCE(superseded_at, NOW()),
                updated_at = NOW()
          WHERE tenant_id = $1
            AND graph_id = $2
            AND supersession_key = $3
            AND id = $4`,
        [tenantId, graphId, edge.supersessionKey, edge.id, new Date(next.valid_at as string).toISOString(), next.id as string]
      )
    }

    const prevRows = await this.sqlWithRetry(
      `SELECT id
         FROM ${this.edgesTable}
        WHERE tenant_id = $1
          AND graph_id = $2
          AND supersession_key = $3
          AND id <> $4
          AND valid_at < $5
        ORDER BY valid_at DESC
        LIMIT 1`,
      [tenantId, graphId, edge.supersessionKey, edge.id, validAt]
    )
    const previous = prevRows[0]
    if (previous) {
      await this.sqlWithRetry(
        `UPDATE ${this.edgesTable}
            SET invalid_at = $5,
                expired_at = COALESCE(expired_at, NOW()),
                superseded_by_id = $4,
                superseded_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1
            AND graph_id = $2
            AND supersession_key = $3
            AND id = $6
            AND (invalid_at IS NULL OR invalid_at > $5)`,
        [tenantId, graphId, edge.supersessionKey, edge.id, validAt, previous.id as string]
      )
    }

    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(EDGE_ROW_COLUMNS)}
         FROM ${this.edgesTable}
        WHERE tenant_id = $1 AND graph_id = $2 AND id = $3
        LIMIT 1`,
      [tenantId, graphId, edge.id]
    )
    return rows[0] ? mapRowToEdge(rows[0]) : edge
  }

  async getEdges(entityId: string, direction?: 'in' | 'out' | 'both', scope?: TypeGraphStorageIdentity, temporal?: GraphTemporalQueryOptions): Promise<SemanticEdge[]> {
    let query: string
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const temporalWhere = buildGraphTemporalWhere(temporal, 1 + identity.params.length)
    const temporalClause = temporalWhere.where ? `AND ${temporalWhere.where}` : ''
    const params = [entityId, ...identity.params, ...temporalWhere.params]
    if (direction === 'in') {
      query = `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable} WHERE target_type = 'entity' AND target_id = $1 AND source_type = 'entity' ${scopeClause} ${temporalClause}`
    } else if (direction === 'out') {
      query = `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable} WHERE source_type = 'entity' AND source_id = $1 AND target_type = 'entity' ${scopeClause} ${temporalClause}`
    } else {
      query = `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable}
               WHERE ((source_type = 'entity' AND source_id = $1 AND target_type = 'entity')
                   OR (target_type = 'entity' AND target_id = $1 AND source_type = 'entity'))
                 ${scopeClause} ${temporalClause}`
    }
    const rows = await this.sqlWithRetry(query, params)
    return rows.map(mapRowToEdge)
  }

  async getEdgesBatch(entityIds: string[], direction: 'in' | 'out' | 'both' = 'both', scope?: TypeGraphStorageIdentity, temporal?: GraphTemporalQueryOptions): Promise<SemanticEdge[]> {
    if (entityIds.length === 0) return []
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const temporalWhere = buildGraphTemporalWhere(temporal, 1 + identity.params.length)
    const temporalClause = temporalWhere.where ? `AND ${temporalWhere.where}` : ''
    let query: string
    if (direction === 'out') {
      query = `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable} WHERE source_type = 'entity' AND source_id = ANY($1::text[]) AND target_type = 'entity' ${scopeClause} ${temporalClause}`
    } else if (direction === 'in') {
      query = `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable} WHERE target_type = 'entity' AND target_id = ANY($1::text[]) AND source_type = 'entity' ${scopeClause} ${temporalClause}`
    } else {
      query = `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable}
               WHERE ((source_type = 'entity' AND source_id = ANY($1::text[]) AND target_type = 'entity')
                   OR (target_type = 'entity' AND target_id = ANY($1::text[]) AND source_type = 'entity'))
                 ${scopeClause}`
      query += ` ${temporalClause}`
    }
    const rows = await this.sqlWithRetry(query, [entityIds, ...identity.params, ...temporalWhere.params])
    return rows.map(mapRowToEdge)
  }

  async findEdges(sourceId: string, targetId: string, relation?: string): Promise<SemanticEdge[]> {
    const conditions = [`source_type = 'entity'`, 'source_id = $1', `target_type = 'entity'`, 'target_id = $2']
    const params: unknown[] = [sourceId, targetId]
    if (relation) {
      params.push(relation)
      conditions.push(`relation = $${params.length}`)
    }
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(EDGE_ROW_COLUMNS)} FROM ${this.edgesTable} WHERE ${conditions.join(' AND ')}`,
      params
    )
    return rows.map(mapRowToEdge)
  }

  async invalidateEdge(id: string, invalidAt?: Date, opts?: GraphInvalidationOptions | null): Promise<void> {
    const expiredAt = dateParam(opts?.expiredAt) ?? (opts?.reason ? new Date().toISOString() : null)
    await this.sqlWithRetry(
      `UPDATE ${this.edgesTable}
          SET invalid_at = $2,
              expired_at = COALESCE($3::timestamptz, expired_at),
              updated_at = NOW()
        WHERE id = $1`,
      [id, (invalidAt ?? new Date()).toISOString(), expiredAt]
    )
  }

  async invalidateFactRecord(id: string, opts?: GraphInvalidationOptions | null, scope?: TypeGraphStorageIdentity): Promise<void> {
    const invalidAt = dateParam(opts?.invalidAt) ?? new Date().toISOString()
    const expiredAt = dateParam(opts?.expiredAt) ?? (opts?.reason ? new Date().toISOString() : null)
    const identity = buildGraphVisibilityWhere(scope, 3)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    await this.sqlWithRetry(
      `UPDATE ${this.factRecordsTable}
          SET invalid_at = $2,
              expired_at = COALESCE($3::timestamptz, expired_at),
              updated_at = NOW()
        WHERE id = $1
          ${scopeClause}`,
      [id, invalidAt, expiredAt, ...identity.params]
    )
  }

  async invalidateGraphEdgesForNode(nodeType: 'entity' | 'chunk' | 'memory', nodeId: string, invalidAt?: Date): Promise<void> {
    await this.sqlWithRetry(
      `UPDATE ${this.edgesTable}
          SET invalid_at = $3, updated_at = NOW()
        WHERE (source_type = $1 AND source_id = $2)
           OR (target_type = $1 AND target_id = $2)`,
      [nodeType, nodeId, (invalidAt ?? new Date()).toISOString()]
    )
  }

  async getMemoryIdsForEntities(entityIds: string[], scope?: TypeGraphStorageIdentity): Promise<string[]> {
    if (entityIds.length === 0) return []
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT DISTINCT
              CASE
                WHEN source_type = 'memory' THEN source_id
                ELSE target_id
              END AS memory_id
         FROM ${this.edgesTable}
        WHERE invalid_at IS NULL
          AND (
            (source_type = 'memory' AND target_type = 'entity' AND target_id = ANY($1::text[]))
            OR
            (target_type = 'memory' AND source_type = 'entity' AND source_id = ANY($1::text[]))
          )
          ${scopeClause}`,
      [entityIds, ...identity.params]
    )
    return rows.map(row => row.memory_id as string)
  }

  async mergeEntityReferences(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult> {
    if (input.sourceEntityId === input.targetEntityId) {
      throw new Error('mergeEntityReferences requires distinct source and target entity IDs')
    }

    return this.withTransaction(async () => {
      const source = await this.getEntity(input.sourceEntityId)
      const target = await this.getEntity(input.targetEntityId)
      if (!source) throw new Error(`Source entity not found: ${input.sourceEntityId}`)
      if (!target) throw new Error(`Target entity not found: ${input.targetEntityId}`)

      const now = new Date()
      const mergedAliases = [...new Set([
        ...target.aliases,
        source.name,
        ...source.aliases,
      ].map(value => value.trim()).filter(Boolean))]
        .filter(alias => alias.toLowerCase() !== target.name.toLowerCase())
      const mergedEntityIds = [
        ...new Set([
          ...arrayProperty(target.metadata.mergedEntityIds),
          ...arrayProperty(source.metadata.mergedEntityIds),
          source.id,
        ]),
      ]

      await this.upsertEntity({
        ...target,
        aliases: mergedAliases,
        metadata: {
          ...source.metadata,
          ...target.metadata,
          ...(input.metadata ?? {}),
          mergedEntityIds,
          updatedAt: now.toISOString(),
        },
        status: 'active',
      })

      const duplicateExternalRows = await this.sqlWithRetry(
        `DELETE FROM ${this.entityExternalIdsTable} sx
          USING ${this.entityExternalIdsTable} tx
         WHERE sx.entity_id = $1
           AND tx.entity_id = $2
           AND sx.type = tx.type
           AND sx.normalized_value = tx.normalized_value
           AND sx.encoding = tx.encoding
         RETURNING sx.id`,
        [source.id, target.id]
      )
      const movedExternalRows = await this.sqlWithRetry(
        `UPDATE ${this.entityExternalIdsTable}
            SET entity_id = $2, updated_at = NOW()
          WHERE entity_id = $1
        RETURNING id`,
        [source.id, target.id]
      )

      const duplicateMentionRows = await this.sqlWithRetry(
        `DELETE FROM ${this.chunkMentionsTable} sm
          USING ${this.chunkMentionsTable} tm
         WHERE sm.entity_id = $1
           AND tm.entity_id = $2
           AND sm.tenant_id = tm.tenant_id
           AND sm.graph_id = tm.graph_id
           AND sm.document_id = tm.document_id
           AND sm.chunk_index = tm.chunk_index
           AND sm.mention_type = tm.mention_type
           AND sm.normalized_surface_text = tm.normalized_surface_text
         RETURNING sm.id`,
        [source.id, target.id]
      )
      const movedMentionRows = await this.sqlWithRetry(
        `UPDATE ${this.chunkMentionsTable}
            SET entity_id = $2
          WHERE entity_id = $1
        RETURNING id`,
        [source.id, target.id]
      )

      const edgeRows = await this.sqlWithRetry(
        `SELECT ${selectColumns(EDGE_ROW_COLUMNS)}
           FROM ${this.edgesTable}
          WHERE invalid_at IS NULL
            AND (
              (source_type = 'entity' AND source_id = $1)
              OR
              (target_type = 'entity' AND target_id = $1)
            )
          ORDER BY created_at, id`,
        [source.id]
      )
      const edgeIdMap = new Map<string, string>()
      let redirectedGraphEdges = 0
      let redirectedEdges = 0
      let removedSelfEdges = 0
      for (const row of edgeRows) {
        const edgeId = row.id as string
        const newSourceId = row.source_type === 'entity' && row.source_id === source.id
          ? target.id
          : row.source_id as string
        const newTargetId = row.target_type === 'entity' && row.target_id === source.id
          ? target.id
          : row.target_id as string

        if (row.source_type === 'entity' && row.target_type === 'entity' && newSourceId === newTargetId) {
          await this.sqlWithRetry(
            `UPDATE ${this.edgesTable}
                SET invalid_at = $2, updated_at = NOW()
              WHERE id = $1`,
            [edgeId, now.toISOString()]
          )
          edgeIdMap.set(edgeId, edgeId)
          removedSelfEdges += 1
          redirectedEdges += 1
          continue
        }

        const conflict = await this.sqlWithRetry(
          `SELECT id
             FROM ${this.edgesTable}
            WHERE source_type = $1
              AND source_id = $2
              AND target_type = $3
              AND target_id = $4
              AND relation = $5
              AND invalid_at IS NULL
              AND id <> $6
            LIMIT 1`,
          [row.source_type, newSourceId, row.target_type, newTargetId, row.relation, edgeId]
        )
        if (conflict[0]?.id) {
          const conflictId = conflict[0].id as string
          await this.sqlWithRetry(
            `UPDATE ${this.edgesTable} target
                SET weight = LEAST(5.0, target.weight + source.weight),
                    properties = target.properties || source.properties,
                    evidence = ARRAY(SELECT DISTINCT v FROM unnest(target.evidence || source.evidence) AS v WHERE v <> ''),
                    updated_at = NOW()
               FROM ${this.edgesTable} source
              WHERE target.id = $1
                AND source.id = $2`,
            [conflictId, edgeId]
          )
          await this.sqlWithRetry(
            `UPDATE ${this.edgesTable}
                SET invalid_at = $2, updated_at = NOW()
              WHERE id = $1`,
            [edgeId, now.toISOString()]
          )
          edgeIdMap.set(edgeId, conflictId)
        } else {
          await this.sqlWithRetry(
            `UPDATE ${this.edgesTable}
                SET source_id = $2,
                    target_id = $3,
                    updated_at = NOW()
              WHERE id = $1`,
            [edgeId, newSourceId, newTargetId]
          )
          edgeIdMap.set(edgeId, edgeId)
        }
        redirectedGraphEdges += 1
        if (row.source_type === 'entity' && row.target_type === 'entity') redirectedEdges += 1
      }

      const factRows = await this.sqlWithRetry(
        `SELECT ${selectColumns(FACT_ROW_COLUMNS)}
           FROM ${this.factRecordsTable}
          WHERE invalid_at IS NULL
            AND (source_entity_id = $1 OR target_entity_id = $1)
          ORDER BY created_at, id`,
        [source.id]
      )
      let redirectedFacts = 0
      for (const row of factRows) {
        const factId = row.id as string
        const newSourceId = row.source_entity_id === source.id ? target.id : row.source_entity_id as string
        const newTargetId = row.target_entity_id === source.id ? target.id : row.target_entity_id as string
        const newEdgeId = edgeIdMap.get(row.edge_id as string) ?? row.edge_id as string
        if (newSourceId === newTargetId) {
          await this.sqlWithRetry(
            `UPDATE ${this.factRecordsTable}
                SET invalid_at = $2, updated_at = NOW()
              WHERE id = $1`,
            [factId, now.toISOString()]
          )
          redirectedFacts += 1
          continue
        }

        const conflict = await this.sqlWithRetry(
          `SELECT id
             FROM ${this.factRecordsTable}
            WHERE edge_id = $1
              AND id <> $2
              AND invalid_at IS NULL
            LIMIT 1`,
          [newEdgeId, factId]
        )
        if (conflict[0]?.id) {
          await this.sqlWithRetry(
            `UPDATE ${this.factRecordsTable} target
                SET weight = GREATEST(target.weight, source.weight),
                    evidence_count = GREATEST(target.evidence_count, source.evidence_count),
                    updated_at = NOW()
               FROM ${this.factRecordsTable} source
              WHERE target.id = $1
                AND source.id = $2`,
            [conflict[0].id as string, factId]
          )
          await this.sqlWithRetry(
            `UPDATE ${this.factRecordsTable}
                SET invalid_at = $2, updated_at = NOW()
              WHERE id = $1`,
            [factId, now.toISOString()]
          )
        } else {
          await this.sqlWithRetry(
            `UPDATE ${this.factRecordsTable}
                SET edge_id = $2,
                    source_entity_id = $3,
                    target_entity_id = $4,
                    fact_text = replace(fact_text, $5, $6),
                    fact_search_text = replace(fact_search_text, $5, $6),
                    updated_at = NOW()
              WHERE id = $1`,
            [factId, newEdgeId, newSourceId, newTargetId, source.name, target.name]
          )
        }
        redirectedFacts += 1
      }

      await this.sqlWithRetry(
        `UPDATE ${this.entitiesTable}
            SET status = 'merged',
                merged_into_entity_id = $2,
                invalid_at = $3,
                deleted_at = $3,
                properties = properties || $4::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [
          source.id,
          target.id,
          now.toISOString(),
          JSON.stringify({ mergedIntoEntityId: target.id }),
        ]
      )

      const refreshed = await this.getEntity(target.id)
      return {
        target: entityDetailFromSemanticEntity(refreshed ?? target),
        sourceEntityId: source.id,
        targetEntityId: target.id,
        redirectedEdges,
        redirectedFacts,
        redirectedGraphEdges,
        movedMentions: duplicateMentionRows.length + movedMentionRows.length,
        movedExternalIds: duplicateExternalRows.length + movedExternalRows.length,
        removedSelfEdges,
      }
    })
  }

  async deleteEntityReferences(entityId: string, opts?: DeleteGraphEntityOpts | null): Promise<DeleteGraphEntityResult> {
    const mode = opts?.mode ?? 'invalidate'
    const now = new Date()

    return this.withTransaction(async () => {
      if (mode === 'purge') {
        const factRows = await this.sqlWithRetry(
          `DELETE FROM ${this.factRecordsTable}
            WHERE source_entity_id = $1 OR target_entity_id = $1
          RETURNING id`,
          [entityId]
        )
        const edgeRows = await this.sqlWithRetry(
          `DELETE FROM ${this.edgesTable}
            WHERE (source_type = 'entity' AND source_id = $1)
               OR (target_type = 'entity' AND target_id = $1)
          RETURNING id, source_type, target_type`,
          [entityId]
        )
        const mentionRows = await this.sqlWithRetry(
          `DELETE FROM ${this.chunkMentionsTable}
            WHERE entity_id = $1
          RETURNING id`,
          [entityId]
        )
        const externalRows = await this.sqlWithRetry(
          `DELETE FROM ${this.entityExternalIdsTable}
            WHERE entity_id = $1
          RETURNING id`,
          [entityId]
        )
        await this.sqlWithRetry(
          `DELETE FROM ${this.entitiesTable}
            WHERE id = $1`,
          [entityId]
        )
        return {
          entityId,
          mode,
          deletedEdges: edgeRows.filter(row => row.source_type === 'entity' && row.target_type === 'entity').length,
          deletedFacts: factRows.length,
          deletedGraphEdges: edgeRows.length,
          deletedMentions: mentionRows.length,
          deletedExternalIds: externalRows.length,
        }
      }

      const factRows = await this.sqlWithRetry(
        `UPDATE ${this.factRecordsTable}
            SET invalid_at = $2, updated_at = NOW()
          WHERE invalid_at IS NULL
            AND (source_entity_id = $1 OR target_entity_id = $1)
        RETURNING id`,
        [entityId, now.toISOString()]
      )
      const edgeRows = await this.sqlWithRetry(
        `UPDATE ${this.edgesTable}
            SET invalid_at = $2, updated_at = NOW()
          WHERE invalid_at IS NULL
            AND (
              (source_type = 'entity' AND source_id = $1)
              OR
              (target_type = 'entity' AND target_id = $1)
            )
        RETURNING id, source_type, target_type`,
        [entityId, now.toISOString()]
      )
      await this.sqlWithRetry(
        `UPDATE ${this.entitiesTable}
            SET status = 'invalidated',
                invalid_at = $2,
                deleted_at = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [entityId, now.toISOString()]
      )
      const mentionRows = await this.sqlWithRetry(
        `SELECT id FROM ${this.chunkMentionsTable} WHERE entity_id = $1`,
        [entityId]
      )
      const externalRows = await this.sqlWithRetry(
        `SELECT id FROM ${this.entityExternalIdsTable} WHERE entity_id = $1`,
        [entityId]
      )
      return {
        entityId,
        mode,
        deletedEdges: edgeRows.filter(row => row.source_type === 'entity' && row.target_type === 'entity').length,
        deletedFacts: factRows.length,
        deletedGraphEdges: edgeRows.length,
        deletedMentions: mentionRows.length,
        deletedExternalIds: externalRows.length,
      }
    })
  }

  // ── Entity ↔ Chunk Mention Evidence ──

  async upsertEntityChunkMentions(mentions: SemanticEntityMention[]): Promise<void> {
    if (mentions.length === 0) return

    // Build a single multi-row INSERT. ON CONFLICT updates confidence if provided
    // (last writer wins on confidence — rare: only if the same extraction reruns
    // with a different score). Idempotent on entity/chunk/type/surface form.
    const values: string[] = []
    const params: unknown[] = []
    for (const m of mentions) {
      const base = params.length
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`)
      const surfaceText = m.surfaceText?.trim() || null
      const normalizedSurfaceText = m.normalizedSurfaceText?.trim()
        || (surfaceText ? normalizeEntityText(surfaceText) : '')
      params.push(
        generateId('mention'),
        m.tenantId ?? 'public',
        m.graphId ?? 'public',
        m.organizationId ?? null,
        m.entityId,
        m.documentId,
        m.chunkIndex,
        m.bucketId,
        m.mentionType,
        surfaceText,
        normalizedSurfaceText,
        m.confidence ?? null,
      )
    }

    await this.sqlWithRetry(
      `INSERT INTO ${this.chunkMentionsTable}
         (id, tenant_id, graph_id, organization_id, entity_id, document_id, chunk_index, bucket_id, mention_type, surface_text, normalized_surface_text, confidence)
       VALUES ${values.join(',')}
       ON CONFLICT (tenant_id, graph_id, entity_id, document_id, chunk_index, mention_type, normalized_surface_text) DO UPDATE SET
         surface_text = COALESCE(EXCLUDED.surface_text, ${unqualified(this.chunkMentionsTable)}.surface_text),
         confidence = COALESCE(EXCLUDED.confidence, ${unqualified(this.chunkMentionsTable)}.confidence)`,
      params
    )
  }

  async listChunkBackfillRecords(opts: {
    chunksTable: string
    scope?: TypeGraphStorageIdentity | undefined
    bucketIds?: string[] | undefined
    limit?: number | undefined
    offset?: number | undefined
  }): Promise<ChunkBackfillRecord[]> {
    const params: unknown[] = []
    let bucketClause = ''
    if (opts.bucketIds && opts.bucketIds.length > 0) {
      params.push(opts.bucketIds)
      bucketClause = `AND c.bucket_id = ANY($${params.length}::text[])`
    }
    const identity = opts.scope ? buildAliasedIdentityWhere('c', opts.scope, params.length) : { where: '', params: [] }
    params.push(...identity.params)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    params.push(opts.limit ?? 500)
    const limitParam = `$${params.length}`
    params.push(opts.offset ?? 0)
    const offsetParam = `$${params.length}`

    const rows = await this.sqlWithRetry(
      `SELECT c.id AS chunk_id, c.bucket_id, c.document_id, c.chunk_index,
              c.embedding_model, c.content, c.metadata, c.graph_id,
              c.tenant_id, c.organization_id, c.group_id, c.user_id, c.agent_id, c.thread_id
         FROM ${opts.chunksTable} c
        WHERE TRUE
          ${bucketClause}
          ${scopeClause}
        ORDER BY c.document_id, c.chunk_index
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    )
    return rows.map(mapRowToChunkBackfillRecord)
  }

  async listChunkMentionBackfillRows(opts: {
    chunksTable: string
    scope?: TypeGraphStorageIdentity | undefined
    bucketIds?: string[] | undefined
    limit?: number | undefined
    offset?: number | undefined
  }): Promise<ChunkMentionBackfillRow[]> {
    const params: unknown[] = []
    let bucketClause = ''
    if (opts.bucketIds && opts.bucketIds.length > 0) {
      params.push(opts.bucketIds)
      bucketClause = `AND c.bucket_id = ANY($${params.length}::text[])`
    }
    const identity = opts.scope ? buildAliasedIdentityWhere('c', opts.scope, params.length) : { where: '', params: [] }
    params.push(...identity.params)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    params.push(opts.limit ?? 500)
    const limitParam = `$${params.length}`
    params.push(opts.offset ?? 0)
    const offsetParam = `$${params.length}`

    const rows = await this.sqlWithRetry(
      `SELECT c.id AS chunk_id, c.bucket_id, c.document_id, c.chunk_index,
              c.embedding_model, c.content, c.metadata, c.graph_id,
              c.tenant_id, c.organization_id, c.group_id, c.user_id, c.agent_id, c.thread_id,
              m.entity_id, m.mention_type, m.surface_text, m.normalized_surface_text, m.confidence
         FROM ${this.chunkMentionsTable} m
         JOIN ${opts.chunksTable} c
           ON m.tenant_id = c.tenant_id
          AND m.graph_id = c.graph_id
          AND m.document_id = c.document_id
          AND m.chunk_index = c.chunk_index
          AND m.bucket_id = c.bucket_id
        WHERE TRUE
          ${bucketClause}
          ${scopeClause}
        ORDER BY c.document_id, c.chunk_index, m.entity_id
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    )
    return rows.map(row => ({
      ...mapRowToChunkBackfillRecord(row),
      entityId: row.entity_id as string,
      mentionType: row.mention_type as SemanticEntityMention['mentionType'],
      surfaceText: (row.surface_text as string | null) ?? undefined,
      normalizedSurfaceText: (row.normalized_surface_text as string | null) ?? undefined,
      confidence: (row.confidence as number | null) ?? undefined,
    }))
  }

  async listSemanticEdgesForBackfill(opts?: {
    scope?: TypeGraphStorageIdentity | undefined
    limit?: number | undefined
    offset?: number | undefined
  }): Promise<SemanticEdge[]> {
    const identity = opts?.scope ? buildIdentityWhere(opts.scope) : { where: '', params: [] }
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const params = [...identity.params, opts?.limit ?? 500, opts?.offset ?? 0]
    const limitParam = `$${params.length - 1}`
    const offsetParam = `$${params.length}`
    const rows = await this.sqlWithRetry(
      `SELECT ${selectColumns(EDGE_ROW_COLUMNS)}
         FROM ${this.edgesTable}
        WHERE source_type = 'entity'
          AND target_type = 'entity'
          AND invalid_at IS NULL
          ${scopeClause}
        ORDER BY created_at, id
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    )
    return rows.map(mapRowToEdge)
  }

  // ── Counts ──

  async countMemories(filter?: MemoryFilter): Promise<number> {
    const { where, params } = filter ? buildMemoryWhere(filter) : { where: '', params: [] }
    const whereClause = where ? `WHERE ${where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT COUNT(*)::integer AS n FROM ${this.memoriesTable} ${whereClause}`,
      params
    )
    return (rows[0]?.['n'] as number) ?? 0
  }

  async countEntities(scope?: TypeGraphStorageIdentity): Promise<number> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT COUNT(*)::integer AS n FROM ${this.entitiesTable} WHERE invalid_at IS NULL ${scopeClause}`,
      identity.params
    )
    return (rows[0]?.['n'] as number) ?? 0
  }

  async countEdges(scope?: TypeGraphStorageIdentity): Promise<number> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT COUNT(*)::integer AS n FROM ${this.edgesTable} WHERE invalid_at IS NULL ${scopeClause}`,
      identity.params
    )
    return (rows[0]?.['n'] as number) ?? 0
  }

  async getRelationTypes(scope?: TypeGraphStorageIdentity): Promise<Array<{ relation: string; count: number }>> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT relation, COUNT(*)::integer AS count FROM ${this.edgesTable}
       WHERE source_type = 'entity'
         AND target_type = 'entity'
         AND invalid_at IS NULL
         ${scopeClause}
       GROUP BY relation ORDER BY count DESC`,
      identity.params
    )
    return rows.map(r => ({ relation: r.relation as string, count: r.count as number }))
  }

  async getEntityTypes(scope?: TypeGraphStorageIdentity): Promise<Array<{ entityType: string; count: number }>> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT entity_type, COUNT(*)::integer AS count FROM ${this.entitiesTable}
       WHERE invalid_at IS NULL
         ${scopeClause}
       GROUP BY entity_type ORDER BY count DESC`,
      identity.params
    )
    return rows.map(r => ({ entityType: r.entity_type as string, count: r.count as number }))
  }

  async getDegreeDistribution(scope?: TypeGraphStorageIdentity): Promise<Array<{ degree: number; count: number }>> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT degree, COUNT(*)::integer AS count FROM (
         SELECT source_id AS eid, COUNT(*)::integer AS degree FROM ${this.edgesTable} WHERE source_type = 'entity' AND target_type = 'entity' AND invalid_at IS NULL ${scopeClause} GROUP BY source_id
         UNION ALL
         SELECT target_id AS eid, COUNT(*)::integer AS degree FROM ${this.edgesTable} WHERE source_type = 'entity' AND target_type = 'entity' AND invalid_at IS NULL ${scopeClause} GROUP BY target_id
       ) sub
       GROUP BY degree ORDER BY degree`,
      identity.params
    )
    return rows.map(r => ({ degree: r.degree as number, count: r.count as number }))
  }
}

// ── Row Mappers ──

function mapRowToMemory(row: Record<string, unknown>): MemoryRecord {
  // Build the SDK compatibility scope from explicit identity columns.
  const scope = rowToIdentity(row)
  const metadata = parseJson(row.metadata)
  // Stash vector similarity score from search queries so callers can use it
  // without re-embedding. Only present when the row came from a search() call.
  if (row.similarity != null) {
    metadata._similarity = row.similarity as number
  }
  // Stash temporal fields for composite memory scoring (similarity + importance + recency)
  if (row.last_accessed_at != null) {
    metadata._lastAccessedAt = new Date(row.last_accessed_at as string).toISOString()
  }
  if (row.created_at != null) {
    metadata._createdAt = new Date(row.created_at as string).toISOString()
  }
  const base: MemoryRecord = {
    id: row.id as string,
    graphId: (row.graph_id as string | null) ?? 'public',
    category: row.category as MemoryRecord['category'],
    status: row.status as MemoryRecord['status'],
    content: row.content as string,
    embedding: undefined, // Don't return vectors — too large
    importance: row.importance as number,
    accessCount: row.access_count as number,
    lastAccessedAt: new Date(row.last_accessed_at as string),
    metadata,
    scope,
    validAt: new Date(row.valid_at as string),
    invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
    expiredAt: row.expired_at ? new Date(row.expired_at as string) : undefined,
  }

  // Attach subtype fields based on category
  if (base.category === 'episodic') {
    Object.assign(base, {
      eventType: row.event_type as string,
      participants: row.participants as string[] | undefined,
      threadId: (row.episodic_thread_id as string) ?? undefined,
      sequence: (row.sequence as number) ?? undefined,
      consolidatedAt: row.consolidated_at ? new Date(row.consolidated_at as string) : undefined,
    })
  } else if (base.category === 'semantic') {
    Object.assign(base, {
      subject: row.subject as string,
      predicate: row.predicate as string,
      object: row.object as string,
      confidence: row.confidence as number,
      sourceMemoryIds: row.source_memory_ids as string[] ?? [],
    })
  } else if (base.category === 'procedural') {
    Object.assign(base, {
      trigger: row.trigger as string,
      steps: row.steps as string[] ?? [],
      successCount: row.success_count as number ?? 0,
      failureCount: row.failure_count as number ?? 0,
      lastOutcome: (row.last_outcome as string) ?? undefined,
    })
  }

  return base
}

function mapRowToArtifact(row: Record<string, unknown>): MemoryArtifact {
  return {
    tenantId: row.tenant_id as string,
    graphId: (row.graph_id as string | null) ?? 'public',
    layoutId: row.layout_id as string,
    path: row.path as string,
    kind: row.kind as MemoryArtifactKind,
    content: row.content as string,
    metadata: parseJson(row.metadata),
    contentHash: row.content_hash as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

function mapRowToEntity(row: Record<string, unknown>): SemanticEntity {
  const props = parseJson(row.properties)
  // Stash pgvector similarity score (if present from searchEntities query) as transient property
  if (row.similarity != null) {
    props._similarity = row.similarity as number
  }
  return {
    id: row.id as string,
    graphId: (row.graph_id as string | null) ?? 'public',
    name: row.name as string,
    entityType: row.entity_type as string,
    aliases: row.aliases as string[] ?? [],
    metadata: props,
    status: (row.status as SemanticEntity['status']) ?? 'active',
    mergedIntoEntityId: (row.merged_into_entity_id as string | null) ?? undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : undefined,
    embedding: undefined,
    descriptionEmbedding: parseVectorString(row.description_embedding),
    scope: rowToIdentity(row),
    temporal: {
      validAt: new Date(row.valid_at as string),
      invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
      expiredAt: undefined,
    },
  }
}

function mapRowToEdge(row: Record<string, unknown>): SemanticEdge {
  return {
    id: row.id as string,
    graphId: (row.graph_id as string | null) ?? 'public',
    sourceType: 'entity',
    sourceId: row.source_id as string,
    targetType: 'entity',
    targetId: row.target_id as string,
    sourceEntityId: row.source_id as string,
    targetEntityId: row.target_id as string,
    relation: row.relation as string,
    weight: row.weight as number,
    metadata: parseJson(row.properties),
    scope: rowToIdentity(row),
    evidence: row.evidence as string[] ?? [],
    temporal: {
      validAt: new Date(row.valid_at as string),
      invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
      expiredAt: row.expired_at ? new Date(row.expired_at as string) : undefined,
    },
    supersessionKey: (row.supersession_key as string | null) ?? undefined,
    supersededById: (row.superseded_by_id as string | null) ?? undefined,
    supersededAt: row.superseded_at ? new Date(row.superseded_at as string) : undefined,
  }
}

function mapRowToFact(row: Record<string, unknown>): SemanticFactRecord {
  return {
    id: row.id as string,
    graphId: (row.graph_id as string | null) ?? 'public',
    edgeId: row.edge_id as string,
    sourceEntityId: row.source_entity_id as string,
    targetEntityId: row.target_entity_id as string,
    relation: row.relation as string,
    description: (row.description as string | null) ?? (row.fact_text as string | null) ?? undefined,
    evidenceText: (row.evidence_text as string | null) ?? undefined,
    chunkId: (row.from_chunk_id as string | null) ?? undefined,
    weight: row.weight as number,
    embedding: undefined,
    scope: rowToIdentity(row),
    validAt: new Date(row.valid_at as string),
    invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    expiredAt: row.expired_at ? new Date(row.expired_at as string) : undefined,
    supersessionKey: (row.supersession_key as string | null) ?? undefined,
    supersededById: (row.superseded_by_id as string | null) ?? undefined,
    supersededAt: row.superseded_at ? new Date(row.superseded_at as string) : undefined,
    similarity: (row.similarity as number | null) ?? undefined,
  }
}

function mapRowToEntityChunkEdge(row: Record<string, unknown>): SemanticEntityChunkEdge {
  const props = parseJson(row.properties)
  return {
    id: row.id as string,
    graphId: (row.graph_id as string | null) ?? 'public',
    entityId: row.source_id as string,
    chunkRef: {
      bucketId: row.to_bucket_id as string,
      documentId: row.to_document_id as string,
      chunkIndex: row.to_chunk_index as number,
      embeddingModel: (row.to_embedding_model as string | null) ?? undefined,
      chunkId: (row.to_chunk_id as string | null) ?? undefined,
    },
    weight: row.weight as number,
    mentionCount: Number(props.mentionCount ?? 1),
    confidence: typeof props.confidence === 'number' ? props.confidence : undefined,
    surfaceTexts: Array.isArray(props.surfaceTexts) ? props.surfaceTexts as string[] : [],
    mentionTypes: Array.isArray(props.mentionTypes) ? props.mentionTypes as SemanticEntityChunkEdge['mentionTypes'] : [],
    scope: rowToIdentity(row),
    createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at as string) : undefined,
  }
}

function mapRowToChunkBackfillRecord(row: Record<string, unknown>): ChunkBackfillRecord {
  return {
    chunkId: row.chunk_id as string,
    bucketId: row.bucket_id as string,
    documentId: row.document_id as string,
    chunkIndex: row.chunk_index as number,
    embeddingModel: row.embedding_model as string,
    content: row.content as string,
    metadata: parseJson(row.metadata),
    graphId: (row.graph_id as string | null) ?? 'public',
    tenantId: (row.tenant_id as string) ?? undefined,
    organizationId: (row.organization_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    threadId: (row.thread_id as string) ?? undefined,
  }
}

function mapRowToChunkContent(row: Record<string, unknown>): SemanticChunkRecord {
  return {
    chunkId: (row.chunk_id as string | null) ?? undefined,
    content: row.content as string,
    bucketId: row.bucket_id as string,
    documentId: row.document_id as string,
    chunkIndex: row.chunk_index as number,
    embeddingModel: (row.embedding_model as string | null) ?? undefined,
    totalChunks: row.total_chunks as number,
    metadata: parseJson(row.metadata),
    graphId: (row.graph_id as string | null) ?? 'public',
    tenantId: (row.tenant_id as string) ?? undefined,
    organizationId: (row.organization_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    threadId: (row.thread_id as string) ?? undefined,
  }
}

// ── Helpers ──

function entityDetailFromSemanticEntity(entity: SemanticEntity): MergeGraphEntitiesResult['target'] {
  return {
    id: entity.id,
    name: entity.name,
    entityType: entity.entityType,
    aliases: entity.aliases,
    externalIds: entity.externalIds,
    edgeCount: 0,
    metadata: entity.metadata,
    description: entity.metadata.description as string | undefined,
    createdAt: entity.temporal.createdAt,
    validAt: entity.temporal.validAt,
    invalidAt: entity.temporal.invalidAt,
    topEdges: [],
  }
}

function arrayProperty(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function parseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'string') return JSON.parse(val)
  return (val ?? {}) as Record<string, unknown>
}

/** Parse a pgvector string "[0.1,0.2,0.3]" into a number[], or return undefined if null/missing. */
function parseVectorString(val: unknown): number[] | undefined {
  if (val == null) return undefined
  if (typeof val === 'string') {
    const trimmed = val.replace(/^\[|\]$/g, '')
    if (!trimmed) return undefined
    return trimmed.split(',').map(Number)
  }
  return undefined
}

function graphPreferenceRank(scope?: TypeGraphStorageIdentity): (graphId: string | undefined) => number {
  const ordered = scope?.graphIds && scope.graphIds.length > 0
    ? scope.graphIds
    : scope?.graphId
      ? [scope.graphId]
      : ['public']
  const rank = new Map(ordered.map((graphId, index) => [graphId, index]))
  return (graphId) => rank.get(graphId ?? 'public') ?? Number.MAX_SAFE_INTEGER
}

function dedupeEntitiesByGraphPreference(entities: SemanticEntity[], scope?: TypeGraphStorageIdentity): SemanticEntity[] {
  const rank = graphPreferenceRank(scope)
  const byId = new Map<string, SemanticEntity>()
  for (const entity of entities) {
    const existing = byId.get(entity.id)
    if (!existing || rank(entity.graphId) < rank(existing.graphId)) {
      byId.set(entity.id, entity)
    }
  }
  return [...byId.values()]
}

function normalizeEntityText(value: string): string {
  return value
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeExternalIdValue(id: string, type: string, encoding: ExternalId['encoding']): string {
  const trimmed = id.trim()
  if (encoding === 'sha256') return trimmed.toLowerCase()
  if (type === 'email' || type.endsWith('_email') || type === 'github_handle') {
    return trimmed.toLowerCase()
  }
  if (type === 'phone') {
    return trimmed.replace(/[^\s+]/g, '')
  }
  return trimmed
}

function normalizeExternalId(
  externalId: ExternalId,
): (ExternalId & { normalizedValue: string; encoding: NonNullable<ExternalId['encoding']> }) | undefined {
  const type = externalId.type.trim().toLowerCase()
  const id = externalId.id.trim()
  if (!id || !type) return undefined
  const encoding = externalId.encoding ?? 'none'
  return {
    ...externalId,
    id,
    type,
    encoding,
    normalizedValue: normalizeExternalIdValue(id, type, encoding),
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildMemoryWhere(
  filter: MemoryFilter,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`

  if (filter.ids) {
    if (filter.ids.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.ids)
      conditions.push(`id = ANY(${p()}::text[])`)
    }
  }

  // Compatibility identity filtering. filter.scope is an alias for explicit fields.
  if (filter.tenantId) {
    params.push(filter.tenantId)
    conditions.push(`tenant_id = ${p()}`)
  } else if (filter.scope?.tenantId) {
    params.push(filter.scope.tenantId)
    conditions.push(`tenant_id = ${p()}`)
  }
  if (filter.scope?.organizationId) {
    params.push(filter.scope.organizationId)
    conditions.push(`organization_id = ${p()}`)
  }
  if (filter.groupId) {
    params.push(filter.groupId)
    conditions.push(`group_id = ${p()}`)
  } else if (filter.scope?.groupId) {
    params.push(filter.scope.groupId)
    conditions.push(`group_id = ${p()}`)
  }
  if (filter.userId) {
    params.push(filter.userId)
    conditions.push(`user_id = ${p()}`)
  } else if (filter.scope?.userId) {
    params.push(filter.scope.userId)
    conditions.push(`user_id = ${p()}`)
  }
  if (filter.agentId) {
    params.push(filter.agentId)
    conditions.push(`agent_id = ${p()}`)
  } else if (filter.scope?.agentId) {
    params.push(filter.scope.agentId)
    conditions.push(`agent_id = ${p()}`)
  }
  if (filter.threadId) {
    params.push(filter.threadId)
    conditions.push(`thread_id = ${p()}`)
  } else if (filter.scope?.threadId) {
    params.push(filter.scope.threadId)
    conditions.push(`thread_id = ${p()}`)
  }
  if (filter.graphIds) {
    if (filter.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.graphIds)
      conditions.push(`graph_id = ANY(${p()}::text[])`)
    }
  } else if (filter.graphId) {
    params.push(filter.graphId)
    conditions.push(`graph_id = ${p()}`)
  } else if (filter.scope?.graphId) {
    params.push(filter.scope.graphId)
    conditions.push(`graph_id = ${p()}`)
  }
  if (filter.category) {
    if (Array.isArray(filter.category)) {
      params.push(filter.category)
      conditions.push(`category = ANY(${p()}::text[])`)
    } else {
      params.push(filter.category)
      conditions.push(`category = ${p()}`)
    }
  }
  if (filter.status) {
    if (Array.isArray(filter.status)) {
      params.push(filter.status)
      conditions.push(`status = ANY(${p()}::text[])`)
    } else {
      params.push(filter.status)
      conditions.push(`status = ${p()}`)
    }
  }
  if (filter.activeAt) {
    params.push(filter.activeAt.toISOString())
    conditions.push(`valid_at <= ${p()}`)
    conditions.push(`(invalid_at IS NULL OR invalid_at > $${paramOffset + params.length})`)
  }
  if (filter.minImportance !== undefined) {
    params.push(filter.minImportance)
    conditions.push(`importance >= ${p()}`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function buildArtifactWhere(
  filter: MemoryArtifactFilter,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`
  const identity = filter.identity

  params.push(identity.tenantId ?? 'public')
  conditions.push(`tenant_id = ${p()}`)

  const graphIds = filter.graphIds
    ?? identity.graphIds
    ?? (identity.graphId ? [identity.graphId] : ['public'])
  if (graphIds.length === 0) {
    conditions.push('FALSE')
  } else {
    params.push(graphIds)
    conditions.push(`graph_id = ANY(${p()}::text[])`)
  }

  if (filter.layoutId) {
    params.push(filter.layoutId)
    conditions.push(`layout_id = ${p()}`)
  }
  if (filter.path) {
    params.push(filter.path)
    conditions.push(`path = ${p()}`)
  }
  if (filter.prefix) {
    params.push(`${escapeLike(filter.prefix)}%`)
    conditions.push(`path LIKE ${p()} ESCAPE '\\'`)
  }
  if (filter.kind) {
    if (Array.isArray(filter.kind)) {
      if (filter.kind.length === 0) {
        conditions.push('FALSE')
      } else {
        params.push(filter.kind)
        conditions.push(`kind = ANY(${p()}::text[])`)
      }
    } else {
      params.push(filter.kind)
      conditions.push(`kind = ${p()}`)
    }
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

/**
 * Build WHERE conditions from a TypeGraphStorageIdentity for entity/edge queries.
 * Only adds conditions for non-null identity fields.
 */
function buildIdentityWhere(
  identity: TypeGraphStorageIdentity,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`

  if (identity.tenantId) { params.push(identity.tenantId); conditions.push(`tenant_id = ${p()}`) }
  if (identity.organizationId) { params.push(identity.organizationId); conditions.push(`organization_id = ${p()}`) }
  if (identity.groupId) { params.push(identity.groupId); conditions.push(`group_id = ${p()}`) }
  if (identity.userId) { params.push(identity.userId); conditions.push(`user_id = ${p()}`) }
  if (identity.agentId) { params.push(identity.agentId); conditions.push(`agent_id = ${p()}`) }
  if (identity.threadId) { params.push(identity.threadId); conditions.push(`thread_id = ${p()}`) }
  if (identity.graphIds) {
    if (identity.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(identity.graphIds)
      conditions.push(`graph_id = ANY(${p()}::text[])`)
    }
  } else if (identity.graphId) {
    params.push(identity.graphId)
    conditions.push(`graph_id = ${p()}`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function buildGraphVisibilityWhere(
  identity: TypeGraphStorageIdentity | undefined,
  paramOffset = 0,
  alias?: string,
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`
  const col = (name: string) => alias ? `${alias}.${name}` : name

  if (identity?.tenantId) {
    params.push(identity.tenantId)
    conditions.push(`${col('tenant_id')} = ${p()}`)
  }
  if (identity?.graphIds) {
    if (identity.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(identity.graphIds)
      conditions.push(`${col('graph_id')} = ANY(${p()}::text[])`)
    }
  } else if (identity?.graphId) {
    params.push(identity.graphId)
    conditions.push(`${col('graph_id')} = ${p()}`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function dateParam(value: unknown, fallbackNow = false): string | undefined {
  if (value === undefined || value === null) return fallbackNow ? new Date().toISOString() : undefined
  if (value === 'now') return new Date().toISOString()
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined
    return value.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return undefined
}

function buildGraphTemporalWhere(
  temporal: GraphTemporalQueryOptions | undefined,
  paramOffset = 0,
  alias?: string,
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`
  const col = (name: string) => alias ? `${alias}.${name}` : name

  const range = temporal?.validBetween as unknown
  if (Array.isArray(range) && range.length >= 2) {
    const start = dateParam(range[0])
    const end = dateParam(range[1])
    if (start && end) {
      params.push(end)
      conditions.push(`${col('valid_at')} <= ${p()}::timestamptz`)
      params.push(start)
      const startParam = p()
      conditions.push(`(${col('invalid_at')} IS NULL OR ${col('invalid_at')} > ${startParam}::timestamptz)`)
      conditions.push(`(${col('expired_at')} IS NULL OR ${col('expired_at')} > ${startParam}::timestamptz)`)
    }
  } else if (temporal?.includeInvalidated !== true) {
    const asOf = dateParam(temporal?.asOf, true)!
    params.push(asOf)
    const asOfParam = p()
    conditions.push(`${col('valid_at')} <= ${asOfParam}::timestamptz`)
    conditions.push(`(${col('invalid_at')} IS NULL OR ${col('invalid_at')} > ${asOfParam}::timestamptz)`)
    conditions.push(`(${col('expired_at')} IS NULL OR ${col('expired_at')} > ${asOfParam}::timestamptz)`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function buildAliasedIdentityWhere(
  alias: string,
  identity: TypeGraphStorageIdentity,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const base = buildIdentityWhere(identity, paramOffset)
  if (!base.where) return base
  return {
    where: base.where.replace(/\b(tenant_id|organization_id|group_id|user_id|agent_id|thread_id|graph_id)\b/g, `${alias}.$1`),
    params: base.params,
  }
}

/**
 * Extract identity from a DB row's explicit columns.
 */
function rowToIdentity(row: Record<string, unknown>): TypeGraphStorageIdentity {
  const id: TypeGraphStorageIdentity = {}
  if (row.tenant_id) id.tenantId = row.tenant_id as string
  if (row.organization_id) id.organizationId = row.organization_id as string
  if (row.group_id) id.groupId = row.group_id as string
  if (row.user_id) id.userId = row.user_id as string
  if (row.agent_id) id.agentId = row.agent_id as string
  if (row.thread_id) id.threadId = row.thread_id as string
  if (row.graph_id) id.graphId = row.graph_id as string
  return id
}
