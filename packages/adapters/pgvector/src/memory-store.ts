/**
 * PostgreSQL + pgvector implementation of MemoryStoreAdapter.
 * Provides persistent storage for memories, semantic entities, and edges.
 *
 * Uses the same SqlExecutor pattern as @typegraph-ai/adapter-pgvector for
 * driver-agnostic Postgres access (Neon, node-postgres, Drizzle, etc.).
 */

import type {
  MemoryStoreAdapter,
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
  typegraphIdentity,
  MergeGraphEntitiesInput,
  MergeGraphEntitiesResult,
  DeleteGraphEntityOpts,
  DeleteGraphEntityResult,
} from '@typegraph-ai/sdk'
import { generateId } from '@typegraph-ai/sdk'

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

const MEMORIES_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT PRIMARY KEY,
    category         TEXT NOT NULL CHECK (category IN ('episodic', 'semantic', 'procedural')),
    status           TEXT NOT NULL DEFAULT 'pending',
    content          TEXT NOT NULL,
    embedding        VECTOR,
    importance       REAL NOT NULL DEFAULT 0.5,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata         JSONB NOT NULL DEFAULT '{}',
    scope            JSONB NOT NULL DEFAULT '{}',
    -- Identity columns
    tenant_id        TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    conversation_id       TEXT,
    visibility       TEXT CHECK (visibility IS NULL OR visibility IN ('tenant', 'group', 'user', 'agent', 'conversation')),
    -- Episodic
    event_type       TEXT,
    participants     TEXT[],
    episodic_conversation_id TEXT,
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
    search_vector    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
  );

  CREATE INDEX IF NOT EXISTS ${idx('category_idx')} ON ${t} (category);
  CREATE INDEX IF NOT EXISTS ${idx('status_idx')} ON ${t} (status);
  CREATE INDEX IF NOT EXISTS ${idx('subject_idx')} ON ${t} (subject);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')} ON ${t} (tenant_id, conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('conversation_idx')} ON ${t} (conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
  CREATE INDEX IF NOT EXISTS ${idx('search_vector_idx')} ON ${t} USING gin (search_vector);
`
}

const ENTITIES_DDL = (t: string, dims?: number) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    aliases     TEXT[] DEFAULT '{}',
    properties  JSONB NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'invalidated')),
    merged_into_entity_id TEXT,
    deleted_at  TIMESTAMPTZ,
    embedding   VECTOR${dims ? `(${dims})` : ''},
    description_embedding VECTOR${dims ? `(${dims})` : ''},
    scope       JSONB NOT NULL DEFAULT '{}',
    -- Identity columns
    tenant_id   TEXT,
    group_id    TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    conversation_id  TEXT,
    visibility  TEXT CHECK (visibility IS NULL OR visibility IN ('tenant', 'group', 'user', 'agent', 'conversation')),
    valid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('name_idx')} ON ${t} (name);
  CREATE INDEX IF NOT EXISTS ${idx('type_idx')} ON ${t} (entity_type);
  CREATE INDEX IF NOT EXISTS ${idx('status_idx')} ON ${t} (status);
  CREATE INDEX IF NOT EXISTS ${idx('merged_into_idx')} ON ${t} (merged_into_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')} ON ${t} (tenant_id, conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('conversation_idx')} ON ${t} (conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
`
}

const ENTITY_EXTERNAL_IDS_DDL = (t: string, entitiesTable: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT PRIMARY KEY,
    entity_id        TEXT NOT NULL REFERENCES ${entitiesTable}(id) ON DELETE CASCADE,
    identity_type    TEXT NOT NULL CHECK (identity_type IN ('tenant', 'group', 'user', 'agent', 'conversation', 'entity')),
    type             TEXT NOT NULL,
    id_value         TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    encoding         TEXT NOT NULL DEFAULT 'none' CHECK (encoding IN ('none', 'sha256')),
    metadata         JSONB NOT NULL DEFAULT '{}',
    scope            JSONB NOT NULL DEFAULT '{}',
    tenant_id        TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    conversation_id  TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('entity_idx')} ON ${t} (entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('lookup_idx')} ON ${t} (identity_type, type, normalized_value, encoding);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')} ON ${t} (tenant_id, conversation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS ${idx('scoped_external_id_uniq_idx')}
    ON ${t} (
      identity_type,
      type,
      normalized_value,
      encoding,
      COALESCE(tenant_id, ''),
      COALESCE(group_id, ''),
      COALESCE(user_id, ''),
      COALESCE(agent_id, ''),
      COALESCE(conversation_id, '')
    );
`
}

const EDGES_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT PRIMARY KEY,
    source_type      TEXT NOT NULL CHECK (source_type IN ('entity', 'chunk', 'memory')),
    source_id        TEXT NOT NULL,
    target_type      TEXT NOT NULL CHECK (target_type IN ('entity', 'chunk', 'memory')),
    target_id        TEXT NOT NULL,
    relation         TEXT NOT NULL,
    weight           REAL NOT NULL DEFAULT 1.0,
    properties       JSONB NOT NULL DEFAULT '{}',
    scope            JSONB NOT NULL DEFAULT '{}',
    source_bucket_id       TEXT,
    source_document_id     TEXT,
    source_chunk_index     INTEGER,
    source_embedding_model TEXT,
    source_chunk_id        TEXT,
    target_bucket_id       TEXT,
    target_document_id     TEXT,
    target_chunk_index     INTEGER,
    target_embedding_model TEXT,
    target_chunk_id        TEXT,
    -- Identity columns
    tenant_id        TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    conversation_id       TEXT,
    visibility       TEXT CHECK (visibility IS NULL OR visibility IN ('tenant', 'group', 'user', 'agent', 'conversation')),
    evidence         TEXT[] DEFAULT '{}',
    valid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ${safeIdx(i, 'rel_uniq')} UNIQUE (source_type, source_id, target_type, target_id, relation)
  );

  CREATE INDEX IF NOT EXISTS ${idx('source_idx')} ON ${t} (source_type, source_id);
  CREATE INDEX IF NOT EXISTS ${idx('target_idx')} ON ${t} (target_type, target_id);
  CREATE INDEX IF NOT EXISTS ${idx('entity_source_idx')} ON ${t} (source_id) WHERE source_type = 'entity';
  CREATE INDEX IF NOT EXISTS ${idx('entity_target_idx')} ON ${t} (target_id) WHERE target_type = 'entity';
  CREATE INDEX IF NOT EXISTS ${idx('memory_source_idx')} ON ${t} (source_id) WHERE source_type = 'memory';
  CREATE INDEX IF NOT EXISTS ${idx('memory_target_idx')} ON ${t} (target_id) WHERE target_type = 'memory';
  CREATE INDEX IF NOT EXISTS ${idx('target_chunk_ref_idx')} ON ${t} (target_bucket_id, target_document_id, target_chunk_index) WHERE target_type = 'chunk';
  CREATE INDEX IF NOT EXISTS ${idx('source_chunk_ref_idx')} ON ${t} (source_bucket_id, source_document_id, source_chunk_index) WHERE source_type = 'chunk';
  CREATE INDEX IF NOT EXISTS ${idx('relation_idx')} ON ${t} (relation);
  CREATE INDEX IF NOT EXISTS ${idx('invalid_at_idx')} ON ${t} (invalid_at);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')} ON ${t} (tenant_id, conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('conversation_idx')} ON ${t} (conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
`
}

