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
  // e.g. "cust_abc".typegraph_hashes → cust_abc_typegraph_hashes
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
    id              TEXT PRIMARY KEY,
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    group_id        TEXT,
    user_id         TEXT,
    agent_id        TEXT,
    conversation_id      TEXT,
    document_id     TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')}
    ON ${chunksTable} (tenant_id, conversation_id);

  CREATE INDEX IF NOT EXISTS ${idx('user_idx')}
    ON ${chunksTable} (user_id);

  CREATE INDEX IF NOT EXISTS ${idx('group_idx')}
    ON ${chunksTable} (group_id);

  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')}
    ON ${chunksTable} (agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('conversation_idx')}
    ON ${chunksTable} (conversation_id);
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
    conversation_id      TEXT,
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
    id              TEXT PRIMARY KEY,
    bucket_id       TEXT NOT NULL,
    tenant_id       TEXT,
    group_id        TEXT,
    user_id         TEXT,
    agent_id        TEXT,
    conversation_id      TEXT,
    title           TEXT NOT NULL DEFAULT '',
    url             TEXT,
    content_hash    TEXT NOT NULL,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    visibility      TEXT CHECK (visibility IS NULL OR visibility IN ('tenant', 'group', 'user', 'agent', 'conversation')),
    document_type   TEXT,
    source_type     TEXT,
    graph_extracted BOOLEAN NOT NULL DEFAULT FALSE,
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

  CREATE INDEX IF NOT EXISTS ${idx('graph_extracted_idx')}
    ON ${documentsTable} (graph_extracted);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')}
    ON ${documentsTable} (tenant_id, user_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')}
    ON ${documentsTable} (tenant_id, group_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')}
    ON ${documentsTable} (tenant_id, agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('tenant_conversation_idx')}
    ON ${documentsTable} (tenant_id, conversation_id);

  CREATE INDEX IF NOT EXISTS ${idx('user_idx')}
    ON ${documentsTable} (user_id);

  CREATE INDEX IF NOT EXISTS ${idx('group_idx')}
    ON ${documentsTable} (group_id);

  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')}
    ON ${documentsTable} (agent_id);

  CREATE INDEX IF NOT EXISTS ${idx('conversation_idx')}
    ON ${documentsTable} (conversation_id);
`
}

/**
 * DDL for the sources table - persists typegraph Bucket records.
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
    conversation_id  TEXT,
    embedding_model TEXT,
    query_embedding_model TEXT,
    index_defaults JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('tenant_idx')}
    ON ${table} (tenant_id);
`
}

/**
 * DDL for the events table — append-only audit/observability log.
 * Created once during deploy().
 */
export const EVENTS_TABLE_SQL = (eventsTable: string) => {
  const idx = (suffix: string) => safeIdx(eventsTable, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${eventsTable} (
    id              TEXT PRIMARY KEY,
    event_type      TEXT NOT NULL,
    tenant_id       TEXT,
    group_id        TEXT,
    user_id         TEXT,
    agent_id        TEXT,
    conversation_id TEXT,
    target_id       TEXT,
    target_type     TEXT,
    payload         JSONB NOT NULL DEFAULT '{}',
    duration_ms     INTEGER,
    trace_id        TEXT,
    span_id         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('tenant_time_idx')}
    ON ${eventsTable} (tenant_id, created_at);

  CREATE INDEX IF NOT EXISTS ${idx('type_time_idx')}
    ON ${eventsTable} (event_type, created_at);

  CREATE INDEX IF NOT EXISTS ${idx('target_idx')}
    ON ${eventsTable} (target_id);

  CREATE INDEX IF NOT EXISTS ${idx('conversation_time_idx')}
    ON ${eventsTable} (conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS ${idx('agent_time_idx')}
    ON ${eventsTable} (agent_id, created_at);

  CREATE INDEX IF NOT EXISTS ${idx('trace_idx')}
    ON ${eventsTable} (trace_id);
`
}

/**
 * DDL for the policies table — governance rules for memory access, retention, and data flow.
 * Created once during deploy().
 */
export const POLICIES_TABLE_SQL = (policiesTable: string) => {
  const idx = (suffix: string) => safeIdx(policiesTable, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${policiesTable} (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    policy_type TEXT NOT NULL
                CHECK (policy_type IN ('access', 'retention', 'data_flow')),
    tenant_id   TEXT,
    group_id    TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    rules       JSONB NOT NULL,
    enabled     BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('tenant_idx')}
    ON ${policiesTable} (tenant_id);

  CREATE INDEX IF NOT EXISTS ${idx('type_idx')}
    ON ${policiesTable} (policy_type);

  CREATE INDEX IF NOT EXISTS ${idx('enabled_idx')}
    ON ${policiesTable} (enabled) WHERE enabled = true;
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
