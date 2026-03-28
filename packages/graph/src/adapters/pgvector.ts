/**
 * PostgreSQL + pgvector implementation of MemoryStoreAdapter.
 * Provides persistent storage for memories, semantic entities, and edges.
 *
 * Uses the same SqlExecutor pattern as @d8um/adapter-pgvector for
 * driver-agnostic Postgres access (Neon, node-postgres, Drizzle, etc.).
 */

import type { MemoryStoreAdapter, MemoryFilter, MemorySearchOpts } from '../types/adapter.js'
import type { MemoryRecord, SemanticEntity, SemanticEdge } from '../types/memory.js'
import type { d8umIdentity } from '@d8um/core'

type SqlExecutor = (
  query: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>

export interface PgMemoryAdapterConfig {
  sql: SqlExecutor
  memoriesTable?: string | undefined
  entitiesTable?: string | undefined
  edgesTable?: string | undefined
}

// ── DDL ──

const MEMORIES_DDL = (t: string) => `
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
    scope            JSONB NOT NULL,
    -- Episodic
    event_type       TEXT,
    participants     TEXT[],
    session_id       TEXT,
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

  CREATE INDEX IF NOT EXISTS ${t}_category_idx ON ${t} (category);
  CREATE INDEX IF NOT EXISTS ${t}_status_idx ON ${t} (status);
  CREATE INDEX IF NOT EXISTS ${t}_session_idx ON ${t} (session_id);
  CREATE INDEX IF NOT EXISTS ${t}_subject_idx ON ${t} (subject);
`

const ENTITIES_DDL = (t: string) => `
  CREATE TABLE IF NOT EXISTS ${t} (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    aliases     TEXT[] DEFAULT '{}',
    properties  JSONB NOT NULL DEFAULT '{}',
    embedding   VECTOR,
    scope       JSONB NOT NULL,
    valid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${t}_name_idx ON ${t} (name);
  CREATE INDEX IF NOT EXISTS ${t}_type_idx ON ${t} (entity_type);
`

const EDGES_DDL = (t: string) => `
  CREATE TABLE IF NOT EXISTS ${t} (
    id               TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation         TEXT NOT NULL,
    weight           REAL NOT NULL DEFAULT 1.0,
    properties       JSONB NOT NULL DEFAULT '{}',
    scope            JSONB NOT NULL,
    evidence         TEXT[] DEFAULT '{}',
    valid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalid_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ${t}_source_idx ON ${t} (source_entity_id);
  CREATE INDEX IF NOT EXISTS ${t}_target_idx ON ${t} (target_entity_id);
  CREATE INDEX IF NOT EXISTS ${t}_relation_idx ON ${t} (relation);
`

// ── Adapter Implementation ──

export class PgMemoryStoreAdapter implements MemoryStoreAdapter {
  private sql: SqlExecutor
  private memoriesTable: string
  private entitiesTable: string
  private edgesTable: string

  constructor(config: PgMemoryAdapterConfig) {
    this.sql = config.sql
    this.memoriesTable = config.memoriesTable ?? 'd8um_memories'
    this.entitiesTable = config.entitiesTable ?? 'd8um_semantic_entities'
    this.edgesTable = config.edgesTable ?? 'd8um_semantic_edges'
  }

  async initialize(): Promise<void> {
    // Neon cannot execute multi-statement prepared statements,
    // so split each DDL block on semicolons and execute individually.
    const allDdl = [
      MEMORIES_DDL(this.memoriesTable),
      ENTITIES_DDL(this.entitiesTable),
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
  }

  // ── CRUD ──

  async upsert(record: MemoryRecord): Promise<MemoryRecord> {
    const embeddingStr = record.embedding ? `[${record.embedding.join(',')}]` : null
    const rows = await this.sql(
      `INSERT INTO ${this.memoriesTable}
        (id, category, status, content, embedding, importance, access_count,
         last_accessed_at, metadata, scope,
         event_type, participants, session_id, sequence, consolidated_at,
         subject, predicate, object, confidence, source_memory_ids,
         trigger, steps, success_count, failure_count, last_outcome,
         valid_at, invalid_at, expired_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, content = EXCLUDED.content,
         embedding = EXCLUDED.embedding, importance = EXCLUDED.importance,
         access_count = EXCLUDED.access_count, last_accessed_at = EXCLUDED.last_accessed_at,
         metadata = EXCLUDED.metadata, scope = EXCLUDED.scope,
         event_type = EXCLUDED.event_type, participants = EXCLUDED.participants,
         session_id = EXCLUDED.session_id, sequence = EXCLUDED.sequence,
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
        // Episodic
        (record as any).eventType ?? null,
        (record as any).participants ?? null,
        (record as any).sessionId ?? null,
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
        (id, name, entity_type, aliases, properties, embedding, scope, valid_at, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
         aliases = EXCLUDED.aliases, properties = EXCLUDED.properties,
         embedding = EXCLUDED.embedding, scope = EXCLUDED.scope,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at, updated_at = NOW()
       RETURNING *`,
      [
        entity.id, entity.name, entity.entityType,
        entity.aliases, JSON.stringify(entity.properties),
        embeddingStr, JSON.stringify(entity.scope),
        entity.temporal.validAt.toISOString(),
        entity.temporal.invalidAt?.toISOString() ?? null,
      ]
    )
    return mapRowToEntity(rows[0]!)
  }

  async getEntity(id: string): Promise<SemanticEntity | null> {
    const rows = await this.sql(`SELECT * FROM ${this.entitiesTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToEntity(rows[0]!) : null
  }

  async findEntities(query: string, scope: d8umIdentity, limit?: number): Promise<SemanticEntity[]> {
    const rows = await this.sql(
      `SELECT * FROM ${this.entitiesTable}
       WHERE (name ILIKE $1 OR $1 = ANY(aliases))
         AND scope @> $2::jsonb
         AND invalid_at IS NULL
       LIMIT $3`,
      [`%${query}%`, JSON.stringify(scope), limit ?? 20]
    )
    return rows.map(mapRowToEntity)
  }

  async searchEntities(embedding: number[], scope: d8umIdentity, limit?: number): Promise<SemanticEntity[]> {
    const vectorStr = `[${embedding.join(',')}]`
    const rows = await this.sql(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM ${this.entitiesTable}
       WHERE embedding IS NOT NULL
         AND scope @> $2::jsonb
         AND invalid_at IS NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vectorStr, JSON.stringify(scope), limit ?? 20]
    )
    return rows.map(mapRowToEntity)
  }

  // ── Edge Storage ──

  async upsertEdge(edge: SemanticEdge): Promise<SemanticEdge> {
    const rows = await this.sql(
      `INSERT INTO ${this.edgesTable}
        (id, source_entity_id, target_entity_id, relation, weight, properties,
         scope, evidence, valid_at, invalid_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (id) DO UPDATE SET
         source_entity_id = EXCLUDED.source_entity_id,
         target_entity_id = EXCLUDED.target_entity_id,
         relation = EXCLUDED.relation, weight = EXCLUDED.weight,
         properties = EXCLUDED.properties, scope = EXCLUDED.scope,
         evidence = EXCLUDED.evidence, valid_at = EXCLUDED.valid_at,
         invalid_at = EXCLUDED.invalid_at, updated_at = NOW()
       RETURNING *`,
      [
        edge.id, edge.sourceEntityId, edge.targetEntityId,
        edge.relation, edge.weight, JSON.stringify(edge.properties),
        JSON.stringify(edge.scope), edge.evidence,
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
    scope: parseJson(row.scope) as d8umIdentity,
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
      sessionId: (row.session_id as string) ?? undefined,
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
  return {
    id: row.id as string,
    name: row.name as string,
    entityType: row.entity_type as string,
    aliases: row.aliases as string[] ?? [],
    properties: parseJson(row.properties),
    embedding: undefined,
    scope: parseJson(row.scope) as d8umIdentity,
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
    scope: parseJson(row.scope) as d8umIdentity,
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

  if (filter.scope) {
    params.push(JSON.stringify(filter.scope))
    conditions.push(`scope @> ${p()}::jsonb`)
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
