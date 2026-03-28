import type { VectorStoreAdapter, SearchOpts, ScoredChunkWithDocument, UndeployResult } from '@d8um/core'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@d8um/core'
import type { d8umDocument, DocumentFilter, DocumentStatus, UpsertDocumentInput } from '@d8um/core'
import type { Bucket } from '@d8um/core'
import type { Job, JobRun } from '@d8um/core'
import type { DocumentJobRelation, DocumentJobRelationFilter } from '@d8um/core'
import {
  REGISTRY_SQL, MODEL_TABLE_SQL, HASH_TABLE_SQL, DOCUMENTS_TABLE_SQL,
  BUCKETS_TABLE_SQL, JOBS_TABLE_SQL, JOB_RUNS_TABLE_SQL, DOCUMENT_JOB_RELATIONS_TABLE_SQL,
  sanitizeModelKey,
} from './migrations.js'
import { PgHashStore } from './hash-store.js'
import { PgDocumentStore, buildDocWhere } from './document-store.js'

/**
 * A function that runs a parameterized SQL query and returns rows.
 * Bring your own Postgres driver - Neon, node-postgres, Drizzle, etc.
 *
 * @example
 * ```ts
 * // Neon serverless
 * import { neon } from '@neondatabase/serverless'
 * const sql: SqlExecutor = neon(process.env.DATABASE_URL)
 *
 * // node-postgres
 * import { Pool } from 'pg'
 * const pool = new Pool({ connectionString: '...' })
 * const sql: SqlExecutor = (q, p) => pool.query(q, p).then(r => r.rows)
 * ```
 */
