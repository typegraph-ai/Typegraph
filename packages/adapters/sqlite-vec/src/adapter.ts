import type { VectorStoreAdapter, SearchOpts, UndeployResult } from '@typegraph-ai/sdk'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@typegraph-ai/sdk'
import type { Bucket, BucketListFilter } from '@typegraph-ai/sdk'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { SqliteHashStore } from './hash-store.js'
import {
  REGISTRY_SQL,
  MODEL_CHUNKS_SQL,
  MODEL_VEC_SQL,
  HASH_TABLE_SQL,
  BUCKETS_TABLE_SQL,
  sanitizeModelKey,
} from './migrations.js'

export interface SqliteVecAdapterConfig {
  /** Path to the SQLite database file. Defaults to ':memory:'. */
  dbPath?: string | undefined
  /** Table prefix for chunk tables. Defaults to 'typegraph_chunks'. */
  tablePrefix?: string | undefined
  /** Table name for the hash store. Defaults to 'typegraph_hashes'. */
  hashesTable?: string | undefined
  bucketsTable?: string | undefined
}

/**
 * SQLite + sqlite-vec adapter for development and testing.
 *
 * **Limitations vs PostgreSQL:**
 * - No hybrid search (BM25 keyword search unavailable)
 * - No source management (list, update, delete sources)
 * - No context passages (searchWithSources)
 * - No policy enforcement
 * - No graph/memory storage (no sqlite memory adapter — `QuerySignals.graph` and
 *   `QuerySignals.memory` require the pgvector adapter)
 *
 * Identity isolation (`tenantId`, `groupId`, `userId`, `agentId`,
 * `conversationId`, `visibility`) IS enforced — filter pushdown matches pgvector.
 *
 * Use PostgreSQL (PgVectorAdapter) for production deployments.
 */
export class SqliteVecAdapter implements VectorStoreAdapter {
  readonly hashStore: SqliteHashStore

  private db: Database.Database
  private tablePrefix: string
  private hashesTable: string
  private registryTable: string
  private bucketsTable: string
  private warned = new Set<string>()

  /** model key → { chunksTable, vecTable } */
  private modelTables = new Map<string, { chunksTable: string; vecTable: string }>()

