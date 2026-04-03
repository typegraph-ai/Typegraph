/**
 * Postgres limits identifiers to 63 characters (NAMEDATALEN - 1).
 * Index names are constructed as `${tablePrefix}_${suffix}`, which can
 * easily exceed 63 chars with long table prefixes (e.g. schema-qualified
 * names or embedding model key suffixes).
 *
 * safeIdx() produces a deterministic, collision-resistant index name
 * that fits within the 63-char limit. When the full name fits, it's
 * used as-is. When it doesn't, the table prefix is truncated and a
 * 6-char hash is inserted for uniqueness.
 */
const PG_IDENT_MAX = 63

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return h >>> 0 // unsigned
}

export function safeIdx(tablePrefix: string, suffix: string): string {
  // Sanitize schema-qualified names for index identifiers — Postgres does not
  // allow schema-qualified names (dots) in CREATE INDEX index name positions.
  // e.g. "cust_abc".d8um_hashes → cust_abc_d8um_hashes
  const sanitized = tablePrefix.replace(/"/g, '').replace(/\./g, '_')
  const full = `${sanitized}_${suffix}`
  if (full.length <= PG_IDENT_MAX) return full
  const hash = djb2(full).toString(36).padStart(6, '0').slice(0, 6)
  // Keep as much of the table prefix as fits: prefix + _ + hash + _ + suffix
  const available = PG_IDENT_MAX - suffix.length - 1 - 6 - 1
  return `${sanitized.slice(0, available)}_${hash}_${suffix}`
}

/**
 * DDL for the model registry table - tracks which embedding models
 * have been initialized and their table names / dimensions.
 */
export const REGISTRY_SQL = (registryTable: string) => `
  CREATE TABLE IF NOT EXISTS ${registryTable} (
    model_key   TEXT PRIMARY KEY,
    model_id    TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    dimensions  INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`

/**
 * DDL for a per-model chunks table. Called lazily via ensureModel().
 * Each embedding model gets its own table with the correct VECTOR(n) column.
 */
export const MODEL_TABLE_SQL = (chunksTable: string, dimensions: number) => {
  const idx = (suffix: string) => safeIdx(chunksTable, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${chunksTable} (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    group_id        TEXT,
    user_id         TEXT,
    agent_id        TEXT,
    session_id      TEXT,
    document_id     UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    content         TEXT NOT NULL,
    embedding       VECTOR(${dimensions}),
    embedding_model TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    total_chunks    INTEGER NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector   TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('english', content)
    ) STORED
  );

  CREATE INDEX IF NOT EXISTS ${idx('embedding_idx')}
    ON ${chunksTable} USING hnsw (embedding vector_cosine_ops);

  CREATE INDEX IF NOT EXISTS ${idx('bucket_tenant_idx')}
    ON ${chunksTable} (bucket_id, tenant_id);

  CREATE INDEX IF NOT EXISTS ${idx('fts_idx')}
    ON ${chunksTable} USING gin (search_vector);

  CREATE INDEX IF NOT EXISTS ${idx('doc_chunk_idx')}
    ON ${chunksTable} (document_id, chunk_index);

  CREATE UNIQUE INDEX IF NOT EXISTS ${idx('ikey_chunk_idx')}
    ON ${chunksTable} (idempotency_key, chunk_index, bucket_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')}
    ON ${chunksTable} (tenant_id, user_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')}
    ON ${chunksTable} (tenant_id, group_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')}
    ON ${chunksTable} (tenant_id, agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_session_idx')}
    ON ${chunksTable} (tenant_id, session_id);

  CREATE INDEX IF NOT EXISTS ${idx('user_idx')}
    ON ${chunksTable} (user_id);

  CREATE INDEX IF NOT EXISTS ${idx('group_idx')}
    ON ${chunksTable} (group_id);

  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')}
    ON ${chunksTable} (agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('session_idx')}
    ON ${chunksTable} (session_id);
`
}

/**
 * DDL for the shared hash store table (dimension-agnostic).
 */
export const HASH_TABLE_SQL = (hashesTable: string) => {
  const idx = (suffix: string) => safeIdx(hashesTable, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${hashesTable} (
    store_key       TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    group_id        TEXT,
    user_id         TEXT,
    agent_id        TEXT,
    session_id      TEXT,
    embedding_model TEXT NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL,
    chunk_count     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS ${idx('bucket_idx')}
    ON ${hashesTable} (bucket_id, tenant_id);

  CREATE TABLE IF NOT EXISTS ${hashesTable}_run_times (
    bucket_id  TEXT NOT NULL,
    tenant_id  TEXT NOT NULL DEFAULT '',
    last_run   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (bucket_id, tenant_id)
  );
`
}

/**
 * DDL for the documents table - tracks indexed documents with metadata.
 * Created once during initialize().
 */
export const DOCUMENTS_TABLE_SQL = (documentsTable: string) => {
  const idx = (suffix: string) => safeIdx(documentsTable, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${documentsTable} (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    group_id        TEXT,
    user_id         TEXT,
    agent_id        TEXT,
    session_id      TEXT,
    title           TEXT NOT NULL DEFAULT '',
    url             TEXT,
    content_hash    TEXT NOT NULL,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    visibility      TEXT CHECK (visibility IS NULL OR visibility IN ('tenant', 'group', 'user', 'agent', 'session')),
    document_type   TEXT,
    source_type     TEXT,
    indexed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{}'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ${idx('source_hash_idx')}
    ON ${documentsTable} (bucket_id, COALESCE(tenant_id, ''), content_hash);

  CREATE INDEX IF NOT EXISTS ${idx('bucket_idx')}
    ON ${documentsTable} (bucket_id, tenant_id);

  CREATE INDEX IF NOT EXISTS ${idx('status_idx')}
    ON ${documentsTable} (status);

  CREATE INDEX IF NOT EXISTS ${idx('visibility_user_idx')}
    ON ${documentsTable} (visibility, user_id);

  CREATE INDEX IF NOT EXISTS ${idx('type_idx')}
    ON ${documentsTable} (document_type);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')}
    ON ${documentsTable} (tenant_id, user_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')}
    ON ${documentsTable} (tenant_id, group_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')}
    ON ${documentsTable} (tenant_id, agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_session_idx')}
    ON ${documentsTable} (tenant_id, session_id);

  CREATE INDEX IF NOT EXISTS ${idx('user_idx')}
    ON ${documentsTable} (user_id);

  CREATE INDEX IF NOT EXISTS ${idx('group_idx')}
    ON ${documentsTable} (group_id);

  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')}
    ON ${documentsTable} (agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('session_idx')}
    ON ${documentsTable} (session_id);
`
}

/**
 * DDL for the sources table - persists d8um Bucket records.
 */
export const BUCKETS_TABLE_SQL = (table: string) => {
  const idx = (suffix: string) => safeIdx(table, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
    tenant_id   TEXT,
    group_id    TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    session_id  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('tenant_idx')}
    ON ${table} (tenant_id);
`
}

/**
 * DDL for the jobs table - persists d8um Job instances.
 */
export const JOBS_TABLE_SQL = (table: string) => {
  const idx = (suffix: string) => safeIdx(table, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT,
    group_id    TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    session_id  TEXT,
    bucket_id   TEXT,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    config      JSONB NOT NULL DEFAULT '{}',
    schedule    TEXT,
    status      TEXT NOT NULL DEFAULT 'idle'
                CHECK (status IN ('idle', 'running', 'completed', 'failed', 'scheduled')),
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    run_count   INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('tenant_idx')}
    ON ${table} (tenant_id);

  CREATE INDEX IF NOT EXISTS ${idx('bucket_idx')}
    ON ${table} (bucket_id);

  CREATE INDEX IF NOT EXISTS ${idx('type_idx')}
    ON ${table} (type);
`
}

/**
 * DDL for the job runs table - persists execution history.
 */
export const JOB_RUNS_TABLE_SQL = (table: string) => {
  const idx = (suffix: string) => safeIdx(table, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id                TEXT PRIMARY KEY,
    job_id            TEXT NOT NULL,
    bucket_id         TEXT,
    status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed')),
    summary           TEXT,
    documents_created INTEGER NOT NULL DEFAULT 0,
    documents_updated INTEGER NOT NULL DEFAULT 0,
    documents_deleted INTEGER NOT NULL DEFAULT 0,
    metrics           JSONB NOT NULL DEFAULT '{}',
    error             TEXT,
    duration_ms       INTEGER,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS ${idx('job_idx')}
    ON ${table} (job_id);
`
}

/**
 * DDL for the document-job relations table.
 */
export const DOCUMENT_JOB_RELATIONS_TABLE_SQL = (table: string) => {
  const idx = (suffix: string) => safeIdx(table, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${table} (
    document_id TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    relation    TEXT NOT NULL CHECK (relation IN ('created', 'modified')),
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (document_id, job_id)
  );

  CREATE INDEX IF NOT EXISTS ${idx('job_idx')}
    ON ${table} (job_id);
`
}

/**
 * Sanitize a model identifier into a valid SQL table name suffix.
 * e.g., "openai/text-embedding-3-small" → "openai_text_embedding_3_small"
 */
export function sanitizeModelKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}