export type SqlExecutor = (
  query: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>

export interface PgVectorAdapterConfig {
  sql: SqlExecutor
  /** Optional transaction wrapper for drivers that need explicit transaction blocks.
   *  Required for iterative HNSW scan (SET LOCAL needs a transaction). */
  transaction?: (fn: (sql: SqlExecutor) => Promise<unknown>) => Promise<unknown>
  tablePrefix?: string | undefined
  hashesTable?: string | undefined
  documentsTable?: string | undefined
  bucketsTable?: string | undefined
  jobsTable?: string | undefined
  jobRunsTable?: string | undefined
  relationsTable?: string | undefined
  /** Max job runs to keep per job. Oldest pruned on createJobRun(). Default: 100. */
  maxRunsPerJob?: number | undefined
}

export class PgVectorAdapter implements VectorStoreAdapter {
  private sql: SqlExecutor
  private transaction?: PgVectorAdapterConfig['transaction']
  readonly hashStore: PgHashStore
  readonly documentStore: PgDocumentStore
  private tablePrefix: string
  private hashesTable: string
  private documentsTable: string
  private registryTable: string
  private bucketsTable: string
  private jobsTable: string
  private jobRunsTable: string
  private relationsTable: string
  private maxRunsPerJob: number

  /** model key → table name */
  private modelTables = new Map<string, string>()

  constructor(config: PgVectorAdapterConfig) {
    this.sql = config.sql
    this.transaction = config.transaction
    this.tablePrefix = config.tablePrefix ?? 'd8um_chunks'
    this.hashesTable = config.hashesTable ?? 'd8um_hashes'
    this.documentsTable = config.documentsTable ?? 'd8um_documents'
    this.bucketsTable = config.bucketsTable ?? 'd8um_buckets'
    this.jobsTable = config.jobsTable ?? 'd8um_jobs'
    this.jobRunsTable = config.jobRunsTable ?? 'd8um_job_runs'
    this.relationsTable = config.relationsTable ?? 'd8um_document_job_relations'
    this.maxRunsPerJob = config.maxRunsPerJob ?? 100
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new PgHashStore(this.sql, this.hashesTable)
    this.documentStore = new PgDocumentStore(this.sql, this.documentsTable)
  }

  private async execStatements(ddl: string): Promise<void> {
    const stmts = ddl.split(';').map(s => s.trim()).filter(Boolean)
    for (const stmt of stmts) {
      await this.sql(stmt)
    }
  }

  async deploy(): Promise<void> {
    await this.sql(`CREATE EXTENSION IF NOT EXISTS vector`)
    await this.execStatements(REGISTRY_SQL(this.registryTable))
    await this.execStatements(HASH_TABLE_SQL(this.hashesTable))
    await this.execStatements(DOCUMENTS_TABLE_SQL(this.documentsTable))
    await this.execStatements(BUCKETS_TABLE_SQL(this.bucketsTable))
    await this.execStatements(JOBS_TABLE_SQL(this.jobsTable))
    await this.execStatements(JOB_RUNS_TABLE_SQL(this.jobRunsTable))
    await this.execStatements(DOCUMENT_JOB_RELATIONS_TABLE_SQL(this.relationsTable))
    await this.hashStore.initialize()
  }

  async connect(): Promise<void> {
    const rows = await this.sql(`SELECT model_key, table_name FROM ${this.registryTable}`)
    for (const row of rows) {
      this.modelTables.set(row.model_key as string, row.table_name as string)
    }
  }

  async undeploy(): Promise<UndeployResult> {
    // Discover dynamic model tables from registry before dropping it
    let dynamicTables: string[] = []
    try {
      const rows = await this.sql(`SELECT table_name FROM ${this.registryTable}`)
      dynamicTables = rows.map(r => r.table_name as string)
    } catch {
      // Registry table may not exist — nothing to undeploy
      return { success: true, message: 'No d8um tables found.' }
    }

    // Check all tables for data
    const allTables = [
      ...dynamicTables,
      this.registryTable,
      this.hashesTable,
      `${this.hashesTable}_run_times`,
      this.documentsTable,
      this.bucketsTable,
      this.jobsTable,
      this.jobRunsTable,
      this.relationsTable,
    ]

    const tablesWithData: string[] = []
    for (const table of allTables) {
      try {
        const rows = await this.sql(`SELECT COUNT(*)::int AS count FROM ${table}`)
        if ((rows[0]?.count as number) > 0) {
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

    // Drop dynamic model tables first, then static tables
    for (const table of dynamicTables) {
      await this.sql(`DROP TABLE IF EXISTS ${table}`)
    }
    await this.sql(`DROP TABLE IF EXISTS ${this.relationsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.jobRunsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.jobsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.bucketsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.documentsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.hashesTable}_run_times`)
    await this.sql(`DROP TABLE IF EXISTS ${this.hashesTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.registryTable}`)

    this.modelTables.clear()

    return { success: true, message: 'All d8um tables dropped.' }
  }

  async ensureModel(model: string, dimensions: number): Promise<void> {
    const key = sanitizeModelKey(model)
    if (this.modelTables.has(key)) return

    const tableName = `${this.tablePrefix}_${key}`
    await this.execStatements(MODEL_TABLE_SQL(tableName, dimensions))
    await this.sql(
      `INSERT INTO ${this.registryTable} (model_key, model_id, table_name, dimensions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (model_key) DO NOTHING`,
      [key, model, tableName, dimensions]
    )
    this.modelTables.set(key, tableName)
  }

  private getTable(model: string): string {
    const key = sanitizeModelKey(model)
    const table = this.modelTables.get(key)
    if (!table) throw new Error(`No table registered for model "${model}". Call ensureModel() first.`)
    return table
  }

  async upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const table = this.getTable(model)

    const sourceIds: string[] = []
    const tenantIds: (string | null)[] = []
    const documentIds: string[] = []
    const idempotencyKeys: string[] = []
    const contents: string[] = []
    const embeddings: string[] = []
    const embeddingModels: string[] = []
    const chunkIndices: number[] = []
    const totalChunks: number[] = []
    const metadatas: string[] = []
    const indexedAts: string[] = []

    for (const chunk of chunks) {
      sourceIds.push(chunk.bucketId)
      tenantIds.push(chunk.tenantId ?? null)
      documentIds.push(chunk.documentId)
      idempotencyKeys.push(chunk.idempotencyKey)
      contents.push(chunk.content)
      embeddings.push(`[${chunk.embedding.join(',')}]`)
      embeddingModels.push(chunk.embeddingModel)
      chunkIndices.push(chunk.chunkIndex)
      totalChunks.push(chunk.totalChunks)
      metadatas.push(JSON.stringify(chunk.metadata))
      indexedAts.push(chunk.indexedAt.toISOString())
    }

    await this.sql(
      `INSERT INTO ${table}
        (bucket_id, tenant_id, document_id, idempotency_key, content, embedding,
         embedding_model, chunk_index, total_chunks, metadata, indexed_at)
       SELECT * FROM unnest(
        $1::text[], $2::text[], $3::uuid[], $4::text[], $5::text[], $6::vector[],
        $7::text[], $8::int[], $9::int[], $10::jsonb[], $11::timestamptz[]
       )
       ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET
        content         = EXCLUDED.content,
        embedding       = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        total_chunks    = EXCLUDED.total_chunks,
        metadata        = EXCLUDED.metadata,
        indexed_at      = EXCLUDED.indexed_at`,
      [
        sourceIds, tenantIds, documentIds, idempotencyKeys, contents, embeddings,
        embeddingModels, chunkIndices, totalChunks, metadatas, indexedAts,
      ]
    )
  }

  async delete(model: string, filter: ChunkFilter): Promise<void> {
    const table = this.getTable(model)
    const { where, params } = buildWhere(filter)
    if (!where) throw new Error('delete() requires at least one filter field')
    await this.sql(`DELETE FROM ${table} WHERE ${where}`, params)
  }

  async search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
    const table = this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildWhere(opts.filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const count = opts.count

    const runQuery = async (sql: SqlExecutor): Promise<ScoredChunk[]> => {
      if (opts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }
      const paramOffset = params.length
      const rows = await sql(
        `SELECT *, 1 - (embedding <=> $${paramOffset + 1}::vector) AS similarity
         FROM ${table}
         ${filterClause}
         ORDER BY embedding <=> $${paramOffset + 1}::vector
         LIMIT $${paramOffset + 2}`,
        [...params, vectorStr, count]
      )
      return rows.map(row => mapRowToScoredChunk(row, { vector: row.similarity as number }))
    }

    if (this.transaction) {
      return this.transaction(runQuery) as Promise<ScoredChunk[]>
    }
    return runQuery(this.sql)
  }

  async hybridSearch(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts
  ): Promise<ScoredChunk[]> {
    const table = this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = opts.count
    const { where: filterWhere, params: filterParams } = buildWhere(opts.filter)
    const filterClause = filterWhere ? `AND ${filterWhere}` : ''

    // Offset param indices past filter params: $1=vectorStr, $2=query, $3=count, then filter params
    const baseOffset = 3
    const reindexedFilter = filterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )

    const runQuery = async (sql: SqlExecutor): Promise<ScoredChunk[]> => {
      if (opts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }

      const rows = await sql(
        `WITH
          tsq AS (
            SELECT websearch_to_tsquery('english', $2) AS q
          ),
          vector_ranked AS (
            SELECT *, 1 - (embedding <=> $1::vector) AS similarity,
                   ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vrank
            FROM ${table}
            WHERE TRUE ${reindexedFilter}
            ORDER BY embedding <=> $1::vector
            LIMIT 60
          ),
          keyword_ranked AS (
            SELECT *, ts_rank(search_vector, tsq.q) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, tsq.q) DESC) AS krank
            FROM ${table}, tsq
            WHERE search_vector @@ tsq.q ${reindexedFilter}
            ORDER BY ts_rank(search_vector, tsq.q) DESC
            LIMIT 60
          ),
          combined AS (
            SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked
            UNION ALL
            SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   NULL::double precision AS similarity, kw_score,
                   NULL::bigint AS vrank, krank
            FROM keyword_ranked
          ),
          scored AS (
            SELECT *,
              COALESCE(1.0 / (60 + vrank), 0) + COALESCE(1.0 / (60 + krank), 0) AS rrf_score,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY COALESCE(similarity, 0) DESC
              ) AS dedup_rank
            FROM combined
          )
        SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
               embedding_model, chunk_index, total_chunks, metadata, indexed_at,
               MAX(similarity) AS similarity,
               MAX(kw_score) AS keyword_score,
               SUM(rrf_score) AS rrf_score
        FROM scored
        WHERE dedup_rank = 1
        GROUP BY id, bucket_id, tenant_id, document_id, idempotency_key, content,
                 embedding_model, chunk_index, total_chunks, metadata, indexed_at
        ORDER BY SUM(rrf_score) DESC
        LIMIT $3`,
        [vectorStr, query, count, ...filterParams]
      )

      return rows.map(row => mapRowToScoredChunk(row, {
        vector: (row.similarity as number) ?? undefined,
        keyword: (row.keyword_score as number) ?? undefined,
        rrf: row.rrf_score as number,
      }))
    }

    if (this.transaction) {
      return this.transaction(runQuery) as Promise<ScoredChunk[]>
    }
    return runQuery(this.sql)
  }

  async countChunks(model: string, filter: ChunkFilter): Promise<number> {
    const table = this.getTable(model)
    const { where, params } = buildWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const rows = await this.sql(
      `SELECT COUNT(*)::int AS count FROM ${table} ${filterClause}`,
      params
    )
    return (rows[0]?.count as number) ?? 0
  }

  // --- Document record methods ---

  async upsertDocumentRecord(input: UpsertDocumentInput): Promise<d8umDocument> {
    return this.documentStore.upsert(input)
  }

  async getDocument(id: string): Promise<d8umDocument | null> {
    return this.documentStore.get(id)
  }

  async listDocuments(filter: DocumentFilter): Promise<d8umDocument[]> {
    return this.documentStore.list(filter)
  }

  async deleteDocuments(filter: DocumentFilter): Promise<number> {
    return this.documentStore.delete(filter)
  }

  async updateDocumentStatus(id: string, status: DocumentStatus, chunkCount?: number): Promise<void> {
    return this.documentStore.updateStatus(id, status, chunkCount)
  }

  // --- Search with document JOIN ---

  async searchWithDocuments(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts & { documentFilter?: DocumentFilter | undefined }
  ): Promise<ScoredChunkWithDocument[]> {
    const table = this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = opts.count
    const { where: chunkFilterWhere, params: chunkFilterParams } = buildWhere(opts.filter)
    const chunkFilterClause = chunkFilterWhere ? `AND ${chunkFilterWhere}` : ''
    const { where: docFilterWhere, params: docFilterParams } = buildDocWhere(opts.documentFilter ?? {})

    // Base params: $1=vector, $2=query, $3=count
    // Then chunk filter params, then doc filter params
    const baseOffset = 3
    const reindexedChunkFilter = chunkFilterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )
    const docParamOffset = baseOffset + chunkFilterParams.length
    const docFilterClause = docFilterWhere
      ? `AND ${docFilterWhere.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + docParamOffset}`)}`
      : ''

    const allParams = [vectorStr, query, count, ...chunkFilterParams, ...docFilterParams]

    const runQuery = async (sql: SqlExecutor): Promise<ScoredChunkWithDocument[]> => {
      if (opts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }

      const rows = await sql(
        `WITH
          tsq AS (
            SELECT websearch_to_tsquery('english', $2) AS q
          ),
          vector_ranked AS (
            SELECT c.*, 1 - (c.embedding <=> $1::vector) AS similarity,
                   ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector) AS vrank
            FROM ${table} c
            JOIN ${this.documentsTable} d ON c.document_id = d.id
            WHERE TRUE ${reindexedChunkFilter} ${docFilterClause}
            ORDER BY c.embedding <=> $1::vector
            LIMIT 60
          ),
          keyword_ranked AS (
            SELECT c.*, ts_rank(c.search_vector, tsq.q) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY ts_rank(c.search_vector, tsq.q) DESC) AS krank
            FROM ${table} c
            CROSS JOIN tsq
            JOIN ${this.documentsTable} d ON c.document_id = d.id
            WHERE c.search_vector @@ tsq.q ${reindexedChunkFilter} ${docFilterClause}
            ORDER BY ts_rank(c.search_vector, tsq.q) DESC
            LIMIT 60
          ),
          combined AS (
            SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked
            UNION ALL
            SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   NULL::double precision AS similarity, kw_score,
                   NULL::bigint AS vrank, krank
            FROM keyword_ranked
          ),
          scored AS (
            SELECT *,
              COALESCE(1.0 / (60 + vrank), 0) + COALESCE(1.0 / (60 + krank), 0) AS rrf_score,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY COALESCE(similarity, 0) DESC
              ) AS dedup_rank
            FROM combined
          ),
          final_chunks AS (
            SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   MAX(similarity) AS similarity,
                   MAX(kw_score) AS keyword_score,
                   SUM(rrf_score) AS rrf_score
            FROM scored
            WHERE dedup_rank = 1
            GROUP BY id, bucket_id, tenant_id, document_id, idempotency_key, content,
                     embedding_model, chunk_index, total_chunks, metadata, indexed_at
            ORDER BY SUM(rrf_score) DESC
            LIMIT $3
          )
        SELECT fc.*,
               d.id AS doc_id, d.title AS doc_title, d.url AS doc_url,
               d.content_hash AS doc_content_hash, d.chunk_count AS doc_chunk_count,
               d.status AS doc_status, d.scope AS doc_scope,
               d.group_id AS doc_group_id, d.user_id AS doc_user_id,
               d.document_type AS doc_document_type, d.source_type AS doc_source_type,
               d.indexed_at AS doc_indexed_at, d.created_at AS doc_created_at,
               d.updated_at AS doc_updated_at, d.metadata AS doc_metadata
        FROM final_chunks fc
        JOIN ${this.documentsTable} d ON fc.document_id = d.id
        ORDER BY fc.rrf_score DESC`,
        allParams
      )

      return rows.map(row => ({
        ...mapRowToScoredChunk(row, {
          vector: (row.similarity as number) ?? undefined,
          keyword: (row.keyword_score as number) ?? undefined,
          rrf: row.rrf_score as number,
        }),
        document: mapRowToDocument(row),
      }))
    }

    if (this.transaction) {
      return this.transaction(runQuery) as Promise<ScoredChunkWithDocument[]>
    }
    return runQuery(this.sql)
  }

  // --- Chunk range fetch (for neighbor expansion) ---

  async getChunksByRange(
    model: string,
    documentId: string,
    fromIndex: number,
    toIndex: number
  ): Promise<ScoredChunk[]> {
    const table = this.getTable(model)
    const rows = await this.sql(
      `SELECT * FROM ${table}
       WHERE document_id = $1 AND chunk_index >= $2 AND chunk_index <= $3
       ORDER BY chunk_index`,
      [documentId, fromIndex, toIndex]
    )
    return rows.map(row => mapRowToScoredChunk(row, {}))
  }

  // --- Bucket persistence ---

  async upsertBucket(bucket: Bucket): Promise<Bucket> {
    const rows = await this.sql(
      `INSERT INTO ${this.bucketsTable} (id, name, description, status, tenant_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         status = EXCLUDED.status, tenant_id = EXCLUDED.tenant_id, updated_at = NOW()
       RETURNING *`,
      [bucket.id, bucket.name, bucket.description ?? null, bucket.status, bucket.tenantId ?? null]
    )
    return mapRowToBucket(rows[0]!)
  }

  async getBucket(id: string): Promise<Bucket | null> {
    const rows = await this.sql(`SELECT * FROM ${this.bucketsTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToBucket(rows[0]!) : null
  }

  async listBuckets(tenantId?: string): Promise<Bucket[]> {
    const rows = tenantId
      ? await this.sql(`SELECT * FROM ${this.bucketsTable} WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])
      : await this.sql(`SELECT * FROM ${this.bucketsTable} ORDER BY created_at`)
    return rows.map(mapRowToBucket)
  }

  async deleteBucket(id: string): Promise<void> {
    await this.sql(`DELETE FROM ${this.bucketsTable} WHERE id = $1`, [id])
  }

  // --- Job persistence ---

  async upsertJob(job: Job): Promise<Job> {
    const rows = await this.sql(
      `INSERT INTO ${this.jobsTable}
        (id, tenant_id, bucket_id, type, name, description, config, schedule,
         status, last_run_at, next_run_at, run_count, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id, bucket_id = EXCLUDED.bucket_id,
         type = EXCLUDED.type, name = EXCLUDED.name, description = EXCLUDED.description,
         config = EXCLUDED.config, schedule = EXCLUDED.schedule, status = EXCLUDED.status,
         last_run_at = EXCLUDED.last_run_at, next_run_at = EXCLUDED.next_run_at,
         run_count = EXCLUDED.run_count, last_error = EXCLUDED.last_error, updated_at = NOW()
       RETURNING *`,
      [
        job.id, job.tenantId ?? null, job.bucketId ?? null, job.type, job.name,
        job.description ?? null, JSON.stringify(job.config), job.schedule ?? null,
        job.status, job.lastRunAt?.toISOString() ?? null, job.nextRunAt?.toISOString() ?? null,
        job.runCount, job.lastError ?? null,
      ]
    )
    return mapRowToJob(rows[0]!)
  }

  async getJob(id: string): Promise<Job | null> {
    const rows = await this.sql(`SELECT * FROM ${this.jobsTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToJob(rows[0]!) : null
  }

  async listJobs(filter?: { bucketId?: string; type?: string; tenantId?: string }): Promise<Job[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.bucketId) { params.push(filter.bucketId); conditions.push(`bucket_id = $${params.length}`) }
    if (filter?.type) { params.push(filter.type); conditions.push(`type = $${params.length}`) }
    if (filter?.tenantId) { params.push(filter.tenantId); conditions.push(`tenant_id = $${params.length}`) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.sql(`SELECT * FROM ${this.jobsTable} ${where} ORDER BY created_at`, params)
    return rows.map(mapRowToJob)
  }

  async deleteJob(id: string): Promise<void> {
    await this.sql(`DELETE FROM ${this.jobsTable} WHERE id = $1`, [id])
  }

  // --- Job run history ---

  async createJobRun(run: JobRun): Promise<JobRun> {
    const rows = await this.sql(
      `INSERT INTO ${this.jobRunsTable}
        (id, job_id, bucket_id, status, summary, documents_created, documents_updated,
         documents_deleted, metrics, error, duration_ms, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        run.id, run.jobId, run.bucketId ?? null, run.status, run.summary ?? null,
        run.documentsCreated, run.documentsUpdated, run.documentsDeleted,
        JSON.stringify(run.metrics ?? {}), run.error ?? null, run.durationMs ?? null,
        run.startedAt.toISOString(), run.completedAt?.toISOString() ?? null,
      ]
    )

    // Prune old runs beyond maxRunsPerJob
    await this.sql(
      `DELETE FROM ${this.jobRunsTable}
       WHERE job_id = $1 AND id NOT IN (
         SELECT id FROM ${this.jobRunsTable}
         WHERE job_id = $1
         ORDER BY started_at DESC
         LIMIT $2
       )`,
      [run.jobId, this.maxRunsPerJob]
    )

    return mapRowToJobRun(rows[0]!)
  }

  async updateJobRun(id: string, update: Partial<JobRun>): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (update.status !== undefined) { params.push(update.status); sets.push(`status = $${params.length}`) }
    if (update.summary !== undefined) { params.push(update.summary); sets.push(`summary = $${params.length}`) }
    if (update.documentsCreated !== undefined) { params.push(update.documentsCreated); sets.push(`documents_created = $${params.length}`) }
    if (update.documentsUpdated !== undefined) { params.push(update.documentsUpdated); sets.push(`documents_updated = $${params.length}`) }
    if (update.documentsDeleted !== undefined) { params.push(update.documentsDeleted); sets.push(`documents_deleted = $${params.length}`) }
    if (update.metrics !== undefined) { params.push(JSON.stringify(update.metrics)); sets.push(`metrics = $${params.length}`) }
    if (update.error !== undefined) { params.push(update.error); sets.push(`error = $${params.length}`) }
    if (update.durationMs !== undefined) { params.push(update.durationMs); sets.push(`duration_ms = $${params.length}`) }
    if (update.completedAt !== undefined) { params.push(update.completedAt.toISOString()); sets.push(`completed_at = $${params.length}`) }
    if (sets.length === 0) return
    params.push(id)
    await this.sql(`UPDATE ${this.jobRunsTable} SET ${sets.join(', ')} WHERE id = $${params.length}`, params)
  }

  async listJobRuns(jobId: string, limit?: number): Promise<JobRun[]> {
    const rows = await this.sql(
      `SELECT * FROM ${this.jobRunsTable} WHERE job_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [jobId, limit ?? 50]
    )
    return rows.map(mapRowToJobRun)
  }

  // --- Document-Job relations ---

  async upsertDocumentJobRelation(relation: DocumentJobRelation): Promise<void> {
    await this.sql(
      `INSERT INTO ${this.relationsTable} (document_id, job_id, relation, timestamp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id, job_id) DO UPDATE SET relation = EXCLUDED.relation, timestamp = EXCLUDED.timestamp`,
      [relation.documentId, relation.jobId, relation.relation, relation.timestamp.toISOString()]
    )
  }

  async getDocumentJobRelations(filter: DocumentJobRelationFilter): Promise<DocumentJobRelation[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.documentId) { params.push(filter.documentId); conditions.push(`document_id = $${params.length}`) }
    if (filter.jobId) { params.push(filter.jobId); conditions.push(`job_id = $${params.length}`) }
    if (filter.relation) { params.push(filter.relation); conditions.push(`relation = $${params.length}`) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.sql(`SELECT * FROM ${this.relationsTable} ${where}`, params)
    return rows.map(r => ({
      documentId: r.document_id as string,
      jobId: r.job_id as string,
      relation: r.relation as DocumentJobRelation['relation'],
      timestamp: new Date(r.timestamp as string),
    }))
  }

  async deleteDocumentJobRelations(filter: { jobId: string }): Promise<void> {
    await this.sql(`DELETE FROM ${this.relationsTable} WHERE job_id = $1`, [filter.jobId])
  }

  async getOrphanedDocumentIds(jobId: string): Promise<string[]> {
    const rows = await this.sql(
      `SELECT r1.document_id FROM ${this.relationsTable} r1
       WHERE r1.job_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM ${this.relationsTable} r2
           WHERE r2.document_id = r1.document_id AND r2.job_id != $1
         )`,
      [jobId]
    )
    return rows.map(r => r.document_id as string)
  }

  async destroy(): Promise<void> {
    // No-op - the developer owns the connection lifecycle
  }
}

function buildWhere(filter?: ChunkFilter): { where: string; params: unknown[] } {
  if (!filter) return { where: '', params: [] }

  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.bucketId != null) {
    params.push(filter.bucketId)
    conditions.push(`bucket_id = $${params.length}`)
  }
  if (filter.tenantId != null) {
    params.push(filter.tenantId)
    conditions.push(`tenant_id = $${params.length}`)
  }
  if (filter.documentId != null) {
    params.push(filter.documentId)
    conditions.push(`document_id = $${params.length}`)
  }
  if (filter.idempotencyKey != null) {
    params.push(filter.idempotencyKey)
    conditions.push(`idempotency_key = $${params.length}`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function mapRowToScoredChunk(
  row: Record<string, unknown>,
  scores: { vector?: number; keyword?: number; rrf?: number }
): ScoredChunk {
  return {
    idempotencyKey: row.idempotency_key as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    documentId: row.document_id as string,
    content: row.content as string,
    embedding: [], // Don't return the full vector - too large and unnecessary
    embeddingModel: row.embedding_model as string,
    chunkIndex: row.chunk_index as number,
    totalChunks: row.total_chunks as number,
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>,
    indexedAt: new Date(row.indexed_at as string),
    scores: {
      vector: scores.vector,
      keyword: scores.keyword,
      rrf: scores.rrf,
    },
  }
}

function mapRowToBucket(row: Record<string, unknown>): Bucket {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Bucket['status'],
    tenantId: (row.tenant_id as string) ?? undefined,
  }
}

function mapRowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    bucketId: (row.bucket_id as string) ?? undefined,
    type: row.type as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config ?? {}) as Record<string, unknown>,
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

function mapRowToJobRun(row: Record<string, unknown>): JobRun {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    bucketId: (row.bucket_id as string) ?? undefined,
    status: row.status as JobRun['status'],
    summary: (row.summary as string) ?? undefined,
    documentsCreated: row.documents_created as number,
    documentsUpdated: row.documents_updated as number,
    documentsDeleted: row.documents_deleted as number,
    metrics: (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics ?? {}) as Record<string, unknown>,
    error: (row.error as string) ?? undefined,
    durationMs: (row.duration_ms as number) ?? undefined,
    startedAt: new Date(row.started_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
  }
}

function mapRowToDocument(row: Record<string, unknown>): d8umDocument {
  return {
    id: row.doc_id as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    title: row.doc_title as string,
    url: (row.doc_url as string) ?? undefined,
    contentHash: row.doc_content_hash as string,
    chunkCount: row.doc_chunk_count as number,
    status: row.doc_status as d8umDocument['status'],
    scope: (row.doc_scope as d8umDocument['scope']) ?? undefined,
    groupId: (row.doc_group_id as string) ?? undefined,
    userId: (row.doc_user_id as string) ?? undefined,
    documentType: (row.doc_document_type as string) ?? undefined,
    sourceType: (row.doc_source_type as string) ?? undefined,
    indexedAt: new Date(row.doc_indexed_at as string),
    createdAt: new Date(row.doc_created_at as string),
    updatedAt: new Date(row.doc_updated_at as string),
    metadata: (typeof row.doc_metadata === 'string' ? JSON.parse(row.doc_metadata) : row.doc_metadata ?? {}) as Record<string, unknown>,
  }
}
