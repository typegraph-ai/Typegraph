import type { VectorStoreAdapter, SearchOpts, UndeployResult } from '@d8um-ai/core'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@d8um-ai/core'
import type { Bucket } from '@d8um-ai/core'
import type { Job, JobRun } from '@d8um-ai/core'
import type { DocumentJobRelation, DocumentJobRelationFilter } from '@d8um-ai/core'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { SqliteHashStore } from './hash-store.js'
import {
  REGISTRY_SQL,
  MODEL_CHUNKS_SQL,
  MODEL_VEC_SQL,
  HASH_TABLE_SQL,
  BUCKETS_TABLE_SQL,
  JOBS_TABLE_SQL,
  JOB_RUNS_TABLE_SQL,
  DOCUMENT_JOB_RELATIONS_TABLE_SQL,
  sanitizeModelKey,
} from './migrations.js'

export interface SqliteVecAdapterConfig {
  /** Path to the SQLite database file. Defaults to ':memory:'. */
  dbPath?: string | undefined
  /** Table prefix for chunk tables. Defaults to 'd8um_chunks'. */
  tablePrefix?: string | undefined
  /** Table name for the hash store. Defaults to 'd8um_hashes'. */
  hashesTable?: string | undefined
  bucketsTable?: string | undefined
  jobsTable?: string | undefined
  jobRunsTable?: string | undefined
  relationsTable?: string | undefined
}

export class SqliteVecAdapter implements VectorStoreAdapter {
  readonly hashStore: SqliteHashStore

  private db: Database.Database
  private tablePrefix: string
  private hashesTable: string
  private registryTable: string
  private bucketsTable: string
  private jobsTable: string
  private jobRunsTable: string
  private relationsTable: string

  /** model key → { chunksTable, vecTable } */
  private modelTables = new Map<string, { chunksTable: string; vecTable: string }>()

  constructor(config: SqliteVecAdapterConfig = {}) {
    this.db = new Database(config.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    sqliteVec.load(this.db)

    this.tablePrefix = config.tablePrefix ?? 'd8um_chunks'
    this.hashesTable = config.hashesTable ?? 'd8um_hashes'
    this.bucketsTable = config.bucketsTable ?? 'd8um_buckets'
    this.jobsTable = config.jobsTable ?? 'd8um_jobs'
    this.jobRunsTable = config.jobRunsTable ?? 'd8um_job_runs'
    this.relationsTable = config.relationsTable ?? 'd8um_document_job_relations'
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new SqliteHashStore(this.db, this.hashesTable)
  }

  async deploy(): Promise<void> {
    this.db.exec(REGISTRY_SQL(this.registryTable))
    this.db.exec(HASH_TABLE_SQL(this.hashesTable))
    this.db.exec(BUCKETS_TABLE_SQL(this.bucketsTable))
    this.db.exec(JOBS_TABLE_SQL(this.jobsTable))
    this.db.exec(JOB_RUNS_TABLE_SQL(this.jobRunsTable))
    this.db.exec(DOCUMENT_JOB_RELATIONS_TABLE_SQL(this.relationsTable))
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
    } catch {
      // Registry table doesn't exist — nothing to undeploy
      return { success: true, message: 'No d8um tables found.' }
    }

    // Check all tables for data
    const staticTables = [
      this.registryTable,
      this.hashesTable,
      `${this.hashesTable}_run_times`,
      this.bucketsTable,
      this.jobsTable,
      this.jobRunsTable,
      this.relationsTable,
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
      } catch {
        // Table doesn't exist — skip
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
    this.db.exec(`DROP TABLE IF EXISTS ${this.relationsTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.jobRunsTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.jobsTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.bucketsTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.hashesTable}_run_times`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.hashesTable}`)
    this.db.exec(`DROP TABLE IF EXISTS ${this.registryTable}`)

    this.modelTables.clear()

    return { success: true, message: 'All d8um tables dropped.' }
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

  async upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const { chunksTable, vecTable } = this.getTables(model)

    const upsertChunk = this.db.prepare(
      `INSERT INTO ${chunksTable}
        (id, bucket_id, tenant_id, document_id, idempotency_key, content,
         embedding_model, chunk_index, total_chunks, metadata, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET
        id              = excluded.id,
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
        const id = crypto.randomUUID()
        upsertChunk.run(
          id,
          chunk.bucketId,
          chunk.tenantId ?? null,
          chunk.documentId,
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
      `INSERT INTO ${this.bucketsTable} (id, name, description, status, tenant_id, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         status = excluded.status, tenant_id = excluded.tenant_id, updated_at = datetime('now')`
    ).run(bucket.id, bucket.name, bucket.description ?? null, bucket.status, bucket.tenantId ?? null)
    return bucket
  }

  async getBucket(id: string): Promise<Bucket | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.bucketsTable} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return { id: row.id as string, name: row.name as string, description: (row.description as string) ?? undefined, status: row.status as Bucket['status'], tenantId: (row.tenant_id as string) ?? undefined }
  }