  constructor(config: SqliteVecAdapterConfig = {}) {
    this.db = new Database(config.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    sqliteVec.load(this.db)

    this.tablePrefix = config.tablePrefix ?? 'typegraph_chunks'
    this.hashesTable = config.hashesTable ?? 'typegraph_hashes'
    this.bucketsTable = config.bucketsTable ?? 'typegraph_buckets'
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new SqliteHashStore(this.db, this.hashesTable)
  }

  private warnOnce(feature: string, message: string): void {
    if (this.warned.has(feature)) return
    this.warned.add(feature)
    console.warn(`[typegraph/sqlite] ${message} Use PostgreSQL (PgVectorAdapter) for full feature support.`)
  }

  async deploy(): Promise<void> {
    this.db.exec(REGISTRY_SQL(this.registryTable))
    this.db.exec(HASH_TABLE_SQL(this.hashesTable))
    this.db.exec(BUCKETS_TABLE_SQL(this.bucketsTable))
    await this.hashStore.initialize()
  }

  async connect(): Promise<void> {
    const rows = this.db.prepare(
      `SELECT model_key, table_name FROM ${this.registryTable}`
    ).all() as Array<{ model_key: string; table_name: string }>

    for (const row of rows) {
      this.modelTables.set(row.model_key, {
        chunksTable: row.table_name,
        vecTable: `${row.table_name}_vec`,
      })
    }
  }

  async undeploy(): Promise<UndeployResult> {
    // Discover dynamic model tables from registry before dropping it
    let dynamicTables: Array<{ chunksTable: string; vecTable: string }> = []
    try {
      const rows = this.db.prepare(
        `SELECT table_name FROM ${this.registryTable}`
      ).all() as Array<{ table_name: string }>
      dynamicTables = rows.map(r => ({
        chunksTable: r.table_name,
        vecTable: `${r.table_name}_vec`,
      }))
    } catch (err) {
      // Registry table doesn't exist — nothing to undeploy
      console.debug('[typegraph] Registry table check skipped:', err instanceof Error ? err.message : err)
      return { success: true, message: 'No typegraph tables found.' }
    }

    // Check all tables for data
    const staticTables = [
      this.registryTable,
      this.hashesTable,
      `${this.hashesTable}_run_times`,
      this.bucketsTable,
    ]
    const allCheckTables = [
      ...dynamicTables.map(t => t.chunksTable),
      ...staticTables,
    ]

    const tablesWithData: string[] = []
    for (const table of allCheckTables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
        if (row.count > 0) {
          tablesWithData.push(table)
        }
      } catch (err) {
        // Table doesn't exist — skip
        console.debug('[typegraph] Table check skipped:', err instanceof Error ? err.message : err)
      }
    }

    if (tablesWithData.length > 0) {
      return {
        success: false,
        message:
          `Cannot undeploy: tables contain data. Tables with records: ${tablesWithData.join(', ')}. ` +
          `Delete all data before calling undeploy().`,
      }
    }

    // Drop dynamic model tables first (vec virtual tables, then chunks)
    for (const { vecTable, chunksTable } of dynamicTables) {
      this.db.exec(`DROP TABLE IF EXISTS ${vecTable}`)
      this.db.exec(`DROP TABLE IF EXISTS ${chunksTable}`)
    }
    // Drop static tables
    this.db.exec(`DROP TABLE IF EXISTS ${this.bucketsTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.hashesTable}_run_times`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.hashesTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.registryTable}`)

    this.modelTables.clear()

    return { success: true, message: 'All typegraph tables dropped.' }
  }

  async ensureModel(model: string, dimensions: number): Promise<void> {
    const key = sanitizeModelKey(model)
    if (this.modelTables.has(key)) return

    const chunksTable = `${this.tablePrefix}_${key}`
    const vecTable = `${chunksTable}_vec`

    this.db.exec(MODEL_CHUNKS_SQL(chunksTable))
    this.db.exec(MODEL_VEC_SQL(vecTable, dimensions))

    this.db.prepare(
      `INSERT INTO ${this.registryTable} (model_key, model_id, table_name, dimensions)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (model_key) DO NOTHING`
    ).run(key, model, chunksTable, dimensions)

    this.modelTables.set(key, { chunksTable, vecTable })
  }

  private getTables(model: string): { chunksTable: string; vecTable: string } {
    const key = sanitizeModelKey(model)
    const tables = this.modelTables.get(key)
    if (!tables) throw new Error(`No table registered for model "${model}". Call ensureModel() first.`)
    return tables
  }

  async upsertSourceChunks(model: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const { chunksTable, vecTable } = this.getTables(model)

    const upsertChunk = this.db.prepare(
      `INSERT INTO ${chunksTable}
        (id, bucket_id, tenant_id, group_id, user_id, agent_id, conversation_id,
         source_id, idempotency_key, content,
         embedding_model, chunk_index, total_chunks, metadata, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET
        id              = excluded.id,
        tenant_id       = excluded.tenant_id,
        group_id        = excluded.group_id,
        user_id         = excluded.user_id,
        agent_id        = excluded.agent_id,
        conversation_id = excluded.conversation_id,
        source_id     = excluded.source_id,
        content         = excluded.content,
        embedding_model = excluded.embedding_model,
        total_chunks    = excluded.total_chunks,
        metadata        = excluded.metadata,
        indexed_at      = excluded.indexed_at`
    )

    const getRowid = this.db.prepare(
      `SELECT chunk_rowid FROM ${chunksTable} WHERE idempotency_key = ? AND chunk_index = ? AND bucket_id = ?`
    )

    const deleteVec = this.db.prepare(
      `DELETE FROM ${vecTable} WHERE rowid = ?`
    )

    const insertVec = this.db.prepare(
      `INSERT INTO ${vecTable} (rowid, embedding) VALUES (?, ?)`
    )

    const transaction = this.db.transaction((chunks: EmbeddedChunk[]) => {
      for (const chunk of chunks) {
        upsertChunk.run(
          chunk.id,
          chunk.bucketId,
          chunk.tenantId ?? null,
          chunk.groupId ?? null,
          chunk.userId ?? null,
          chunk.agentId ?? null,
          chunk.conversationId ?? null,
          chunk.sourceId,
          chunk.idempotencyKey,
          chunk.content,
          chunk.embeddingModel,
          chunk.chunkIndex,
          chunk.totalChunks,
          JSON.stringify(chunk.metadata),
          chunk.indexedAt.toISOString()
        )

        const row = getRowid.get(
          chunk.idempotencyKey,
          chunk.chunkIndex,
          chunk.bucketId
        ) as { chunk_rowid: number }

        const vecJson = JSON.stringify(chunk.embedding)
        // sqlite-vec requires BigInt for explicit rowid values
        const rowid = BigInt(row.chunk_rowid)
        deleteVec.run(rowid)
        insertVec.run(rowid, vecJson)
      }
    })

    transaction(chunks)
  }

  async delete(model: string, filter: ChunkFilter): Promise<void> {
    const { chunksTable, vecTable } = this.getTables(model)
    const { where, params } = buildWhere(filter)
    if (!where) throw new Error('delete() requires at least one filter field')

    // Get rowids to delete from vec table
    const rows = this.db.prepare(
      `SELECT chunk_rowid FROM ${chunksTable} WHERE ${where}`
    ).all(...params) as Array<{ chunk_rowid: number }>

    const transaction = this.db.transaction(() => {
      // Delete from vec table first
      const deleteVec = this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`)
      for (const row of rows) {
        deleteVec.run(BigInt(row.chunk_rowid))
      }
      // Delete from chunks table
      this.db.prepare(`DELETE FROM ${chunksTable} WHERE ${where}`).run(...params)
    })

    transaction()
  }

  async search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
    const { chunksTable, vecTable } = this.getTables(model)
    const vecJson = JSON.stringify(embedding)
    const count = opts.count

    // sqlite-vec KNN: use k=? constraint inside WHERE (LIMIT not supported on vec0)
    // First get KNN results from vec table, then join to chunks for full data
    const { where: filterWhere, params: filterParams } = buildWhere(opts.filter)

    if (filterWhere) {
      // With filters: get KNN candidates first, then filter via subquery
      const rows = this.db.prepare(
        `SELECT c.*, v.distance
         FROM (
           SELECT rowid, distance FROM ${vecTable}
           WHERE embedding MATCH ? AND k = ?
         ) v
         JOIN ${chunksTable} c ON c.chunk_rowid = v.rowid
         WHERE ${filterWhere}
         ORDER BY v.distance`
      ).all(vecJson, count * 3, ...filterParams) as Array<Record<string, unknown>>

      return rows.slice(0, count).map(row => mapRowToScoredChunk(row))
    }

    // Without filters: simple KNN
    const rows = this.db.prepare(
      `SELECT c.*, v.distance
       FROM (
         SELECT rowid, distance FROM ${vecTable}
         WHERE embedding MATCH ? AND k = ?
       ) v
       JOIN ${chunksTable} c ON c.chunk_rowid = v.rowid
       ORDER BY v.distance`
    ).all(vecJson, count) as Array<Record<string, unknown>>

    return rows.map(row => mapRowToScoredChunk(row))
  }

  async countChunks(model: string, filter: ChunkFilter): Promise<number> {
    const { chunksTable } = this.getTables(model)
    const { where, params } = buildWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM ${chunksTable} ${filterClause}`
    ).get(...params) as { count: number }
    return row.count
  }

  // --- Bucket persistence ---

  async upsertBucket(bucket: Bucket): Promise<Bucket> {
    this.db.prepare(
      `INSERT INTO ${this.bucketsTable} (
         id, name, description, status,
         tenant_id, group_id, user_id, agent_id, conversation_id,
         embedding_model, query_embedding_model, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         status = excluded.status,
         tenant_id = excluded.tenant_id,
         group_id = excluded.group_id,
         user_id = excluded.user_id,
         agent_id = excluded.agent_id,
         conversation_id = excluded.conversation_id,
         embedding_model = excluded.embedding_model,
         query_embedding_model = excluded.query_embedding_model,
         updated_at = datetime('now')`
    ).run(
      bucket.id,
      bucket.name,
      bucket.description ?? null,
      bucket.status,
      bucket.tenantId ?? null,
      bucket.groupId ?? null,
      bucket.userId ?? null,
      bucket.agentId ?? null,
      bucket.conversationId ?? null,
      bucket.embeddingModel ?? null,
      bucket.queryEmbeddingModel ?? null
    )
    return bucket
  }

  async getBucket(id: string): Promise<Bucket | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.bucketsTable} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return mapRowToBucket(row)
  }

  async listBuckets(filter?: BucketListFilter): Promise<Bucket[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.tenantId) { conditions.push('tenant_id = ?'); params.push(filter.tenantId) }
    if (filter?.groupId) { conditions.push('group_id = ?'); params.push(filter.groupId) }
    if (filter?.userId) { conditions.push('user_id = ?'); params.push(filter.userId) }
    if (filter?.agentId) { conditions.push('agent_id = ?'); params.push(filter.agentId) }
    if (filter?.conversationId) { conditions.push('conversation_id = ?'); params.push(filter.conversationId) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM ${this.bucketsTable}${where} ORDER BY created_at`).all(...params) as Record<string, unknown>[]
    return rows.map(r => mapRowToBucket(r))
  }

  /**
   * Delete a bucket and cascade: all chunks (in every model table), their vec rows,
   * and all hash entries for this bucket across all tenants.
   *
   * SQLite does not support cross-table ON DELETE CASCADE, so we perform this
   * manually inside a single transaction.
   */
  async deleteBucket(id: string): Promise<void> {
    const cascade = this.db.transaction(() => {
      // 1. For each model table, collect chunk rowids, then delete vec rows + chunks.
      for (const { chunksTable, vecTable } of this.modelTables.values()) {
        const rows = this.db.prepare(
          `SELECT chunk_rowid FROM ${chunksTable} WHERE bucket_id = ?`
        ).all(id) as Array<{ chunk_rowid: number }>

        if (rows.length > 0) {
          const deleteVec = this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`)
          for (const row of rows) {
            deleteVec.run(BigInt(row.chunk_rowid))
          }
          this.db.prepare(`DELETE FROM ${chunksTable} WHERE bucket_id = ?`).run(id)
        }
      }

      // 2. Delete hash entries and run-times for this bucket across all tenants.
      this.db.prepare(`DELETE FROM ${this.hashesTable} WHERE bucket_id = ?`).run(id)
      this.db.prepare(`DELETE FROM ${this.hashesTable}_run_times WHERE bucket_id = ?`).run(id)

      // 3. Delete the bucket record itself.
      this.db.prepare(`DELETE FROM ${this.bucketsTable} WHERE id = ?`).run(id)
    })

    cascade()
  }

  async destroy(): Promise<void> {
    this.db.close()
  }
}

function buildWhere(filter?: ChunkFilter): { where: string; params: unknown[] } {
  if (!filter) return { where: '', params: [] }

  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.bucketId != null) {
    conditions.push(`bucket_id = ?`)
    params.push(filter.bucketId)
  }
  if (filter.tenantId != null) {
    conditions.push(`tenant_id = ?`)
    params.push(filter.tenantId)
  }
  if (filter.groupId != null) {
    conditions.push(`group_id = ?`)
    params.push(filter.groupId)
  }
  if (filter.userId != null) {
    conditions.push(`user_id = ?`)
    params.push(filter.userId)
  }
  if (filter.agentId != null) {
    conditions.push(`agent_id = ?`)
    params.push(filter.agentId)
  }
  if (filter.conversationId != null) {
    conditions.push(`conversation_id = ?`)
    params.push(filter.conversationId)
  }
  if (filter.sourceId != null) {
    conditions.push(`source_id = ?`)
    params.push(filter.sourceId)
  }
  if (filter.idempotencyKey != null) {
    conditions.push(`idempotency_key = ?`)
    params.push(filter.idempotencyKey)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function mapRowToBucket(row: Record<string, unknown>): Bucket {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Bucket['status'],
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
    embeddingModel: (row.embedding_model as string) ?? undefined,
    queryEmbeddingModel: (row.query_embedding_model as string) ?? undefined,
  }
}

function mapRowToScoredChunk(row: Record<string, unknown>): ScoredChunk {
  // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
  // Convert to similarity: 1 - (distance / 2) for cosine, or just 1 - distance for common usage
  const distance = row.distance as number
  const similarity = 1 - distance

  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
    sourceId: row.source_id as string,
    content: row.content as string,
    embedding: [], // Don't return the full vector
    embeddingModel: row.embedding_model as string,
    chunkIndex: row.chunk_index as number,
    totalChunks: row.total_chunks as number,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    indexedAt: new Date(row.indexed_at as string),
    scores: {
      semantic: similarity,
    },
  }
}
