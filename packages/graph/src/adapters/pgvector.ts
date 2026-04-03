/**
 * PostgreSQL + pgvector implementation of MemoryStoreAdapter.
 * Provides persistent storage for memories, semantic entities, and edges.
 *
 * Uses the same SqlExecutor pattern as @d8um-ai/adapter-pgvector for
 * driver-agnostic Postgres access (Neon, node-postgres, Drizzle, etc.).
 */

import type { MemoryStoreAdapter, MemoryFilter, MemorySearchOpts } from '../types/adapter.js'
import type { MemoryRecord, SemanticEntity, SemanticEdge } from '../types/memory.js'
import type { d8umIdentity } from '@d8um-ai/core'

type SqlExecutor = (
  query: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>

export interface PgMemoryAdapterConfig {
  sql: SqlExecutor
  /** Postgres schema name. Defaults to 'public'. */
  schema?: string | undefined
  memoriesTable?: string | undefined
  entitiesTable?: string | undefined
  edgesTable?: string | undefined
  /** Embedding vector dimensions (e.g. 1536 for text-embedding-3-small). Used for HNSW index creation. */
  embeddingDimensions?: number | undefined
}

// ── DDL ──

// Index prefix: replace dots with underscores so schema-qualified table names
// produce valid Postgres index names (e.g. "myschema.d8um_memories" → "myschema_d8um_memories").
const idxPrefix = (t: string) => t.replace(/\./g, '_')

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
    session_id       TEXT,
    visibility       TEXT NOT NULL DEFAULT 'user'
                     CHECK (visibility IN ('tenant', 'group', 'user', 'agent', 'session')),
    -- Episodic
    event_type       TEXT,
    participants     TEXT[],
    episodic_session_id TEXT,
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
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('category_idx')} ON ${t} (category);
  CREATE INDEX IF NOT EXISTS ${idx('status_idx')} ON ${t} (status);
  CREATE INDEX IF NOT EXISTS ${idx('subject_idx')} ON ${t} (subject);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_session_idx')} ON ${t} (tenant_id, session_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('session_idx')} ON ${t} (session_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
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
    embedding   VECTOR${dims ? `(${dims})` : ''},
    scope       JSONB NOT NULL DEFAULT '{}',
    -- Identity columns
    tenant_id   TEXT,
    group_id    TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    session_id  TEXT,
    visibility  TEXT NOT NULL DEFAULT 'tenant'
                CHECK (visibility IN ('tenant', 'group', 'user', 'agent', 'session')),
    valid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('name_idx')} ON ${t} (name);
  CREATE INDEX IF NOT EXISTS ${idx('type_idx')} ON ${t} (entity_type);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_session_idx')} ON ${t} (tenant_id, session_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('session_idx')} ON ${t} (session_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
