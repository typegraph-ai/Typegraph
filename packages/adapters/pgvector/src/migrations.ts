export const INIT_SQL = (chunksTable: string, hashesTable: string, dimensions: number) => `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS ${chunksTable} (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       TEXT NOT NULL,
    tenant_id       TEXT,
    document_id     TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    content         TEXT NOT NULL,
    embedding       VECTOR(${dimensions}),
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

  CREATE TABLE IF NOT EXISTS ${hashesTable} (
    store_key       TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    tenant_id       TEXT,
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