  async listBuckets(tenantId?: string): Promise<Bucket[]> {
    const rows = tenantId
      ? this.db.prepare(`SELECT * FROM ${this.bucketsTable} WHERE tenant_id = ? ORDER BY created_at`).all(tenantId) as Record<string, unknown>[]
      : this.db.prepare(`SELECT * FROM ${this.bucketsTable} ORDER BY created_at`).all() as Record<string, unknown>[]
    return rows.map(r => ({ id: r.id as string, name: r.name as string, description: (r.description as string) ?? undefined, status: r.status as Bucket['status'], tenantId: (r.tenant_id as string) ?? undefined }))
  }

  async deleteBucket(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.bucketsTable} WHERE id = ?`).run(id)
  }

  // --- Job persistence ---

  async upsertJob(job: Job): Promise<Job> {
    this.db.prepare(
      `INSERT INTO ${this.jobsTable}
        (id, tenant_id, bucket_id, type, name, description, config, schedule,
         status, last_run_at, next_run_at, run_count, last_error, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         tenant_id=excluded.tenant_id, bucket_id=excluded.bucket_id, type=excluded.type,
         name=excluded.name, description=excluded.description, config=excluded.config,
         schedule=excluded.schedule, status=excluded.status, last_run_at=excluded.last_run_at,
         next_run_at=excluded.next_run_at, run_count=excluded.run_count,
         last_error=excluded.last_error, updated_at=datetime('now')`
    ).run(
      job.id, job.tenantId ?? null, job.bucketId ?? null, job.type, job.name,
      job.description ?? null, JSON.stringify(job.config), job.schedule ?? null,
      job.status, job.lastRunAt?.toISOString() ?? null, job.nextRunAt?.toISOString() ?? null,
      job.runCount, job.lastError ?? null
    )
    return job
  }

  async getJob(id: string): Promise<Job | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.jobsTable} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return mapSqliteRowToJob(row)
  }

  async listJobs(filter?: { bucketId?: string; type?: string; tenantId?: string }): Promise<Job[]> {
    let query = `SELECT * FROM ${this.jobsTable}`
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.bucketId) { conditions.push('bucket_id = ?'); params.push(filter.bucketId) }
    if (filter?.type) { conditions.push('type = ?'); params.push(filter.type) }
    if (filter?.tenantId) { conditions.push('tenant_id = ?'); params.push(filter.tenantId) }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`
    query += ' ORDER BY created_at'
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[]
    return rows.map(mapSqliteRowToJob)
  }