`
}

const EDGES_DDL = (t: string) => {
  const i = idxPrefix(t)
  const idx = (suffix: string) => safeIdx(i, suffix)
  return `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation         TEXT NOT NULL,
    weight           REAL NOT NULL DEFAULT 1.0,
    properties       JSONB NOT NULL DEFAULT '{}',
    scope            JSONB NOT NULL DEFAULT '{}',
    -- Identity columns
    tenant_id        TEXT,
    group_id         TEXT,
    user_id          TEXT,
    agent_id         TEXT,
    session_id       TEXT,
    visibility       TEXT NOT NULL DEFAULT 'tenant'
                     CHECK (visibility IN ('tenant', 'group', 'user', 'agent', 'session')),
    evidence         TEXT[] DEFAULT '{}',
    valid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${idx('source_idx')} ON ${t} (source_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('target_idx')} ON ${t} (target_entity_id);
  CREATE INDEX IF NOT EXISTS ${idx('relation_idx')} ON ${t} (relation);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_user_idx')} ON ${t} (tenant_id, user_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_group_idx')} ON ${t} (tenant_id, group_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_agent_idx')} ON ${t} (tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('tenant_session_idx')} ON ${t} (tenant_id, session_id);
  CREATE INDEX IF NOT EXISTS ${idx('user_idx')} ON ${t} (user_id);
  CREATE INDEX IF NOT EXISTS ${idx('group_idx')} ON ${t} (group_id);
  CREATE INDEX IF NOT EXISTS ${idx('agent_idx')} ON ${t} (agent_id);
  CREATE INDEX IF NOT EXISTS ${idx('session_idx')} ON ${t} (session_id);
  CREATE INDEX IF NOT EXISTS ${idx('visibility_idx')} ON ${t} (visibility);
`
}

// ── Adapter Implementation ──

/** Strip schema prefix from a qualified table name for use in ON CONFLICT column refs. */
const unqualified = (table: string) => table.includes('.') ? table.split('.').pop()! : table

export class PgMemoryStoreAdapter implements MemoryStoreAdapter {
  private sql: SqlExecutor
  private memoriesTable: string
  private entitiesTable: string
  private edgesTable: string
  private schema: string | undefined
  private hnswEntityIndexCreated = false
  private hnswMemoryIndexCreated = false
  private readonly embeddingDimensions: number

  constructor(config: PgMemoryAdapterConfig) {
    this.sql = config.sql
    this.schema = config.schema
    const prefix = config.schema ? `"${config.schema}".` : ''
    this.memoriesTable = config.memoriesTable ?? `${prefix}d8um_memories`
    this.entitiesTable = config.entitiesTable ?? `${prefix}d8um_semantic_entities`
    this.edgesTable = config.edgesTable ?? `${prefix}d8um_semantic_edges`
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
      EDGES_DDL(this.edgesTable),
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

  private async ensureHnswIndex(target: 'entity' | 'memory'): Promise<void> {
    const table = target === 'entity' ? this.entitiesTable : this.memoriesTable
    const created = target === 'entity' ? this.hnswEntityIndexCreated : this.hnswMemoryIndexCreated
    if (created) return
    try {
      await this.sql(
        `ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector(${this.embeddingDimensions})`
      )
    } catch {
      // Column may already be typed — ignore
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
      console.warn(`[d8um] HNSW index creation on ${table} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── CRUD ──

  async upsert(record: MemoryRecord): Promise<MemoryRecord> {
    const embeddingStr = record.embedding ? `[${record.embedding.join(',')}]` : null
    const rows = await this.sql(
      `INSERT INTO ${this.memoriesTable}
        (id, category, status, content, embedding, importance, access_count,
         last_accessed_at, metadata, scope,
         tenant_id, group_id, user_id, agent_id, session_id, visibility,
         event_type, participants, episodic_session_id, sequence, consolidated_at,
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
         session_id = EXCLUDED.session_id, visibility = EXCLUDED.visibility,
         event_type = EXCLUDED.event_type, participants = EXCLUDED.participants,
         episodic_session_id = EXCLUDED.episodic_session_id, sequence = EXCLUDED.sequence,
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
        record.scope.sessionId ?? null,
        record.visibility ?? 'user',
        // Episodic
        (record as any).eventType ?? null,
        (record as any).participants ?? null,
        (record as any).sessionId ?? null,  // episodic sessionId → episodic_session_id column
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
    const rows = await this.sql(`SELECT * FROM ${this.memoriesTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToMemory(rows[0]!) : null
  }

  async list(filter: MemoryFilter, limit?: number): Promise<MemoryRecord[]> {
    const { where, params } = buildMemoryWhere(filter)
    const whereClause = where ? `WHERE ${where}` : ''
    params.push(limit ?? 100)
    const rows = await this.sql(
      `SELECT * FROM ${this.memoriesTable} ${whereClause}
       ORDER BY last_accessed_at DESC LIMIT $${params.length}`,
      params
    )
    return rows.map(mapRowToMemory)
  }

  async delete(id: string): Promise<void> {
    await this.sql(`DELETE FROM ${this.memoriesTable} WHERE id = $1`, [id])
  }

  // ── Temporal Operations ──

  async invalidate(id: string, invalidAt?: Date): Promise<void> {
    await this.sql(
      `UPDATE ${this.memoriesTable}
       SET status = 'invalidated', invalid_at = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, (invalidAt ?? new Date()).toISOString()]
    )
  }

  async expire(id: string): Promise<void> {
    await this.sql(
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

    const rows = await this.sql(
      `SELECT *, 1 - (embedding <=> $${params.length - 1}::vector) AS similarity
       FROM ${this.memoriesTable}
       ${whereClause}
       ORDER BY embedding <=> $${params.length - 1}::vector
       LIMIT $${params.length}`,
      params
    )
    return rows.map(mapRowToMemory)
  }

  // ── Access Tracking ──

  async recordAccess(id: string): Promise<void> {
    await this.sql(
      `UPDATE ${this.memoriesTable}
       SET access_count = access_count + 1, last_accessed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    )
  }

  // ── Entity Storage ──

  async upsertEntity(entity: SemanticEntity): Promise<SemanticEntity> {
    const embeddingStr = entity.embedding ? `[${entity.embedding.join(',')}]` : null
    const rows = await this.sql(
      `INSERT INTO ${this.entitiesTable}
        (id, name, entity_type, aliases, properties, embedding, scope,
         tenant_id, group_id, user_id, agent_id, session_id, visibility,
         valid_at, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
         aliases = EXCLUDED.aliases, properties = EXCLUDED.properties,
         embedding = COALESCE(EXCLUDED.embedding, ${unqualified(this.entitiesTable)}.embedding), scope = EXCLUDED.scope,
         tenant_id = EXCLUDED.tenant_id, group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
         session_id = EXCLUDED.session_id, visibility = EXCLUDED.visibility,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at, updated_at = NOW()
       RETURNING *`,
      [
        entity.id, entity.name, entity.entityType,
        entity.aliases, JSON.stringify(entity.properties),
        embeddingStr, JSON.stringify(entity.scope),
        entity.scope.tenantId ?? null,
        entity.scope.groupId ?? null,
        entity.scope.userId ?? null,
        entity.scope.agentId ?? null,
        entity.scope.sessionId ?? null,
        entity.visibility ?? 'tenant',
        entity.temporal.validAt.toISOString(),
        entity.temporal.invalidAt?.toISOString() ?? null,
      ]
    )

    // Lazily create HNSW index after first entity with embedding is persisted
    if (embeddingStr && !this.hnswEntityIndexCreated) {
      await this.ensureHnswIndex('entity')
    }

    return mapRowToEntity(rows[0]!)
  }

  async getEntity(id: string): Promise<SemanticEntity | null> {
    const rows = await this.sql(`SELECT * FROM ${this.entitiesTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToEntity(rows[0]!) : null
  }

  async findEntities(query: string, scope: d8umIdentity, limit?: number): Promise<SemanticEntity[]> {
    const { where, params } = buildIdentityWhere(scope)
    const baseIdx = params.length
    params.push(`%${query}%`)
    const nameParam = `$${baseIdx + 1}`
    params.push(limit ?? 20)
    const limitParam = `$${baseIdx + 2}`
    const scopeClause = where ? ` AND ${where}` : ''
    const rows = await this.sql(
      `SELECT * FROM ${this.entitiesTable}
       WHERE (name ILIKE ${nameParam} OR ${nameParam} = ANY(aliases))
         ${scopeClause}
         AND invalid_at IS NULL
       LIMIT ${limitParam}`,
      params
    )
    return rows.map(mapRowToEntity)
  }

  async searchEntities(embedding: number[], scope: d8umIdentity, limit?: number): Promise<SemanticEntity[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildIdentityWhere(scope, 1)
    const scopeClause = where ? ` AND ${where}` : ''
    params.push(limit ?? 20)
    const limitParam = `$${1 + params.length}`
    const rows = await this.sql(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM ${this.entitiesTable}
       WHERE embedding IS NOT NULL
         ${scopeClause}
         AND invalid_at IS NULL
       ORDER BY embedding <=> $1::vector
       LIMIT ${limitParam}`,
      [vectorStr, ...params]
    )
    return rows.map(mapRowToEntity)
  }

  // ── Edge Storage ──

  async upsertEdge(edge: SemanticEdge): Promise<SemanticEdge> {
    const rows = await this.sql(
      `INSERT INTO ${this.edgesTable}
        (id, source_entity_id, target_entity_id, relation, weight, properties,
         scope, tenant_id, group_id, user_id, agent_id, session_id, visibility,
         evidence, valid_at, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (id) DO UPDATE SET
         source_entity_id = EXCLUDED.source_entity_id,
         target_entity_id = EXCLUDED.target_entity_id,
         relation = EXCLUDED.relation, weight = EXCLUDED.weight,
         properties = EXCLUDED.properties, scope = EXCLUDED.scope,
         tenant_id = EXCLUDED.tenant_id, group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
         session_id = EXCLUDED.session_id, visibility = EXCLUDED.visibility,
         evidence = EXCLUDED.evidence, valid_at = EXCLUDED.valid_at,
         invalid_at = EXCLUDED.invalid_at, updated_at = NOW()
       RETURNING *`,
      [
        edge.id, edge.sourceEntityId, edge.targetEntityId,
        edge.relation, edge.weight, JSON.stringify(edge.properties),
        JSON.stringify(edge.scope),
        edge.scope.tenantId ?? null,
        edge.scope.groupId ?? null,
        edge.scope.userId ?? null,
        edge.scope.agentId ?? null,
        edge.scope.sessionId ?? null,
        edge.visibility ?? 'tenant',
        edge.evidence,
        edge.temporal.validAt.toISOString(),
        edge.temporal.invalidAt?.toISOString() ?? null,
      ]
    )
    return mapRowToEdge(rows[0]!)
  }

  async getEdges(entityId: string, direction?: 'in' | 'out' | 'both'): Promise<SemanticEdge[]> {
    let query: string
    const params = [entityId]
    if (direction === 'in') {
      query = `SELECT * FROM ${this.edgesTable} WHERE target_entity_id = $1 AND invalid_at IS NULL`
    } else if (direction === 'out') {
      query = `SELECT * FROM ${this.edgesTable} WHERE source_entity_id = $1 AND invalid_at IS NULL`
    } else {
      query = `SELECT * FROM ${this.edgesTable} WHERE (source_entity_id = $1 OR target_entity_id = $1) AND invalid_at IS NULL`
    }
    const rows = await this.sql(query, params)
    return rows.map(mapRowToEdge)
  }

  async getEdgesBatch(entityIds: string[], direction: 'in' | 'out' | 'both' = 'both'): Promise<SemanticEdge[]> {
    if (entityIds.length === 0) return []
    const placeholders = entityIds.map((_, i) => `$${i + 1}`).join(',')
    let where: string
    if (direction === 'out') {
      where = `source_entity_id IN (${placeholders})`
    } else if (direction === 'in') {
      where = `target_entity_id IN (${placeholders})`
    } else {
      where = `(source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`
    }
    const rows = await this.sql(
      `SELECT * FROM ${this.edgesTable} WHERE ${where} AND invalid_at IS NULL`,
      entityIds
    )
    return rows.map(mapRowToEdge)
  }

  async findEdges(sourceId: string, targetId: string, relation?: string): Promise<SemanticEdge[]> {
    const conditions = ['source_entity_id = $1', 'target_entity_id = $2']
    const params: unknown[] = [sourceId, targetId]
    if (relation) {
      params.push(relation)
      conditions.push(`relation = $${params.length}`)
    }
    const rows = await this.sql(
      `SELECT * FROM ${this.edgesTable} WHERE ${conditions.join(' AND ')}`,
      params
    )
    return rows.map(mapRowToEdge)
  }

  async invalidateEdge(id: string, invalidAt?: Date): Promise<void> {
    await this.sql(
      `UPDATE ${this.edgesTable} SET invalid_at = $2, updated_at = NOW() WHERE id = $1`,
      [id, (invalidAt ?? new Date()).toISOString()]
    )
  }
}

// ── Row Mappers ──

function mapRowToMemory(row: Record<string, unknown>): MemoryRecord {
  // Build scope from explicit identity columns (preferred) with JSONB fallback
  const scope = rowToIdentity(row)
  const base: MemoryRecord = {
    id: row.id as string,
    category: row.category as MemoryRecord['category'],
    status: row.status as MemoryRecord['status'],
    content: row.content as string,
    embedding: undefined, // Don't return vectors — too large
    importance: row.importance as number,
    accessCount: row.access_count as number,
    lastAccessedAt: new Date(row.last_accessed_at as string),
    metadata: parseJson(row.metadata),
    scope,
    visibility: (row.visibility as MemoryRecord['visibility']) ?? 'user',
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
      sessionId: (row.episodic_session_id as string) ?? undefined,
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
    embedding: undefined,
    scope: rowToIdentity(row),
    visibility: (row.visibility as SemanticEntity['visibility']) ?? 'tenant',
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
    sourceEntityId: row.source_entity_id as string,
    targetEntityId: row.target_entity_id as string,
    relation: row.relation as string,
    weight: row.weight as number,
    properties: parseJson(row.properties),
    scope: rowToIdentity(row),
    visibility: (row.visibility as SemanticEdge['visibility']) ?? 'tenant',
    evidence: row.evidence as string[] ?? [],
    temporal: {
      validAt: new Date(row.valid_at as string),
      invalidAt: row.invalid_at ? new Date(row.invalid_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
      expiredAt: undefined,
    },
  }
}

// ── Helpers ──

function parseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'string') return JSON.parse(val)
  return (val ?? {}) as Record<string, unknown>
}

function buildMemoryWhere(
  filter: MemoryFilter,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`

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
  if (filter.sessionId) {
    params.push(filter.sessionId)
    conditions.push(`session_id = ${p()}`)
  } else if (filter.scope?.sessionId) {
    params.push(filter.scope.sessionId)
    conditions.push(`session_id = ${p()}`)
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
 * Build WHERE conditions from a d8umIdentity for entity/edge queries.
 * Only adds conditions for non-null identity fields.
 */
function buildIdentityWhere(
  identity: d8umIdentity,
  paramOffset = 0
): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const p = () => `$${paramOffset + params.length}`

  if (identity.tenantId) { params.push(identity.tenantId); conditions.push(`tenant_id = ${p()}`) }
  if (identity.groupId) { params.push(identity.groupId); conditions.push(`group_id = ${p()}`) }
  if (identity.userId) { params.push(identity.userId); conditions.push(`user_id = ${p()}`) }
  if (identity.agentId) { params.push(identity.agentId); conditions.push(`agent_id = ${p()}`) }
  if (identity.sessionId) { params.push(identity.sessionId); conditions.push(`session_id = ${p()}`) }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

/**
 * Extract identity from a DB row's explicit columns.
 */
function rowToIdentity(row: Record<string, unknown>): d8umIdentity {
  const id: d8umIdentity = {}
  if (row.tenant_id) id.tenantId = row.tenant_id as string
  if (row.group_id) id.groupId = row.group_id as string
  if (row.user_id) id.userId = row.user_id as string
  if (row.agent_id) id.agentId = row.agent_id as string
  if (row.session_id) id.sessionId = row.session_id as string
  return id
}
