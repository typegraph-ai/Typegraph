/**
 * DDL for the model registry table — tracks which embedding models
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
export const MODEL_TABLE_SQL = (chunksTable: string, dimensions: number) => `
  CREATE TABLE IF NOT EXISTS ${chunksTable} (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       TEXT NOT NULL,
    tenant_id       TEXT,
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

  CREATE INDEX IF NOT EXISTS ${chunksTable}_embedding_idx
    ON ${chunksTable} USING hnsw (embedding vector_cosine_ops);

  CREATE INDEX IF NOT EXISTS ${chunksTable}_tenant_idx
    ON ${chunksTable} (tenant_id);

  CREATE INDEX IF NOT EXISTS ${chunksTable}_source_tenant_idx
    ON ${chunksTable} (source_id, tenant_id);

  CREATE INDEX IF NOT EXISTS ${chunksTable}_fts_idx
    ON ${chunksTable} USING gin (search_vector);

  CREATE INDEX IF NOT EXISTS ${chunksTable}_doc_chunk_idx
    ON ${chunksTable} (document_id, chunk_index);

  CREATE UNIQUE INDEX IF NOT EXISTS ${chunksTable}_ikey_chunk_idx
    ON ${chunksTable} (idempotency_key, chunk_index, source_id);
`

/**
 * DDL for the shared hash store table (dimension-agnostic).
 */
export const HASH_TABLE_SQL = (hashesTable: string) => `
  CREATE TABLE IF NOT EXISTS ${hashesTable} (
    store_key       TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    tenant_id       TEXT,
    embedding_model TEXT NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL,
    chunk_count     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS ${hashesTable}_source_idx
    ON ${hashesTable} (source_id, tenant_id);

  CREATE TABLE IF NOT EXISTS ${hashesTable}_run_times (
    source_id  TEXT NOT NULL,
    tenant_id  TEXT,
    last_run   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, COALESCE(tenant_id, ''))
  );
`

/**
 * DDL for the documents table — tracks indexed documents with metadata.
 * Created once during initialize().
 */
export const DOCUMENTS_TABLE_SQL = (documentsTable: string) => `
  CREATE TABLE IF NOT EXISTS ${documentsTable} (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       TEXT NOT NULL,
    tenant_id       TEXT,
    title           TEXT NOT NULL DEFAULT '',
    url             TEXT,
    content_hash    TEXT NOT NULL,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    scope           TEXT CHECK (scope IS NULL OR scope IN ('tenant', 'folder', 'user')),
    folder_id       UUID,
    user_id         UUID,
    document_type   TEXT,
    source_type     TEXT,
    indexed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{}'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ${documentsTable}_source_hash_idx
    ON ${documentsTable} (source_id, COALESCE(tenant_id, ''), content_hash);

  CREATE INDEX IF NOT EXISTS ${documentsTable}_source_idx
    ON ${documentsTable} (source_id, tenant_id);

  CREATE INDEX IF NOT EXISTS ${documentsTable}_status_idx
    ON ${documentsTable} (status);

  CREATE INDEX IF NOT EXISTS ${documentsTable}_scope_user_idx
    ON ${documentsTable} (scope, user_id);

  CREATE INDEX IF NOT EXISTS ${documentsTable}_type_idx
    ON ${documentsTable} (document_type);
`

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