  async deleteJob(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.jobsTable} WHERE id = ?`).run(id)
  }

  // --- Job run history ---

  async createJobRun(run: JobRun): Promise<JobRun> {
    this.db.prepare(
      `INSERT INTO ${this.jobRunsTable}
        (id, job_id, bucket_id, status, summary, documents_created, documents_updated,
         documents_deleted, metrics, error, duration_ms, started_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      run.id, run.jobId, run.bucketId ?? null, run.status, run.summary ?? null,
      run.documentsCreated, run.documentsUpdated, run.documentsDeleted,
      JSON.stringify(run.metrics ?? {}), run.error ?? null, run.durationMs ?? null,
      run.startedAt.toISOString(), run.completedAt?.toISOString() ?? null
    )
    return run
  }

  async updateJobRun(id: string, update: Partial<JobRun>): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (update.status !== undefined) { sets.push('status = ?'); params.push(update.status) }
    if (update.summary !== undefined) { sets.push('summary = ?'); params.push(update.summary) }
    if (update.documentsCreated !== undefined) { sets.push('documents_created = ?'); params.push(update.documentsCreated) }
    if (update.documentsUpdated !== undefined) { sets.push('documents_updated = ?'); params.push(update.documentsUpdated) }
    if (update.documentsDeleted !== undefined) { sets.push('documents_deleted = ?'); params.push(update.documentsDeleted) }
    if (update.metrics !== undefined) { sets.push('metrics = ?'); params.push(JSON.stringify(update.metrics)) }
    if (update.error !== undefined) { sets.push('error = ?'); params.push(update.error) }
    if (update.durationMs !== undefined) { sets.push('duration_ms = ?'); params.push(update.durationMs) }
    if (update.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(update.completedAt.toISOString()) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE ${this.jobRunsTable} SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  async listJobRuns(jobId: string, limit?: number): Promise<JobRun[]> {
    const rows = this.db.prepare(
      `SELECT * FROM ${this.jobRunsTable} WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`
    ).all(jobId, limit ?? 50) as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as string, jobId: r.job_id as string,
      bucketId: (r.bucket_id as string) ?? undefined, status: r.status as JobRun['status'],
      summary: (r.summary as string) ?? undefined,
      documentsCreated: r.documents_created as number, documentsUpdated: r.documents_updated as number,
      documentsDeleted: r.documents_deleted as number,
      metrics: JSON.parse((r.metrics as string) || '{}'), error: (r.error as string) ?? undefined,
      durationMs: (r.duration_ms as number) ?? undefined, startedAt: new Date(r.started_at as string),
      completedAt: r.completed_at ? new Date(r.completed_at as string) : undefined,
    }))
  }

  // --- Document-Job relations ---

  async upsertDocumentJobRelation(relation: DocumentJobRelation): Promise<void> {
    this.db.prepare(
      `INSERT INTO ${this.relationsTable} (document_id, job_id, relation, timestamp)
       VALUES (?,?,?,?)
       ON CONFLICT (document_id, job_id) DO UPDATE SET relation = excluded.relation, timestamp = excluded.timestamp`
    ).run(relation.documentId, relation.jobId, relation.relation, relation.timestamp.toISOString())
  }

  async getDocumentJobRelations(filter: DocumentJobRelationFilter): Promise<DocumentJobRelation[]> {
    let query = `SELECT * FROM ${this.relationsTable}`
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.documentId) { conditions.push('document_id = ?'); params.push(filter.documentId) }
    if (filter.jobId) { conditions.push('job_id = ?'); params.push(filter.jobId) }
    if (filter.relation) { conditions.push('relation = ?'); params.push(filter.relation) }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[]
    return rows.map(r => ({
      documentId: r.document_id as string, jobId: r.job_id as string,
      relation: r.relation as DocumentJobRelation['relation'],
      timestamp: new Date(r.timestamp as string),
    }))
  }

  async deleteDocumentJobRelations(filter: { jobId: string }): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.relationsTable} WHERE job_id = ?`).run(filter.jobId)
  }

  async getOrphanedDocumentIds(jobId: string): Promise<string[]> {
    const rows = this.db.prepare(
      `SELECT r1.document_id FROM ${this.relationsTable} r1
       WHERE r1.job_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM ${this.relationsTable} r2
           WHERE r2.document_id = r1.document_id AND r2.job_id != ?
         )`
    ).all(jobId, jobId) as Record<string, unknown>[]
    return rows.map(r => r.document_id as string)
  }

  async destroy(): Promise<void> {
    this.db.close()
  }
}

function mapSqliteRowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    bucketId: (row.bucket_id as string) ?? undefined,
    type: row.type as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    config: JSON.parse((row.config as string) || '{}'),
    schedule: (row.schedule as string) ?? undefined,
    status: row.status as Job['status'],
    lastRunAt: row.last_run_at ? new Date(row.last_run_at as string) : undefined,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at as string) : undefined,
    runCount: row.run_count as number,
    lastError: (row.last_error as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
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
  if (filter.documentId != null) {
    conditions.push(`document_id = ?`)
    params.push(filter.documentId)
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

function mapRowToScoredChunk(row: Record<string, unknown>): ScoredChunk {
  // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
  // Convert to similarity: 1 - (distance / 2) for cosine, or just 1 - distance for common usage
  const distance = row.distance as number
  const similarity = 1 - distance

  return {
    idempotencyKey: row.idempotency_key as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    documentId: row.document_id as string,
    content: row.content as string,
    embedding: [], // Don't return the full vector
    embeddingModel: row.embedding_model as string,
    chunkIndex: row.chunk_index as number,
    totalChunks: row.total_chunks as number,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    indexedAt: new Date(row.indexed_at as string),
    scores: {
      vector: similarity,
    },
  }
}