const CHUNK_MENTIONS_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id              TEXT PRIMARY KEY,
    entity_id       TEXT NOT NULL,
    document_id     TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    bucket_id       TEXT NOT NULL,
    mention_type    TEXT NOT NULL
                    CHECK (mention_type IN ('subject', 'object', 'co_occurrence', 'entity', 'alias')),
    surface_text    TEXT,
    normalized_surface_text TEXT NOT NULL DEFAULT '',
    confidence      REAL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('entity_idx')} ON ${t} (entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('chunk_idx')} ON ${t} (document_id, chunk_index);
  CREATE INDEX IF NOT EXISTS ${idx('bucket_entity_idx')} ON ${t} (bucket_id, entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('surface_idx')} ON ${t} (normalized_surface_text);
  CREATE UNIQUE INDEX IF NOT EXISTS ${idx('mention_uniq_idx')}
    ON ${t} (entity_id, document_id, chunk_index, mention_type, normalized_surface_text);
`
}

const FACT_RECORDS_DDL = (t: string, dims?: number) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT PRIMARY KEY,
    edge_id          TEXT NOT NULL UNIQUE,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation         TEXT NOT NULL,
    fact_text        TEXT NOT NULL,
    description      TEXT,
    evidence_text    TEXT,
    fact_search_text TEXT NOT NULL,
    source_chunk_id  TEXT,
    weight           REAL NOT NULL DEFAULT 1.0,
    evidence_count   INTEGER NOT NULL DEFAULT 1,
    embedding        VECTOR${dims ? `(${dims})` : ''},
    scope            JSONB NOT NULL DEFAULT '{}',
    tenant_id        TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    conversation_id  TEXT,
    visibility       TEXT CHECK (visibility IS NULL OR visibility IN ('tenant', 'group', 'user', 'agent', 'conversation')),
    invalid_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', fact_search_text)) STORED
  );

  CREATE INDEX IF NOT EXISTS ${idx('source_idx')} ON ${t} (source_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('target_idx')} ON ${t} (target_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('relation_idx')} ON ${t} (relation);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')} ON ${t} (tenant_id, conversation_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
  CREATE INDEX IF NOT EXISTS ${idx('embedding_idx')} ON ${t} USING hnsw (embedding vector_cosine_ops);
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
      MEMORIES_DDL(this.memoriesTable),

      ENTITIES_DDL(this.entitiesTable, this.embeddingDimensions),
      ENTITY_EXTERNAL_IDS_DDL(this.entityExternalIdsTable, this.entitiesTable),
      EDGES_DDL(this.edgesTable),
      CHUNK_MENTIONS_DDL(this.chunkMentionsTable),
      FACT_RECORDS_DDL(this.factRecordsTable, this.embeddingDimensions),
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
    await this.ensureChunkMentionShape()
    await this.ensureEntityMaintenanceShape()
    await this.ensureFactRecordsShape()

    // Try to create HNSW indexes on entity and memory embeddings.
    // May fail if tables are empty (no embedding dimensions known yet).
    // In that case, created lazily after first entity/memory with embedding is inserted.
    await this.ensureHnswIndex('entity')
    await this.ensureHnswIndex('memory')
  }

  /**
   * SQL executor with auto-recovery on missing tables. On PG error 42P01
   * (undefined_table), calls initialize() to create the missing table and
   * retries the query once. Adds one try/catch on the happy path — no
   * existence checks — so hot paths remain unaffected.
   */
  private async sqlWithRetry(
    query: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> {
    try {
      return await this.sql(query, params)
    } catch (err) {
      const code = (err as { code?: string })?.code
      const msg = err instanceof Error ? err.message : String(err)
      if (code === '42P01' || /relation .* does not exist/i.test(msg)) {
        await this.initialize()
        return await this.sql(query, params)
      }
      throw err
    }
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
    try {
      await this.sql(
        `ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector(${this.embeddingDimensions})`
      )
    } catch (err) {
      // Column may already be typed — log at debug level in case it's a real error
      console.debug('[typegraph] ALTER TABLE embedding type (may already be typed):', err instanceof Error ? err.message : err)
    }
    const idxName = safeIdx(idxPrefix(table), 'embedding_idx')
    try {
      await this.sql(
        `CREATE INDEX IF NOT EXISTS ${idxName}
         ON ${table} USING hnsw (embedding vector_cosine_ops)
         WITH (m = 16, ef_construction = 200)`
      )
      if (target === 'entity') this.hnswEntityIndexCreated = true
      else this.hnswMemoryIndexCreated = true
    } catch (err: unknown) {
      console.warn(`[typegraph] HNSW index creation on ${table} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async ensureChunkMentionShape(): Promise<void> {
    const i = idxPrefix(this.chunkMentionsTable)
    await this.sql(`ALTER TABLE ${this.chunkMentionsTable} ADD COLUMN IF NOT EXISTS surface_text TEXT`)
    await this.sql(`ALTER TABLE ${this.chunkMentionsTable} ADD COLUMN IF NOT EXISTS normalized_surface_text TEXT NOT NULL DEFAULT ''`)
    await this.sql(`ALTER TABLE ${this.chunkMentionsTable} DROP CONSTRAINT IF EXISTS ${safeIdx(i, 'mention_uniq')}`)
    const mentionTypeChecks = await this.sql(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = $1::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%mention_type%'`,
      [this.chunkMentionsTable]
    )
    for (const row of mentionTypeChecks) {
      await this.sql(`ALTER TABLE ${this.chunkMentionsTable} DROP CONSTRAINT IF EXISTS ${quoteIdent(row.conname as string)}`)
    }
    const mentionTypeCheck = safeIdx(i, 'mention_type_check')
    await this.sql(
      `ALTER TABLE ${this.chunkMentionsTable}
       ADD CONSTRAINT ${mentionTypeCheck}
       CHECK (mention_type IN ('subject', 'object', 'co_occurrence', 'entity', 'alias')) NOT VALID`
    )
    await this.sql(`ALTER TABLE ${this.chunkMentionsTable} VALIDATE CONSTRAINT ${mentionTypeCheck}`)
    await this.sql(`CREATE INDEX IF NOT EXISTS ${safeIdx(i, 'surface_idx')} ON ${this.chunkMentionsTable} (normalized_surface_text)`)
    await this.sql(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${safeIdx(i, 'mention_uniq_idx')}
       ON ${this.chunkMentionsTable} (entity_id, document_id, chunk_index, mention_type, normalized_surface_text)`
    )
  }

  private async ensureEntityMaintenanceShape(): Promise<void> {
    const i = idxPrefix(this.entitiesTable)
    await this.sql(`ALTER TABLE ${this.entitiesTable} ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`)
    await this.sql(`ALTER TABLE ${this.entitiesTable} ADD COLUMN IF NOT EXISTS merged_into_entity_id TEXT`)
    await this.sql(`ALTER TABLE ${this.entitiesTable} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`)
    await this.sql(`CREATE INDEX IF NOT EXISTS ${safeIdx(i, 'status_idx')} ON ${this.entitiesTable} (status)`)
    await this.sql(`CREATE INDEX IF NOT EXISTS ${safeIdx(i, 'merged_into_idx')} ON ${this.entitiesTable} (merged_into_entity_id)`)
  }

  private async ensureFactRecordsShape(): Promise<void> {
    const i = idxPrefix(this.factRecordsTable)
    await this.sql(`ALTER TABLE ${this.factRecordsTable} ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ`)
    await this.sql(
      `ALTER TABLE ${this.factRecordsTable}
       ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
       GENERATED ALWAYS AS (to_tsvector('english', fact_search_text)) STORED`
    )
    await this.sql(`CREATE INDEX IF NOT EXISTS ${safeIdx(i, 'invalid_at_idx')} ON ${this.factRecordsTable} (invalid_at)`)
    await this.sql(`CREATE INDEX IF NOT EXISTS ${safeIdx(i, 'search_vector_idx')} ON ${this.factRecordsTable} USING gin (search_vector)`)
  }

  // ── CRUD ──

  async upsert(record: MemoryRecord): Promise<MemoryRecord> {
    const embeddingStr = record.embedding ? `[${record.embedding.join(',')}]` : null
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.memoriesTable}
        (id, category, status, content, embedding, importance, access_count,
         last_accessed_at, metadata, scope,
         tenant_id, group_id, user_id, agent_id, conversation_id, visibility,
         event_type, participants, episodic_conversation_id, sequence, consolidated_at,
         subject, predicate, object, confidence, source_memory_ids,
         trigger, steps, success_count, failure_count, last_outcome,
         valid_at, invalid_at, expired_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
               $27,$28,$29,$30,$31,$32,$33,$34,NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, content = EXCLUDED.content,
         embedding = EXCLUDED.embedding, importance = EXCLUDED.importance,
         access_count = EXCLUDED.access_count, last_accessed_at = EXCLUDED.last_accessed_at,
         metadata = EXCLUDED.metadata, scope = EXCLUDED.scope,
         tenant_id = EXCLUDED.tenant_id, group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
         conversation_id = EXCLUDED.conversation_id, visibility = EXCLUDED.visibility,
         event_type = EXCLUDED.event_type, participants = EXCLUDED.participants,
         episodic_conversation_id = EXCLUDED.episodic_conversation_id, sequence = EXCLUDED.sequence,
         consolidated_at = EXCLUDED.consolidated_at,
         subject = EXCLUDED.subject, predicate = EXCLUDED.predicate,
         object = EXCLUDED.object, confidence = EXCLUDED.confidence,
         source_memory_ids = EXCLUDED.source_memory_ids,
         trigger = EXCLUDED.trigger, steps = EXCLUDED.steps,
         success_count = EXCLUDED.success_count, failure_count = EXCLUDED.failure_count,
         last_outcome = EXCLUDED.last_outcome,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at, updated_at = NOW()
       RETURNING *`,
      [
        record.id, record.category, record.status, record.content,
        embeddingStr, record.importance, record.accessCount,
        record.lastAccessedAt.toISOString(),
        JSON.stringify(record.metadata), JSON.stringify(record.scope),
        // Identity
        record.scope.tenantId ?? null,
        record.scope.groupId ?? null,
        record.scope.userId ?? null,
        record.scope.agentId ?? null,
        record.scope.conversationId ?? null,
        record.visibility ?? null,
        // Episodic
        (record as any).eventType ?? null,
        (record as any).participants ?? null,
        (record as any).conversationId ?? null,  // episodic conversationId → episodic_conversation_id column
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
    const rows = await this.sqlWithRetry(`SELECT * FROM ${this.memoriesTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToMemory(rows[0]!) : null
  }

  async list(filter: MemoryFilter, limit?: number): Promise<MemoryRecord[]> {
    const { where, params } = buildMemoryWhere(filter)
    const whereClause = where ? `WHERE ${where}` : ''
    params.push(limit ?? 100)
    const rows = await this.sqlWithRetry(
      `SELECT * FROM ${this.memoriesTable} ${whereClause}
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
    // Return the record itself — in a full bi-temporal system, we'd
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
      `SELECT *, 1 - (embedding <=> $${params.length - 1}::vector) AS similarity
       FROM ${this.memoriesTable}
       ${whereClause}
       ORDER BY embedding <=> $${params.length - 1}::vector
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
        SELECT *, 1 - (embedding <=> $${vecParamIdx}::vector) AS similarity,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $${vecParamIdx}::vector) AS vrank
        FROM ${this.memoriesTable}
        ${whereClause}
        ORDER BY embedding <=> $${vecParamIdx}::vector
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
      SELECT v.*,
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

  // ── Entity Storage ──

  private async attachExternalIds(entities: SemanticEntity[]): Promise<SemanticEntity[]> {
    if (entities.length === 0) return entities
    const rows = await this.sqlWithRetry(
      `SELECT entity_id, identity_type, type, id_value, encoding, metadata
         FROM ${this.entityExternalIdsTable}
        WHERE entity_id = ANY($1::text[])
        ORDER BY created_at ASC`,
      [entities.map(entity => entity.id)]
    )
    const byEntity = new Map<string, ExternalId[]>()
    for (const row of rows) {
      const entityId = row.entity_id as string
      const externalId: ExternalId = {
        identityType: row.identity_type as ExternalId['identityType'],
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
    const { _similarity, ...cleanProps } = entity.properties
    const tbl = unqualified(this.entitiesTable)
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.entitiesTable}
        (id, name, entity_type, aliases, properties, status, merged_into_entity_id, deleted_at, embedding, description_embedding, scope,
         tenant_id, group_id, user_id, agent_id, conversation_id, visibility,
         valid_at, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10::vector,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
         aliases = EXCLUDED.aliases, properties = EXCLUDED.properties,
         status = EXCLUDED.status,
         merged_into_entity_id = EXCLUDED.merged_into_entity_id,
         deleted_at = EXCLUDED.deleted_at,
         embedding = COALESCE(EXCLUDED.embedding, ${tbl}.embedding),
         description_embedding = COALESCE(EXCLUDED.description_embedding, ${tbl}.description_embedding),
         scope = EXCLUDED.scope,
         tenant_id = EXCLUDED.tenant_id, group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
         conversation_id = EXCLUDED.conversation_id, visibility = EXCLUDED.visibility,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at, updated_at = NOW()
       RETURNING *`,
      [
        entity.id, entity.name, entity.entityType,
        entity.aliases, JSON.stringify(cleanProps),
        entity.status ?? 'active',
        entity.mergedIntoEntityId ?? null,
        entity.deletedAt?.toISOString() ?? null,
        embeddingStr, descEmbeddingStr, JSON.stringify(entity.scope),
        entity.scope.tenantId ?? null,
        entity.scope.groupId ?? null,
        entity.scope.userId ?? null,
        entity.scope.agentId ?? null,
        entity.scope.conversationId ?? null,
        entity.visibility ?? null,
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

  async upsertEntityExternalIds(entityId: string, externalIds: ExternalId[], scope: typegraphIdentity): Promise<void> {
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
        normalized.identityType,
        normalized.type,
        normalized.id,
        normalized.normalizedValue,
        normalized.encoding,
        JSON.stringify(normalized.metadata ?? {}),
        JSON.stringify(scope),
        scope.tenantId ?? null,
        scope.groupId ?? null,
        scope.userId ?? null,
        scope.agentId ?? null,
        scope.conversationId ?? null,
      )
    }
    if (values.length === 0) return

    const tbl = unqualified(this.entityExternalIdsTable)
    const rows = await this.sqlWithRetry(
      `INSERT INTO ${this.entityExternalIdsTable}
        (id, entity_id, identity_type, type, id_value, normalized_value, encoding, metadata,
         scope, tenant_id, group_id, user_id, agent_id, conversation_id)
       VALUES ${values.join(',')}
       ON CONFLICT (
         identity_type,
         type,
         normalized_value,
         encoding,
         COALESCE(tenant_id, ''),
         COALESCE(group_id, ''),
         COALESCE(user_id, ''),
         COALESCE(agent_id, ''),
         COALESCE(conversation_id, '')
       ) DO UPDATE SET
         id_value = EXCLUDED.id_value,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       WHERE ${tbl}.entity_id = EXCLUDED.entity_id
       RETURNING id`,
      params
    )
    if (rows.length !== values.length) {
      throw new Error('One or more external IDs are already linked to a different entity')
    }
  }

  async findEntityByExternalId(externalId: ExternalId, scope?: typegraphIdentity): Promise<SemanticEntity | null> {
    const normalized = normalizeExternalId(externalId)
    if (!normalized) return null
    const identity = buildGraphVisibilityWhere(scope, 5, 'e')
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT e.id, e.name, e.entity_type, e.aliases, e.properties,
              e.status, e.merged_into_entity_id, e.deleted_at, e.scope,
              e.tenant_id, e.group_id, e.user_id, e.agent_id, e.conversation_id, e.visibility,
              e.valid_at, e.invalid_at, e.created_at, e.updated_at
         FROM ${this.entityExternalIdsTable} xid
         JOIN ${this.entitiesTable} e ON e.id = xid.entity_id
        WHERE xid.identity_type = $1
          AND xid.type = $2
          AND xid.normalized_value = $3
          AND xid.encoding = $4
          ${scopeClause}
          AND e.invalid_at IS NULL
          AND e.status = 'active'
        LIMIT 1`,
      [
        normalized.identityType,
        normalized.type,
        normalized.normalizedValue,
        normalized.encoding,
        ...identity.params,
      ]
    )
    if (rows.length === 0) return null
    const [mapped] = await this.attachExternalIds([mapRowToEntity(rows[0]!)])
    return mapped!
  }

  async getEntity(id: string, scope?: typegraphIdentity): Promise<SemanticEntity | null> {
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT id, name, entity_type, aliases, properties,
              status, merged_into_entity_id, deleted_at, scope,
              tenant_id, group_id, user_id, agent_id, conversation_id, visibility,
              valid_at, invalid_at, created_at, updated_at
       FROM ${this.entitiesTable}
       WHERE id = $1
         ${scopeClause}`,
      [id, ...identity.params]
    )
    if (rows.length === 0) return null
    const [mapped] = await this.attachExternalIds([mapRowToEntity(rows[0]!)])
    return mapped!
  }

  async getEntitiesBatch(ids: string[], scope?: typegraphIdentity): Promise<SemanticEntity[]> {
    if (ids.length === 0) return []
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT id, name, entity_type, aliases, properties,
              status, merged_into_entity_id, deleted_at, scope,
              tenant_id, group_id, user_id, agent_id, conversation_id, visibility,
              valid_at, invalid_at, created_at, updated_at
       FROM ${this.entitiesTable}
       WHERE id = ANY($1::text[])
         ${scopeClause}`,
      [ids, ...identity.params]
    )
    return this.attachExternalIds(rows.map(mapRowToEntity))
  }

  async findEntities(query: string, scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]> {
    const { where, params } = buildGraphVisibilityWhere(scope)
    const baseIdx = params.length
    params.push(`%${query}%`)
    const nameParam = `$${baseIdx + 1}`
    params.push(limit ?? 20)
    const limitParam = `$${baseIdx + 2}`
    const scopeClause = where ? ` AND ${where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT id, name, entity_type, aliases, properties,
              status, merged_into_entity_id, deleted_at, scope,
              tenant_id, group_id, user_id, agent_id, conversation_id, visibility,
              valid_at, invalid_at, created_at, updated_at
       FROM ${this.entitiesTable}
       WHERE (name ILIKE ${nameParam}
              OR EXISTS (SELECT 1 FROM unnest(aliases) AS a WHERE a ILIKE ${nameParam})
              OR EXISTS (
                SELECT 1 FROM ${this.chunkMentionsTable} m
                WHERE m.entity_id = ${this.entitiesTable}.id
                  AND m.surface_text ILIKE ${nameParam}
              ))
         ${scopeClause}
         AND invalid_at IS NULL
         AND status = 'active'
       LIMIT ${limitParam}`,
      params
    )
    return this.attachExternalIds(rows.map(mapRowToEntity))
  }

  async searchEntities(embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = where ? ` AND ${where}` : ''
    params.push(limit ?? 20)
    const limitParam = `$${1 + params.length}`
    const rows = await this.sqlWithRetry(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM ${this.entitiesTable}
       WHERE embedding IS NOT NULL
         AND invalid_at IS NULL
          AND status = 'active'
          ${scopeClause}
       ORDER BY embedding <=> $1::vector
       LIMIT ${limitParam}`,
      [vectorStr, ...params]
    )
    return this.attachExternalIds(rows.map(mapRowToEntity))
  }

  async searchEntitiesHybrid(query: string, embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]> {
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
      `SELECT e.*,
              GREATEST(
                CASE WHEN lower(e.name) = ${lowerParam} THEN 1.0 ELSE 0 END,
                CASE WHEN EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE lower(a) = ${lowerParam}) THEN 0.98 ELSE 0 END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM ${this.chunkMentionsTable} m
                  WHERE m.entity_id = e.id AND m.normalized_surface_text = ${normalizedParam}
                ) THEN 0.97 ELSE 0 END,
                CASE WHEN e.name ILIKE ${likeParam} THEN 0.88 ELSE 0 END,
                CASE WHEN EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE a ILIKE ${likeParam}) THEN 0.86 ELSE 0 END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM ${this.chunkMentionsTable} m
                  WHERE m.entity_id = e.id AND m.surface_text ILIKE ${likeParam}
                ) THEN 0.84 ELSE 0 END
              ) AS similarity
        FROM ${this.entitiesTable} e
        WHERE e.invalid_at IS NULL
          AND e.status = 'active'
          ${scopeClause}
          AND (
            lower(e.name) = ${lowerParam}
            OR EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE lower(a) = ${lowerParam})
            OR EXISTS (SELECT 1 FROM ${this.chunkMentionsTable} m WHERE m.entity_id = e.id AND m.normalized_surface_text = ${normalizedParam})
            OR e.name ILIKE ${likeParam}
            OR EXISTS (SELECT 1 FROM unnest(e.aliases) AS a WHERE a ILIKE ${likeParam})
            OR EXISTS (SELECT 1 FROM ${this.chunkMentionsTable} m WHERE m.entity_id = e.id AND m.surface_text ILIKE ${likeParam})
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
      `SELECT *,
              GREATEST(
                1 - (embedding <=> $1::vector),
                COALESCE(1 - (description_embedding <=> $1::vector), 0)
              ) AS similarity
        FROM ${this.entitiesTable}
        WHERE embedding IS NOT NULL
          ${vectorScopeClause}
          AND invalid_at IS NULL
          AND status = 'active'
        ORDER BY embedding <=> $1::vector
        LIMIT ${vectorLimitParam}`,
      [vectorStr, ...vectorWhere.params, maxRows * 3]
    )

    const byId = new Map<string, SemanticEntity>()
    for (const row of [...lexicalRows, ...vectorRows]) {
      const entity = mapRowToEntity(row)
      const existing = byId.get(entity.id)
      if (!existing || ((entity.properties._similarity as number | undefined) ?? 0) > ((existing.properties._similarity as number | undefined) ?? 0)) {
        byId.set(entity.id, entity)
      }
    }

    const merged = [...byId.values()]
      .sort((a, b) => ((b.properties._similarity as number | undefined) ?? 0) - ((a.properties._similarity as number | undefined) ?? 0))
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
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17},$${base + 18},$${base + 19},$${base + 20},$${base + 21},$${base + 22},$${base + 23},$${base + 24},$${base + 25},$${base + 26},$${base + 27},$${base + 28})`)
      params.push(
        edge.id,
        edge.sourceType,
        edge.sourceId,
        edge.targetType,
        edge.targetId,
        edge.relation,
        edge.weight,
        JSON.stringify(edge.properties ?? {}),
        JSON.stringify(scope),
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
        scope.tenantId ?? null,
        scope.groupId ?? null,
        scope.userId ?? null,
        scope.agentId ?? null,
        scope.conversationId ?? null,
        edge.visibility ?? null,
        edge.evidence ?? [],
        edge.temporal.validAt.toISOString(),
        edge.temporal.invalidAt?.toISOString() ?? null,
      )
    }

    const tbl = unqualified(this.edgesTable)
    await this.sqlWithRetry(
      `INSERT INTO ${this.edgesTable}
        (id, source_type, source_id, target_type, target_id, relation, weight, properties, scope,
         source_bucket_id, source_document_id, source_chunk_index, source_embedding_model, source_chunk_id,
         target_bucket_id, target_document_id, target_chunk_index, target_embedding_model, target_chunk_id,
         tenant_id, group_id, user_id, agent_id, conversation_id, visibility, evidence, valid_at, invalid_at)
       VALUES ${values.join(',')}
       ON CONFLICT (source_type, source_id, target_type, target_id, relation) DO UPDATE SET
         weight = LEAST(5.0, ${tbl}.weight + EXCLUDED.weight),
         properties = ${tbl}.properties || EXCLUDED.properties,
         scope = EXCLUDED.scope,
         source_bucket_id = COALESCE(EXCLUDED.source_bucket_id, ${tbl}.source_bucket_id),
         source_document_id = COALESCE(EXCLUDED.source_document_id, ${tbl}.source_document_id),
         source_chunk_index = COALESCE(EXCLUDED.source_chunk_index, ${tbl}.source_chunk_index),
         source_embedding_model = COALESCE(EXCLUDED.source_embedding_model, ${tbl}.source_embedding_model),
         source_chunk_id = COALESCE(EXCLUDED.source_chunk_id, ${tbl}.source_chunk_id),
         target_bucket_id = COALESCE(EXCLUDED.target_bucket_id, ${tbl}.target_bucket_id),
         target_document_id = COALESCE(EXCLUDED.target_document_id, ${tbl}.target_document_id),
         target_chunk_index = COALESCE(EXCLUDED.target_chunk_index, ${tbl}.target_chunk_index),
         target_embedding_model = COALESCE(EXCLUDED.target_embedding_model, ${tbl}.target_embedding_model),
         target_chunk_id = COALESCE(EXCLUDED.target_chunk_id, ${tbl}.target_chunk_id),
         tenant_id = EXCLUDED.tenant_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         conversation_id = EXCLUDED.conversation_id,
         visibility = EXCLUDED.visibility,
         evidence = ARRAY(SELECT DISTINCT v FROM unnest(${tbl}.evidence || EXCLUDED.evidence) AS v WHERE v <> ''),
         invalid_at = EXCLUDED.invalid_at,
         updated_at = NOW()`,
      params
    )
  }

  async upsertFactRecord(fact: SemanticFactRecord): Promise<SemanticFactRecord> {
    const embeddingStr = fact.embedding ? `[${fact.embedding.join(',')}]` : null
    const params = [
      fact.id,
      fact.edgeId,
      fact.sourceEntityId,
      fact.targetEntityId,
      fact.relation,
      fact.factText,
      fact.description ?? null,
      fact.evidenceText ?? null,
      fact.factSearchText ?? fact.factText,
      fact.sourceChunkId ?? null,
      fact.weight,
      fact.evidenceCount,
      embeddingStr,
      JSON.stringify(fact.scope),
      fact.scope.tenantId ?? null,
      fact.scope.groupId ?? null,
      fact.scope.userId ?? null,
      fact.scope.agentId ?? null,
      fact.scope.conversationId ?? null,
      fact.visibility ?? null,
      fact.invalidAt?.toISOString() ?? null,
      fact.updatedAt.toISOString(),
    ]
    const table = unqualified(this.factRecordsTable)
    const buildSql = (conflictTarget: 'edge_id' | 'id') => `INSERT INTO ${this.factRecordsTable}
        (id, edge_id, source_entity_id, target_entity_id, relation, fact_text,
         description, evidence_text, fact_search_text, source_chunk_id, weight,
         evidence_count, embedding, scope, tenant_id, group_id, user_id, agent_id,
         conversation_id, visibility, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (${conflictTarget}) DO UPDATE SET
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
         source_chunk_id = COALESCE(EXCLUDED.source_chunk_id, ${table}.source_chunk_id),
         weight = GREATEST(${table}.weight, EXCLUDED.weight),
         evidence_count = GREATEST(${table}.evidence_count, EXCLUDED.evidence_count),
         embedding = COALESCE(EXCLUDED.embedding, ${table}.embedding),
         scope = EXCLUDED.scope,
         tenant_id = EXCLUDED.tenant_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         conversation_id = EXCLUDED.conversation_id,
         visibility = EXCLUDED.visibility,
         invalid_at = EXCLUDED.invalid_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`
    let rows: Record<string, unknown>[]
    try {
      rows = await this.sqlWithRetry(buildSql('edge_id'), params)
    } catch (err) {
      if (!isDuplicateFactIdError(err)) throw err
      rows = await this.sqlWithRetry(buildSql('id'), params)
    }
    return mapRowToFact(rows[0]!)
  }

  async searchFacts(embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticFactRecord[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? ` AND ${identity.where}` : ''
    const limitParam = `$${2 + identity.params.length}`
    const rows = await this.sqlWithRetry(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
         FROM ${this.factRecordsTable}
        WHERE embedding IS NOT NULL
          ${scopeClause}
        ORDER BY embedding <=> $1::vector
        LIMIT ${limitParam}`,
      [vectorStr, ...identity.params, limit ?? 20]
    )
    return rows.map(mapRowToFact)
  }

  async searchFactsHybrid(query: string, embedding: number[] | undefined, scope: typegraphIdentity, limit?: number): Promise<SemanticFactRecord[]> {
    const maxRows = limit ?? 20
    const identity = buildGraphVisibilityWhere(scope, 2)
    const scopeClause = identity.where ? ` AND ${identity.where}` : ''
    const relaxedQuery = normalizeEntityText(query)
    const lexicalRows = await this.sqlWithRetry(
      `WITH tsq AS (
         SELECT websearch_to_tsquery('english', $1::text) AS strict_q,
                websearch_to_tsquery('english', $2::text) AS relaxed_q
       )
       SELECT f.*,
              GREATEST(ts_rank(f.search_vector, tsq.strict_q), ts_rank(f.search_vector, tsq.relaxed_q) * 0.75) AS similarity
         FROM ${this.factRecordsTable} f, tsq
        WHERE f.invalid_at IS NULL
          AND (f.search_vector @@ tsq.strict_q OR f.search_vector @@ tsq.relaxed_q)
          ${scopeClause}
        ORDER BY similarity DESC
        LIMIT $${2 + identity.params.length + 1}`,
      [query, relaxedQuery, ...identity.params, maxRows * 3]
    )

    const vectorRows = embedding
      ? await this.searchFacts(embedding, scope, maxRows * 3)
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
      scope?: typegraphIdentity | undefined
      bucketIds?: string[] | undefined
      limit?: number | undefined
    }
  ): Promise<SemanticEntityChunkEdge[]> {
    if (entityIds.length === 0) return []

    const params: unknown[] = [entityIds]
    let bucketClause = ''
    if (opts?.bucketIds && opts.bucketIds.length > 0) {
      params.push(opts.bucketIds)
      bucketClause = `AND e.target_bucket_id = ANY($${params.length}::text[])`
    }
    const edgeIdentity = buildGraphVisibilityWhere(opts?.scope, params.length, 'e')
    params.push(...edgeIdentity.params)
    params.push(opts?.limit ?? entityIds.length * 200)
    const limitParam = `$${params.length}`
    const edgeScopeClause = edgeIdentity.where ? `AND ${edgeIdentity.where}` : ''

    const rows = await this.sqlWithRetry(
      `SELECT e.*
         FROM ${this.edgesTable} e
        WHERE e.source_type = 'entity'
          AND e.target_type = 'chunk'
          AND e.source_id = ANY($1::text[])
          AND e.invalid_at IS NULL
          ${bucketClause}
          ${edgeScopeClause}
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
      scope?: typegraphIdentity | undefined
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
              c.user_id, c.agent_id, c.conversation_id
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
    scope: typegraphIdentity,
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
        const docParam = `$${params.length}`
        params.push(opts.chunkRefs.map(ref => ref.chunkIndex))
        const chunkParam = `$${params.length}`
        chunkRefClause = `AND (c.bucket_id, c.document_id, c.chunk_index) IN (SELECT * FROM unnest(${bucketParam}::text[], ${docParam}::text[], ${chunkParam}::int[]))`
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
              c.user_id, c.agent_id, c.conversation_id,
              1 - (c.embedding <=> $1::vector) AS similarity
         FROM ${opts.chunksTable} c
        WHERE c.embedding IS NOT NULL
          ${bucketClause}
          ${chunkRefClause}
          ${chunkScopeClause}
        ORDER BY c.embedding <=> $1::vector
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
         scope, tenant_id, group_id, user_id, agent_id, conversation_id, visibility,
         evidence, valid_at, invalid_at, updated_at)
       VALUES ($1,'entity',$2,'entity',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (source_type, source_id, target_type, target_id, relation) DO UPDATE SET
         weight = ${unqualified(this.edgesTable)}.weight + EXCLUDED.weight,
         valid_at = LEAST(${unqualified(this.edgesTable)}.valid_at, EXCLUDED.valid_at),
         updated_at = NOW()
       RETURNING *`,
      [
        edge.id, edge.sourceEntityId, edge.targetEntityId,
        edge.relation, edge.weight, JSON.stringify(edge.properties),
        JSON.stringify(edge.scope),
        edge.scope.tenantId ?? null,
        edge.scope.groupId ?? null,
        edge.scope.userId ?? null,
        edge.scope.agentId ?? null,
        edge.scope.conversationId ?? null,
        edge.visibility ?? null,
        edge.evidence,
        edge.temporal.validAt.toISOString(),
        edge.temporal.invalidAt?.toISOString() ?? null,
      ]
    )
    return mapRowToEdge(rows[0]!)
  }

  async getEdges(entityId: string, direction?: 'in' | 'out' | 'both', scope?: typegraphIdentity): Promise<SemanticEdge[]> {
    let query: string
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const params = [entityId, ...identity.params]
    if (direction === 'in') {
      query = `SELECT * FROM ${this.edgesTable} WHERE target_type = 'entity' AND target_id = $1 AND source_type = 'entity' AND invalid_at IS NULL ${scopeClause}`
    } else if (direction === 'out') {
      query = `SELECT * FROM ${this.edgesTable} WHERE source_type = 'entity' AND source_id = $1 AND target_type = 'entity' AND invalid_at IS NULL ${scopeClause}`
    } else {
      query = `SELECT * FROM ${this.edgesTable}
               WHERE ((source_type = 'entity' AND source_id = $1 AND target_type = 'entity')
                   OR (target_type = 'entity' AND target_id = $1 AND source_type = 'entity'))
                 AND invalid_at IS NULL ${scopeClause}`
    }
    const rows = await this.sqlWithRetry(query, params)
    return rows.map(mapRowToEdge)
  }

  async getEdgesBatch(entityIds: string[], direction: 'in' | 'out' | 'both' = 'both', scope?: typegraphIdentity): Promise<SemanticEdge[]> {
    if (entityIds.length === 0) return []
    const identity = buildGraphVisibilityWhere(scope, 1)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    let query: string
    if (direction === 'out') {
      query = `SELECT * FROM ${this.edgesTable} WHERE source_type = 'entity' AND source_id = ANY($1::text[]) AND target_type = 'entity' AND invalid_at IS NULL ${scopeClause}`
    } else if (direction === 'in') {
      query = `SELECT * FROM ${this.edgesTable} WHERE target_type = 'entity' AND target_id = ANY($1::text[]) AND source_type = 'entity' AND invalid_at IS NULL ${scopeClause}`
    } else {
      query = `SELECT * FROM ${this.edgesTable}
               WHERE ((source_type = 'entity' AND source_id = ANY($1::text[]) AND target_type = 'entity')
                   OR (target_type = 'entity' AND target_id = ANY($1::text[]) AND source_type = 'entity'))
                 AND invalid_at IS NULL
                 ${scopeClause}`
    }
    const rows = await this.sqlWithRetry(query, [entityIds, ...identity.params])
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
      `SELECT * FROM ${this.edgesTable} WHERE ${conditions.join(' AND ')}`,
      params
    )
    return rows.map(mapRowToEdge)
  }

  async invalidateEdge(id: string, invalidAt?: Date): Promise<void> {
    await this.sqlWithRetry(
      `UPDATE ${this.edgesTable} SET invalid_at = $2, updated_at = NOW() WHERE id = $1`,
      [id, (invalidAt ?? new Date()).toISOString()]
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

  async getMemoryIdsForEntities(entityIds: string[], scope?: typegraphIdentity): Promise<string[]> {
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
      const source = await this.getEntity(input.sourceEntityId, input)
      const target = await this.getEntity(input.targetEntityId, input)
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
          ...arrayProperty(target.properties.mergedEntityIds),
          ...arrayProperty(source.properties.mergedEntityIds),
          source.id,
        ]),
      ]

      await this.upsertEntity({
        ...target,
        aliases: mergedAliases,
        properties: {
          ...source.properties,
          ...target.properties,
          ...(input.properties ?? {}),
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
           AND sx.identity_type = tx.identity_type
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
        `SELECT *
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
        `SELECT *
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

      const refreshed = await this.getEntity(target.id, input)
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

  async deleteEntityReferences(entityId: string, opts: DeleteGraphEntityOpts): Promise<DeleteGraphEntityResult> {
    const mode = opts.mode ?? 'invalidate'
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
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`)
      const surfaceText = m.surfaceText?.trim() || null
      const normalizedSurfaceText = m.normalizedSurfaceText?.trim()
        || (surfaceText ? normalizeEntityText(surfaceText) : '')
      params.push(
        generateId('mention'),
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
         (id, entity_id, document_id, chunk_index, bucket_id, mention_type, surface_text, normalized_surface_text, confidence)
       VALUES ${values.join(',')}
       ON CONFLICT (entity_id, document_id, chunk_index, mention_type, normalized_surface_text) DO UPDATE SET
         surface_text = COALESCE(EXCLUDED.surface_text, ${unqualified(this.chunkMentionsTable)}.surface_text),
         confidence = COALESCE(EXCLUDED.confidence, ${unqualified(this.chunkMentionsTable)}.confidence)`,
      params
    )
  }

  async listChunkBackfillRecords(opts: {
    chunksTable: string
    scope?: typegraphIdentity | undefined
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
              c.embedding_model, c.content, c.metadata, c.visibility,
              c.tenant_id, c.group_id, c.user_id, c.agent_id, c.conversation_id
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
    scope?: typegraphIdentity | undefined
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
              c.embedding_model, c.content, c.metadata, c.visibility,
              c.tenant_id, c.group_id, c.user_id, c.agent_id, c.conversation_id,
              m.entity_id, m.mention_type, m.surface_text, m.normalized_surface_text, m.confidence
         FROM ${this.chunkMentionsTable} m
         JOIN ${opts.chunksTable} c
           ON m.document_id = c.document_id
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
    scope?: typegraphIdentity | undefined
    limit?: number | undefined
    offset?: number | undefined
  }): Promise<SemanticEdge[]> {
    const identity = opts?.scope ? buildIdentityWhere(opts.scope) : { where: '', params: [] }
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const params = [...identity.params, opts?.limit ?? 500, opts?.offset ?? 0]
    const limitParam = `$${params.length - 1}`
    const offsetParam = `$${params.length}`
    const rows = await this.sqlWithRetry(
      `SELECT *
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

  async countEntities(scope?: typegraphIdentity): Promise<number> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT COUNT(*)::integer AS n FROM ${this.entitiesTable} WHERE invalid_at IS NULL ${scopeClause}`,
      identity.params
    )
    return (rows[0]?.['n'] as number) ?? 0
  }

  async countEdges(scope?: typegraphIdentity): Promise<number> {
    const identity = buildGraphVisibilityWhere(scope)
    const scopeClause = identity.where ? `AND ${identity.where}` : ''
    const rows = await this.sqlWithRetry(
      `SELECT COUNT(*)::integer AS n FROM ${this.edgesTable} WHERE invalid_at IS NULL ${scopeClause}`,
      identity.params
    )
    return (rows[0]?.['n'] as number) ?? 0
  }

  async getRelationTypes(scope?: typegraphIdentity): Promise<Array<{ relation: string; count: number }>> {
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

  async getEntityTypes(scope?: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>> {
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

  async getDegreeDistribution(scope?: typegraphIdentity): Promise<Array<{ degree: number; count: number }>> {
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
  // Build scope from explicit identity columns (preferred) with JSONB fallback
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
    category: row.category as MemoryRecord['category'],
    status: row.status as MemoryRecord['status'],
    content: row.content as string,
    embedding: undefined, // Don't return vectors — too large
    importance: row.importance as number,
    accessCount: row.access_count as number,
    lastAccessedAt: new Date(row.last_accessed_at as string),
    metadata,
    scope,
    visibility: (row.visibility as MemoryRecord['visibility']) ?? undefined,
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
      conversationId: (row.episodic_conversation_id as string) ?? undefined,
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

function mapRowToEntity(row: Record<string, unknown>): SemanticEntity {
  const props = parseJson(row.properties)
  // Stash pgvector similarity score (if present from searchEntities query) as transient property
  if (row.similarity != null) {
    props._similarity = row.similarity as number
  }
  return {
    id: row.id as string,
    name: row.name as string,
    entityType: row.entity_type as string,
    aliases: row.aliases as string[] ?? [],
    properties: props,
    status: (row.status as SemanticEntity['status']) ?? 'active',
    mergedIntoEntityId: (row.merged_into_entity_id as string | null) ?? undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : undefined,
    embedding: undefined,
    descriptionEmbedding: parseVectorString(row.description_embedding),
    scope: rowToIdentity(row),
    visibility: (row.visibility as SemanticEntity['visibility']) ?? undefined,
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
    sourceType: 'entity',
    sourceId: row.source_id as string,
    targetType: 'entity',
    targetId: row.target_id as string,
    sourceEntityId: row.source_id as string,
    targetEntityId: row.target_id as string,
    relation: row.relation as string,
    weight: row.weight as number,
    properties: parseJson(row.properties),
    scope: rowToIdentity(row),
    visibility: (row.visibility as SemanticEdge['visibility']) ?? undefined,
    evidence: row.evidence as string[] ?? [],
    temporal: {
      validAt: new Date(row.valid_at as string),
      invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
      expiredAt: undefined,
    },
  }
}

function mapRowToFact(row: Record<string, unknown>): SemanticFactRecord {
  return {
    id: row.id as string,
    edgeId: row.edge_id as string,
    sourceEntityId: row.source_entity_id as string,
    targetEntityId: row.target_entity_id as string,
    relation: row.relation as string,
    factText: row.fact_text as string,
    description: (row.description as string | null) ?? undefined,
    evidenceText: (row.evidence_text as string | null) ?? undefined,
    factSearchText: (row.fact_search_text as string | null) ?? undefined,
    sourceChunkId: (row.source_chunk_id as string | null) ?? undefined,
    weight: row.weight as number,
    evidenceCount: row.evidence_count as number,
    embedding: undefined,
    scope: rowToIdentity(row),
    visibility: (row.visibility as SemanticFactRecord['visibility']) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
    similarity: (row.similarity as number | null) ?? undefined,
  }
}

function mapRowToEntityChunkEdge(row: Record<string, unknown>): SemanticEntityChunkEdge {
  const props = parseJson(row.properties)
  return {
    id: row.id as string,
    entityId: row.source_id as string,
    chunkRef: {
      bucketId: row.target_bucket_id as string,
      documentId: row.target_document_id as string,
      chunkIndex: row.target_chunk_index as number,
      embeddingModel: (row.target_embedding_model as string | null) ?? undefined,
      chunkId: (row.target_chunk_id as string | null) ?? undefined,
    },
    weight: row.weight as number,
    mentionCount: Number(props.mentionCount ?? 1),
    confidence: typeof props.confidence === 'number' ? props.confidence : undefined,
    surfaceTexts: Array.isArray(props.surfaceTexts) ? props.surfaceTexts as string[] : [],
    mentionTypes: Array.isArray(props.mentionTypes) ? props.mentionTypes as SemanticEntityChunkEdge['mentionTypes'] : [],
    scope: rowToIdentity(row),
    visibility: (row.visibility as SemanticEntityChunkEdge['visibility']) ?? undefined,
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
    visibility: (row.visibility as ChunkBackfillRecord['visibility']) ?? undefined,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
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
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
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
    properties: entity.properties,
    description: entity.properties.description as string | undefined,
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
    return trimmed.replace(/[^\d+]/g, '')
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

  // Explicit identity column filtering (preferred over JSONB scope)
  if (filter.tenantId) {
    params.push(filter.tenantId)
    conditions.push(`tenant_id = ${p()}`)
  } else if (filter.scope?.tenantId) {
    params.push(filter.scope.tenantId)
    conditions.push(`tenant_id = ${p()}`)
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
  if (filter.conversationId) {
    params.push(filter.conversationId)
    conditions.push(`conversation_id = ${p()}`)
  } else if (filter.scope?.conversationId) {
    params.push(filter.scope.conversationId)
    conditions.push(`conversation_id = ${p()}`)
  }
  if (filter.visibility) {
    if (Array.isArray(filter.visibility)) {
      params.push(filter.visibility)
      conditions.push(`visibility = ANY(${p()}::text[])`)
    } else {
      params.push(filter.visibility)
      conditions.push(`visibility = ${p()}`)
    }
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

/**
 * Build WHERE conditions from a typegraphIdentity for entity/edge queries.
 * Only adds conditions for non-null identity fields.
 */
function buildIdentityWhere(
  identity: typegraphIdentity,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`

  if (identity.tenantId) { params.push(identity.tenantId); conditions.push(`tenant_id = ${p()}`) }
  if (identity.groupId) { params.push(identity.groupId); conditions.push(`group_id = ${p()}`) }
  if (identity.userId) { params.push(identity.userId); conditions.push(`user_id = ${p()}`) }
  if (identity.agentId) { params.push(identity.agentId); conditions.push(`agent_id = ${p()}`) }
  if (identity.conversationId) { params.push(identity.conversationId); conditions.push(`conversation_id = ${p()}`) }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function buildGraphVisibilityWhere(
  identity: typegraphIdentity | undefined,
  paramOffset = 0,
  alias?: string,
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`
  const col = (name: string) => alias ? `${alias}.${name}` : name

  let tenantParam: string | undefined
  let groupParam: string | undefined
  let userParam: string | undefined
  let agentParam: string | undefined
  let conversationParam: string | undefined

  if (identity?.tenantId) {
    params.push(identity.tenantId)
    tenantParam = p()
    conditions.push(`${col('tenant_id')} = ${tenantParam}`)
  }
  if (identity?.groupId) {
    params.push(identity.groupId)
    groupParam = p()
    conditions.push(`${col('group_id')} = ${groupParam}`)
  }
  if (identity?.userId) {
    params.push(identity.userId)
    userParam = p()
    conditions.push(`${col('user_id')} = ${userParam}`)
  }
  if (identity?.agentId) {
    params.push(identity.agentId)
    agentParam = p()
    conditions.push(`${col('agent_id')} = ${agentParam}`)
  }
  if (identity?.conversationId) {
    params.push(identity.conversationId)
    conversationParam = p()
    conditions.push(`${col('conversation_id')} = ${conversationParam}`)
  }

  const visibilityBranches = [`${col('visibility')} IS NULL`]
  if (tenantParam) visibilityBranches.push(`(${col('visibility')} = 'tenant' AND ${col('tenant_id')} = ${tenantParam})`)
  if (groupParam) visibilityBranches.push(`(${col('visibility')} = 'group' AND ${col('group_id')} = ${groupParam})`)
  if (userParam) visibilityBranches.push(`(${col('visibility')} = 'user' AND ${col('user_id')} = ${userParam})`)
  if (agentParam) visibilityBranches.push(`(${col('visibility')} = 'agent' AND ${col('agent_id')} = ${agentParam})`)
  if (conversationParam) visibilityBranches.push(`(${col('visibility')} = 'conversation' AND ${col('conversation_id')} = ${conversationParam})`)
  conditions.push(`(${visibilityBranches.join(' OR ')})`)

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function buildAliasedIdentityWhere(
  alias: string,
  identity: typegraphIdentity,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const base = buildIdentityWhere(identity, paramOffset)
  if (!base.where) return base
  return {
    where: base.where.replace(/\b(tenant_id|group_id|user_id|agent_id|conversation_id)\b/g, `${alias}.$1`),
    params: base.params,
  }
}

/**
 * Extract identity from a DB row's explicit columns.
 */
function rowToIdentity(row: Record<string, unknown>): typegraphIdentity {
  const id: typegraphIdentity = {}
  if (row.tenant_id) id.tenantId = row.tenant_id as string
  if (row.group_id) id.groupId = row.group_id as string
  if (row.user_id) id.userId = row.user_id as string
  if (row.agent_id) id.agentId = row.agent_id as string
  if (row.conversation_id) id.conversationId = row.conversation_id as string
  return id
}
