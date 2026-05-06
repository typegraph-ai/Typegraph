import type { VectorStoreAdapter, SearchOpts, ScoredChunkWithSource, UndeployResult } from '@typegraph-ai/sdk'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@typegraph-ai/sdk'
import type { typegraphSource, SourceFilter, SourceStatus, UpsertSourceInput } from '@typegraph-ai/sdk'
import type { Bucket } from '@typegraph-ai/sdk'
import type { Job, JobFilter, UpsertJobInput, JobStatusPatch, PaginationOpts, PaginatedResult } from '@typegraph-ai/sdk'
import { ConfigError, DEFAULT_BUCKET_ID } from '@typegraph-ai/sdk'
import {
  REGISTRY_SQL, MODEL_TABLE_SQL, HASH_TABLE_SQL, SOURCES_TABLE_SQL,
  BUCKETS_TABLE_SQL, EVENTS_TABLE_SQL, POLICIES_TABLE_SQL, JOBS_TABLE_SQL,
  sanitizeModelKey,
} from './migrations.js'
import { PgHashStore } from './hash-store.js'
import { PgSourceStore, buildSourceWhere } from './source-store.js'
import { PgJobStore } from './job-store.js'

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

const RELAXED_KEYWORD_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'their', 'there', 'these', 'this', 'those', 'to', 'was', 'were', 'what',
  'when', 'where', 'which', 'who', 'whom', 'why', 'with', 'within',
])

function requireSearchOpts(opts: SearchOpts | null | undefined, method: string): SearchOpts {
  if (opts == null) throw new ConfigError(`${method} opts are required.`)
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw new ConfigError(`${method} opts must be an object.`)
  }
  return opts
}

function buildRelaxedKeywordQuery(query: string): string {
  const terms: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const normalized = value
      .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!normalized) return
    const key = normalized.toLowerCase()
    if (seen.has(key)) return
    if (!normalized.includes(' ') && (normalized.length <= 2 || RELAXED_KEYWORD_STOP_WORDS.has(key))) return
    seen.add(key)
    terms.push(normalized.includes(' ') ? `"${normalized.replace(/"/g, ' ')}"` : normalized)
  }

  for (const match of query.matchAll(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g)) {
    add(match[1] ?? '')
  }
  for (const match of query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    add(match[0])
  }

  return terms.slice(0, 16).join(' OR ') || query
}

export interface PgVectorAdapterConfig {
  sql: SqlExecutor
  /** Optional transaction wrapper for drivers that need explicit transaction blocks.
   *  Required for iterative HNSW scan (SET LOCAL needs a transaction). */
  transaction?: (fn: (sql: SqlExecutor) => Promise<unknown>) => Promise<unknown>
  /** Postgres schema name. Defaults to 'public'. */
  schema?: string | undefined
  tablePrefix?: string | undefined
  hashesTable?: string | undefined
  sourcesTable?: string | undefined
  bucketsTable?: string | undefined
  jobsTable?: string | undefined
}

export class PgVectorAdapter implements VectorStoreAdapter {
  private sql: SqlExecutor
  private transaction?: PgVectorAdapterConfig['transaction']
  readonly hashStore: PgHashStore
  readonly sourceStore: PgSourceStore
  readonly jobStore: PgJobStore
  private tablePrefix: string
  private hashesTable: string
  private sourcesTable: string
  private registryTable: string
  private bucketsTable: string
  private eventsTable: string
  private policiesTable: string
  private jobsTable: string

  /** model key → table name */
  private modelTables = new Map<string, string>()

  private schema: string | undefined

  constructor(config: PgVectorAdapterConfig) {
    this.sql = config.sql
    this.transaction = config.transaction
    this.schema = config.schema
    const prefix = config.schema ? `"${config.schema}".` : ''
    this.tablePrefix = config.tablePrefix ?? `${prefix}typegraph_chunks`
    this.hashesTable = config.hashesTable ?? `${prefix}typegraph_hashes`
    this.sourcesTable = config.sourcesTable ?? `${prefix}typegraph_sources`
    this.bucketsTable = config.bucketsTable ?? `${prefix}typegraph_buckets`
    this.eventsTable = `${prefix}typegraph_events`
    this.policiesTable = `${prefix}typegraph_policies`
    this.jobsTable = config.jobsTable ?? `${prefix}typegraph_jobs`
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new PgHashStore(this.sql, this.hashesTable)
    this.sourceStore = new PgSourceStore(this.sql, this.sourcesTable)
    this.jobStore = new PgJobStore(this.sql, this.jobsTable)
  }

  private async execStatements(ddl: string): Promise<void> {
    const stmts = ddl.split(';').map(s => s.trim()).filter(Boolean)
    for (const stmt of stmts) {
      await this.sql(stmt)
    }
  }

  async deploy(): Promise<void> {
    await this.sql(`CREATE EXTENSION IF NOT EXISTS vector`)
    if (this.schema) {
      await this.sql(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`)
    }
    await this.execStatements(REGISTRY_SQL(this.registryTable))
    await this.execStatements(HASH_TABLE_SQL(this.hashesTable))
    await this.execStatements(SOURCES_TABLE_SQL(this.sourcesTable))
    await this.execStatements(BUCKETS_TABLE_SQL(this.bucketsTable))
    await this.execStatements(EVENTS_TABLE_SQL(this.eventsTable))
    await this.execStatements(POLICIES_TABLE_SQL(this.policiesTable))
    await this.execStatements(JOBS_TABLE_SQL(this.jobsTable))
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
    } catch (err) {
      // Registry table may not exist — nothing to undeploy
      console.debug('[typegraph] Registry table check skipped:', err instanceof Error ? err.message : err)
      return { success: true, message: 'No typegraph tables found.' }
    }

    // Check all tables for data
    const allTables = [
      ...dynamicTables,
      this.registryTable,
      this.hashesTable,
      `${this.hashesTable}_run_times`,
      this.sourcesTable,
      this.bucketsTable,
      this.jobsTable,
    ]

    const tablesWithData: string[] = []
    for (const table of allTables) {
      try {
        const rows = await this.sql(`SELECT COUNT(*)::int AS count FROM ${table}`)
        if ((rows[0]?.count as number) > 0) {
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

    // Drop dynamic model tables first, then static tables
    for (const table of dynamicTables) {
      await this.sql(`DROP TABLE IF EXISTS ${table}`)
    }
    await this.sql(`DROP TABLE IF EXISTS ${this.bucketsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.sourcesTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.hashesTable}_run_times`)
    await this.sql(`DROP TABLE IF EXISTS ${this.hashesTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.registryTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.eventsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.policiesTable}`)

    this.modelTables.clear()

    return { success: true, message: 'All typegraph tables dropped.' }
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

  async getTable(model: string): Promise<string> {
    const key = sanitizeModelKey(model)
    const cached = this.modelTables.get(key)
    if (cached) return cached

    // Cache miss: one idempotent heal attempt from registry
    const rows = await this.sql(
      `SELECT table_name FROM ${this.registryTable} WHERE model_key = $1`,
      [key]
    )
    if (rows.length > 0) {
      const table = rows[0]!.table_name as string
      this.modelTables.set(key, table)
      console.warn(`[typegraph] Healed model cache miss for "${model}"`)
      return table
    }

    throw new Error(`No table registered for model "${model}". Call ensureModel() first.`)
  }

  async upsertSourceChunks(model: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const table = await this.getTable(model)

    const params = this.buildUpsertParams(chunks)

    try {
      await this.executeChunkUpsert(table, params)
    } catch (err: unknown) {
      if ((err as any)?.code === '42P01') {
        // Table was dropped externally — invalidate cache and recreate
        const key = sanitizeModelKey(model)
        this.modelTables.delete(key)
        const dimensions = chunks[0]!.embedding.length
        await this.ensureModel(model, dimensions)
        const retryTable = await this.getTable(model)
        await this.executeChunkUpsert(retryTable, params)
        console.warn(`[typegraph] Schema recovery: recreated table for model ${model}`)
        return
      }
      throw err
    }
  }

  private buildUpsertParams(chunks: EmbeddedChunk[]): unknown[][] {
    const chunkIds: string[] = []
    const bucketIds: string[] = []
    const tenantIds: (string | null)[] = []
    const groupIds: (string | null)[] = []
    const userIds: (string | null)[] = []
    const agentIds: (string | null)[] = []
    const conversationIds: (string | null)[] = []
    const sourceIds: string[] = []
    const idempotencyKeys: string[] = []
    const contents: string[] = []
    const embeddings: string[] = []
    const embeddingModels: string[] = []
    const chunkIndices: number[] = []
    const totalChunks: number[] = []
    const visibilities: (string | null)[] = []
    const metadatas: string[] = []
    const indexedAts: string[] = []

    for (const chunk of chunks) {
      chunkIds.push(chunk.id)
      bucketIds.push(chunk.bucketId)
      tenantIds.push(chunk.tenantId ?? null)
      groupIds.push(chunk.groupId ?? null)
      userIds.push(chunk.userId ?? null)
      agentIds.push(chunk.agentId ?? null)
      conversationIds.push(chunk.conversationId ?? null)
      sourceIds.push(chunk.sourceId)
      idempotencyKeys.push(chunk.idempotencyKey)
      contents.push(chunk.content)
      embeddings.push(`[${chunk.embedding.join(',')}]`)
      embeddingModels.push(chunk.embeddingModel)
      chunkIndices.push(chunk.chunkIndex)
      totalChunks.push(chunk.totalChunks)
      visibilities.push(chunk.visibility ?? null)
      metadatas.push(JSON.stringify(chunk.metadata))
      indexedAts.push(chunk.indexedAt.toISOString())
    }

    return [
      chunkIds, bucketIds, tenantIds, groupIds, userIds, agentIds, conversationIds,
      sourceIds, idempotencyKeys, contents, embeddings,
      embeddingModels, chunkIndices, totalChunks, visibilities, metadatas, indexedAts,
    ]
  }

  private async executeChunkUpsert(table: string, params: unknown[][]): Promise<void> {
    await this.sql(
      `INSERT INTO ${table}
        (id, bucket_id, tenant_id, group_id, user_id, agent_id, conversation_id,
         source_id, idempotency_key, content, embedding,
         embedding_model, chunk_index, total_chunks, visibility, metadata, indexed_at)
       SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
        $8::text[], $9::text[], $10::text[], $11::vector[],
        $12::text[], $13::int[], $14::int[], $15::text[], $16::jsonb[], $17::timestamptz[]
       )
       ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET
        id              = EXCLUDED.id,
        source_id     = EXCLUDED.source_id,
        content         = EXCLUDED.content,
        embedding       = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        total_chunks    = EXCLUDED.total_chunks,
        visibility      = EXCLUDED.visibility,
        metadata        = EXCLUDED.metadata,
        indexed_at      = EXCLUDED.indexed_at`,
      params
    )
  }

  async delete(model: string, filter: ChunkFilter | null): Promise<void> {
    const table = await this.getTable(model)
    const normalizedFilter = filter ?? {}
    const hasExplicitFilter =
      normalizedFilter.bucketId != null ||
      (normalizedFilter.bucketIds != null && normalizedFilter.bucketIds.length > 0) ||
      normalizedFilter.chunkRefs != null ||
      normalizedFilter.tenantId != null ||
      normalizedFilter.groupId != null ||
      normalizedFilter.userId != null ||
      normalizedFilter.agentId != null ||
      normalizedFilter.conversationId != null ||
      normalizedFilter.sourceId != null ||
      normalizedFilter.idempotencyKey != null
    if (!hasExplicitFilter) throw new ConfigError('delete() requires at least one filter field.')
    const { where, params } = buildWhere(normalizedFilter)
    await this.sql(`DELETE FROM ${table} WHERE ${where}`, params)
  }

  async search(model: string, embedding: number[], opts: SearchOpts | null): Promise<ScoredChunk[]> {
    const normalizedOpts = requireSearchOpts(opts, 'search')
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildWhere(normalizedOpts.filter)
    // Add temporal filtering if requested
    const temporalConditions: string[] = where ? [where] : []
    if (normalizedOpts.temporalAt) {
      params.push(normalizedOpts.temporalAt.toISOString())
      temporalConditions.push(`indexed_at <= $${params.length}`)
    }
    const filterClause = temporalConditions.length > 0 ? `WHERE ${temporalConditions.join(' AND ')}` : ''
    const count = normalizedOpts.count

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunk[]> => {
      if (inTransaction && normalizedOpts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }
      const paramOffset = params.length
      const rows = await sql(
        `SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                1 - (embedding <=> $${paramOffset + 1}::vector) AS similarity
         FROM ${table}
         ${filterClause}
         ORDER BY embedding <=> $${paramOffset + 1}::vector
         LIMIT $${paramOffset + 2}`,
        [...params, vectorStr, count]
      )
      return rows.map(row => mapRowToScoredChunk(row, { semantic: row.similarity as number }))
    }

    if (this.transaction) {
      return this.transaction((sql) => runQuery(sql, true)) as Promise<ScoredChunk[]>
    }
    return runQuery(this.sql, false)
  }

  async hybridSearch(
    model: string,
    embedding: number[],
    query: string,
    opts: SearchOpts | null
  ): Promise<ScoredChunk[]> {
    const normalizedOpts = requireSearchOpts(opts, 'hybridSearch')
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = normalizedOpts.count
    const useSemantic = normalizedOpts.signals?.semantic !== false
    const useKeyword = normalizedOpts.signals?.keyword ?? true
    if (!useSemantic && !useKeyword) return []
    const relaxedQuery = buildRelaxedKeywordQuery(query)
    const { where: filterWhere, params: filterParams } = buildWhere(normalizedOpts.filter)
    // Add temporal filtering — appended to filterParams so it gets reindexed with everything else
    if (normalizedOpts.temporalAt) {
      filterParams.push(normalizedOpts.temporalAt.toISOString())
    }
    const temporalCond = normalizedOpts.temporalAt ? ` AND indexed_at <= $${filterParams.length}` : ''
    const filterClause = (filterWhere ? `AND ${filterWhere}` : '') + temporalCond

    // Offset param indices past filter params: $1=vectorStr, $2=strict query,
    // $3=count, $4=relaxed query, then filter params.
    const baseOffset = 4
    const reindexedFilter = filterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunk[]> => {
      if (inTransaction && normalizedOpts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }

      const rows = await sql(
        `WITH
          __tg_base_params AS (
            SELECT $1::vector AS query_embedding,
                   $2::text AS strict_query_text,
                   $3::integer AS result_count,
                   $4::text AS relaxed_query_text
          ),
          ${useKeyword ? `tsq AS (
            SELECT websearch_to_tsquery('english', strict_query_text) AS strict_q,
                   websearch_to_tsquery('english', relaxed_query_text) AS relaxed_q
            FROM __tg_base_params
          ),` : ''}
          ${useSemantic ? `vector_ranked AS (
            SELECT *, 1 - (embedding <=> query_embedding) AS similarity,
                   ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS vrank
            FROM ${table}
            CROSS JOIN __tg_base_params
            WHERE TRUE ${reindexedFilter}
            ORDER BY embedding <=> query_embedding
            LIMIT ${count * 3}
          ),` : ''}
          ${useKeyword ? `keyword_ranked AS (
            SELECT *,
                   GREATEST(
                     ts_rank(search_vector, tsq.strict_q),
                     ts_rank(search_vector, tsq.relaxed_q) * 0.75
                   ) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY GREATEST(
                     ts_rank(search_vector, tsq.strict_q),
                     ts_rank(search_vector, tsq.relaxed_q) * 0.75
                   ) DESC) AS krank
            FROM ${table}, tsq
            WHERE (search_vector @@ tsq.strict_q OR search_vector @@ tsq.relaxed_q) ${reindexedFilter}
            ORDER BY kw_score DESC
            LIMIT ${count * 3}
          ),` : ''}
          combined AS (
            ${[
              useSemantic ? `SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked` : '',
              useKeyword ? `SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   NULL::double precision AS similarity, kw_score,
                   NULL::bigint AS vrank, krank
            FROM keyword_ranked` : '',
            ].filter(Boolean).join('\n            UNION ALL\n            ')}
          ),
          scored AS (
            SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, kw_score,
              (COALESCE(1.0::float8 / (60 + vrank), 0) + COALESCE(1.0::float8 / (60 + krank), 0))::double precision AS rrf_score
            FROM combined
          )
        SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
               embedding_model, chunk_index, total_chunks, metadata, indexed_at,
               MAX(similarity) AS similarity,
               MAX(kw_score) AS keyword_score,
               SUM(rrf_score)::double precision AS rrf_score
        FROM scored
        GROUP BY id, bucket_id, tenant_id, source_id, idempotency_key, content,
                 embedding_model, chunk_index, total_chunks, metadata, indexed_at
        ORDER BY SUM(rrf_score)::double precision DESC
        LIMIT $3`,
        [vectorStr, query, count, relaxedQuery, ...filterParams]
      )

      return rows.map(row => mapRowToScoredChunk(row, {
        semantic: (row.similarity as number) ?? undefined,
        keyword: (row.keyword_score as number) ?? undefined,
        rrf: Number(row.rrf_score),
      }))
    }

    if (this.transaction) {
      return this.transaction((sql) => runQuery(sql, true)) as Promise<ScoredChunk[]>
    }
    return runQuery(this.sql, false)
  }

  async countChunks(model: string, filter: ChunkFilter | null): Promise<number> {
    const table = await this.getTable(model)
    const { where, params } = buildWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const rows = await this.sql(
      `SELECT COUNT(*)::int AS count FROM ${table} ${filterClause}`,
      params
    )
    return (rows[0]?.count as number) ?? 0
  }

  // --- Source record methods ---

  async upsertSourceRecord(input: UpsertSourceInput): Promise<typegraphSource & { wasCreated?: boolean | undefined }> {
    return this.sourceStore.upsert(input)
  }

  async getSource(id: string): Promise<typegraphSource | null> {
    return this.sourceStore.get(id)
  }

  async listSources(filter?: SourceFilter | null, pagination?: import('@typegraph-ai/sdk').PaginationOpts | null): Promise<typegraphSource[] | import('@typegraph-ai/sdk').PaginatedResult<typegraphSource>> {
    return this.sourceStore.list(filter, pagination)
  }

  async deleteSources(filter: SourceFilter | null): Promise<number> {
    const { count, ids } = await this.sourceStore.delete(filter)
    if (ids.length === 0) return 0

    // Cascade: delete chunks from all registered model tables
    let totalChunksDeleted = 0
    for (const table of this.modelTables.values()) {
      // Collect idempotency keys before deleting chunks (for hash cleanup)
      const ikeyRows = await this.sql(
        `SELECT DISTINCT idempotency_key, bucket_id, tenant_id FROM ${table}
         WHERE source_id = ANY($1::text[])`,
        [ids]
      )
      const chunkRows = await this.sql(
        `DELETE FROM ${table} WHERE source_id = ANY($1::text[]) RETURNING id`,
        [ids]
      )
      totalChunksDeleted += chunkRows.length

      // Cascade: delete hash entries by idempotency keys
      for (const row of ikeyRows) {
        const ikey = row.idempotency_key as string
        const bucketId = row.bucket_id as string
        const tenantId = (row.tenant_id as string) ?? undefined
        await this.hashStore.deleteByIdempotencyKeys([ikey], bucketId, tenantId)
      }
    }

    return count
  }

  async updateSource(id: string, input: Partial<Pick<typegraphSource, 'title' | 'url' | 'visibility' | 'metadata' | 'subject'>>): Promise<typegraphSource> {
    const source = await this.sourceStore.update(id, input)
    if (!source) throw new Error(`Source not found: ${id}`)
    // Cascade visibility changes onto all chunk rows for this source. Chunks
    // are the security-sensitive target — a stale chunk visibility would let
    // a tightened source keep leaking through unscoped queries.
    if (input.visibility !== undefined) {
      for (const table of this.modelTables.values()) {
        await this.sql(
          `UPDATE ${table} SET visibility = $1 WHERE source_id = $2`,
          [input.visibility, id]
        )
      }
    }
    return source
  }

  async updateSourceStatus(id: string, status: SourceStatus, chunkCount?: number): Promise<void> {
    return this.sourceStore.updateStatus(id, status, chunkCount)
  }

  // --- Job record methods ---

  async upsertJob(input: UpsertJobInput): Promise<Job> {
    return this.jobStore.upsert(input)
  }

  async getJob(id: string): Promise<Job | null> {
    return this.jobStore.get(id)
  }

  async listJobs(filter?: JobFilter | null, pagination?: PaginationOpts | null): Promise<Job[] | PaginatedResult<Job>> {
    return this.jobStore.list(filter, pagination)
  }

  async updateJobStatus(id: string, patch: JobStatusPatch): Promise<void> {
    return this.jobStore.updateStatus(id, patch)
  }

  async incrementJobProgress(id: string, processedDelta: number): Promise<void> {
    return this.jobStore.incrementProgress(id, processedDelta)
  }

  // --- Search with source JOIN ---

  async searchWithSources(
    model: string,
    embedding: number[],
    query: string,
    opts: (SearchOpts & { sourceFilter?: SourceFilter | undefined }) | null
  ): Promise<ScoredChunkWithSource[]> {
    const normalizedOpts = requireSearchOpts(opts, 'searchWithSources') as SearchOpts & { sourceFilter?: SourceFilter | undefined }
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = normalizedOpts.count
    const useSemantic = normalizedOpts.signals?.semantic !== false
    const useKeyword = normalizedOpts.signals?.keyword ?? true
    if (!useSemantic && !useKeyword) return []
    const relaxedQuery = buildRelaxedKeywordQuery(query)
    const { where: chunkFilterWhere, params: chunkFilterParams } = buildWhere(normalizedOpts.filter)
    // Add temporal filtering
    if (normalizedOpts.temporalAt) {
      chunkFilterParams.push(normalizedOpts.temporalAt.toISOString())
    }
    const temporalCond = normalizedOpts.temporalAt ? ` AND c.indexed_at <= $${chunkFilterParams.length}` : ''
    const chunkFilterClause = (chunkFilterWhere ? `AND ${chunkFilterWhere}` : '') + temporalCond
    const { where: sourceFilterWhere, params: sourceFilterParams } = buildSourceWhere(normalizedOpts.sourceFilter ?? {})

    // Base params: $1=vector, $2=strict query, $3=count, $4=relaxed query
    // Then chunk filter params, then source filter params
    const baseOffset = 4
    const reindexedChunkFilter = chunkFilterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )
    const sourceParamOffset = baseOffset + chunkFilterParams.length
    const sourceFilterClause = sourceFilterWhere
      ? `AND ${sourceFilterWhere.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + sourceParamOffset}`)}`
      : ''

    const allParams = [vectorStr, query, count, relaxedQuery, ...chunkFilterParams, ...sourceFilterParams]

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunkWithSource[]> => {
      if (inTransaction && normalizedOpts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }

      const rows = await sql(
        `WITH
          __tg_base_params AS (
            SELECT $1::vector AS query_embedding,
                   $2::text AS strict_query_text,
                   $3::integer AS result_count,
                   $4::text AS relaxed_query_text
          ),
          ${useKeyword ? `tsq AS (
            SELECT websearch_to_tsquery('english', strict_query_text) AS strict_q,
                   websearch_to_tsquery('english', relaxed_query_text) AS relaxed_q
            FROM __tg_base_params
          ),` : ''}
          ${useSemantic ? `vector_ranked AS (
            SELECT c.*, 1 - (c.embedding <=> query_embedding) AS similarity,
                   ROW_NUMBER() OVER (ORDER BY c.embedding <=> query_embedding) AS vrank
            FROM ${table} c
            CROSS JOIN __tg_base_params
            JOIN ${this.sourcesTable} s ON c.source_id = s.id
            WHERE TRUE ${reindexedChunkFilter} ${sourceFilterClause}
            ORDER BY c.embedding <=> query_embedding
            LIMIT ${count * 3}
          ),` : ''}
          ${useKeyword ? `keyword_ranked AS (
            SELECT c.*,
                   GREATEST(
                     ts_rank(c.search_vector, tsq.strict_q),
                     ts_rank(c.search_vector, tsq.relaxed_q) * 0.75
                   ) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY GREATEST(
                     ts_rank(c.search_vector, tsq.strict_q),
                     ts_rank(c.search_vector, tsq.relaxed_q) * 0.75
                   ) DESC) AS krank
            FROM ${table} c
            CROSS JOIN tsq
            JOIN ${this.sourcesTable} s ON c.source_id = s.id
            WHERE (c.search_vector @@ tsq.strict_q OR c.search_vector @@ tsq.relaxed_q) ${reindexedChunkFilter} ${sourceFilterClause}
            ORDER BY kw_score DESC
            LIMIT ${count * 3}
          ),` : ''}
          combined AS (
            ${[
              useSemantic ? `SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked` : '',
              useKeyword ? `SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   NULL::double precision AS similarity, kw_score,
                   NULL::bigint AS vrank, krank
            FROM keyword_ranked` : '',
            ].filter(Boolean).join('\n            UNION ALL\n            ')}
          ),
          scored AS (
            SELECT *,
              (COALESCE(1.0::float8 / (60 + vrank), 0) + COALESCE(1.0::float8 / (60 + krank), 0))::double precision AS rrf_score
            FROM combined
          ),
          final_chunks AS (
            SELECT id, bucket_id, tenant_id, source_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   MAX(similarity) AS similarity,
                   MAX(kw_score) AS keyword_score,
                   SUM(rrf_score)::double precision AS rrf_score
            FROM scored
            GROUP BY id, bucket_id, tenant_id, source_id, idempotency_key, content,
                     embedding_model, chunk_index, total_chunks, metadata, indexed_at
            ORDER BY SUM(rrf_score)::double precision DESC
            LIMIT $3
          )
        SELECT fc.*,
               s.id AS source_id, s.title AS source_title, s.url AS source_url,
               s.content_hash AS source_content_hash, s.chunk_count AS source_chunk_count,
               s.status AS source_status, s.visibility AS source_visibility,
               s.bucket_id AS source_bucket_id, s.tenant_id AS source_tenant_id,
               s.group_id AS source_group_id, s.user_id AS source_user_id,
               s.agent_id AS source_agent_id, s.conversation_id AS source_conversation_id,
               s.graph_extracted AS source_graph_extracted,
               s.indexed_at AS source_indexed_at, s.created_at AS source_created_at,
               s.updated_at AS source_updated_at, s.metadata AS source_metadata,
               s.subject AS source_subject
        FROM final_chunks fc
        JOIN ${this.sourcesTable} s ON fc.source_id = s.id
        ORDER BY fc.rrf_score DESC`,
        allParams
      )

      return rows.map(row => ({
        ...mapRowToScoredChunk(row, {
          semantic: (row.similarity as number) ?? undefined,
          keyword: (row.keyword_score as number) ?? undefined,
          rrf: Number(row.rrf_score),
        }),
        source: mapRowToSource(row),
      }))
    }

    if (this.transaction) {
      return this.transaction((sql) => runQuery(sql, true)) as Promise<ScoredChunkWithSource[]>
    }
    return runQuery(this.sql, false)
  }

  // --- Chunk range fetch (for neighbor expansion) ---

  async getChunksByRange(
    model: string,
    sourceId: string,
    fromIndex: number,
    toIndex: number
  ): Promise<ScoredChunk[]> {
    const table = await this.getTable(model)
    const rows = await this.sql(
      `SELECT * FROM ${table}
       WHERE source_id = $1 AND chunk_index >= $2 AND chunk_index <= $3
       ORDER BY chunk_index`,
      [sourceId, fromIndex, toIndex]
    )
    return rows.map(row => mapRowToScoredChunk(row, {}))
  }

  // --- Bucket persistence ---

  async upsertBucket(bucket: Bucket): Promise<Bucket> {
    const rows = await this.sql(
      `INSERT INTO ${this.bucketsTable}
        (id, name, description, status, tenant_id, group_id, user_id, agent_id, conversation_id,
         embedding_model, query_embedding_model, index_defaults, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         status = EXCLUDED.status, tenant_id = EXCLUDED.tenant_id,
         group_id = EXCLUDED.group_id, user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id, conversation_id = EXCLUDED.conversation_id,
         embedding_model = EXCLUDED.embedding_model,
         query_embedding_model = EXCLUDED.query_embedding_model,
         index_defaults = EXCLUDED.index_defaults,
         updated_at = NOW()
       RETURNING *`,
      [
        bucket.id, bucket.name, bucket.description ?? null, bucket.status,
        bucket.tenantId ?? null, bucket.groupId ?? null, bucket.userId ?? null,
        bucket.agentId ?? null, bucket.conversationId ?? null,
        bucket.embeddingModel ?? null, bucket.queryEmbeddingModel ?? null,
        bucket.indexDefaults ? JSON.stringify(bucket.indexDefaults) : null,
      ]
    )
    return mapRowToBucket(rows[0]!)
  }

  async getBucket(id: string): Promise<Bucket | null> {
    const rows = await this.sql(`SELECT * FROM ${this.bucketsTable} WHERE id = $1`, [id])
    return rows.length > 0 ? mapRowToBucket(rows[0]!) : null
  }

  async getBuckets(ids: string[]): Promise<Bucket[]> {
    if (ids.length === 0) return []
    const rows = await this.sql(
      `SELECT * FROM ${this.bucketsTable} WHERE id = ANY($1::text[])`,
      [ids]
    )
    return rows.map(mapRowToBucket)
  }

  async listBuckets(filter?: import('@typegraph-ai/sdk').BucketListFilter, pagination?: import('@typegraph-ai/sdk').PaginationOpts): Promise<Bucket[] | import('@typegraph-ai/sdk').PaginatedResult<Bucket>> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.tenantId) { params.push(filter.tenantId); conditions.push(`tenant_id = $${params.length}`) }
    if (filter?.groupId) { params.push(filter.groupId); conditions.push(`group_id = $${params.length}`) }
    if (filter?.userId) { params.push(filter.userId); conditions.push(`user_id = $${params.length}`) }
    if (filter?.agentId) { params.push(filter.agentId); conditions.push(`agent_id = $${params.length}`) }
    if (filter?.conversationId) { params.push(filter.conversationId); conditions.push(`conversation_id = $${params.length}`) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    if (pagination) {
      const limit = pagination.limit ?? 100
      const offset = pagination.offset ?? 0
      const countRows = await this.sql(`SELECT COUNT(*)::int AS total FROM ${this.bucketsTable} ${where}`, params)
      const total = (countRows[0]?.total as number) ?? 0
      const rows = await this.sql(
        `SELECT * FROM ${this.bucketsTable} ${where} ORDER BY created_at LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )
      return { items: rows.map(mapRowToBucket), total, limit, offset }
    }

    const rows = await this.sql(`SELECT * FROM ${this.bucketsTable} ${where} ORDER BY created_at`, params)
    return rows.map(mapRowToBucket)
  }

  async deleteBucket(id: string): Promise<void> {
    if (id === DEFAULT_BUCKET_ID) {
      throw new Error('Cannot delete the default bucket.')
    }
    // Cascade: delete all sources (which cascades to chunks + hashes)
    await this.deleteSources({ bucketId: id })
    // Clean up any remaining hash entries for this bucket (all tenants)
    await this.hashStore.deleteAllByBucket(id)
    // Delete the bucket record
    await this.sql(`DELETE FROM ${this.bucketsTable} WHERE id = $1`, [id])
  }

  async destroy(): Promise<void> {
    // No-op - the developer owns the connection lifecycle
  }
}

function buildWhere(filter?: ChunkFilter | null): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  let tenantParam: string | null = null
  let groupParam: string | null = null
  let userParam: string | null = null
  let agentParam: string | null = null
  let convParam: string | null = null

  if (filter?.bucketId != null) {
    params.push(filter.bucketId)
    conditions.push(`bucket_id = $${params.length}`)
  }
  if (filter?.bucketIds != null && filter.bucketIds.length > 0) {
    params.push(filter.bucketIds)
    conditions.push(`bucket_id = ANY($${params.length}::text[])`)
  }
  if (filter?.chunkRefs != null) {
    if (filter.chunkRefs.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.chunkRefs.map(ref => ref.bucketId))
      const bucketParam = `$${params.length}`
      params.push(filter.chunkRefs.map(ref => ref.sourceId))
      const sourceParam = `$${params.length}`
      params.push(filter.chunkRefs.map(ref => ref.chunkIndex))
      const chunkParam = `$${params.length}`
      conditions.push(
        `(bucket_id, source_id, chunk_index) IN (` +
        `SELECT * FROM unnest(${bucketParam}::text[], ${sourceParam}::text[], ${chunkParam}::int[])` +
        `)`
      )
    }
  }
  if (filter?.tenantId != null) {
    params.push(filter.tenantId)
    tenantParam = `$${params.length}`
    conditions.push(`tenant_id = ${tenantParam}`)
  }
  if (filter?.groupId != null) {
    params.push(filter.groupId)
    groupParam = `$${params.length}`
    conditions.push(`group_id = ${groupParam}`)
  }
  if (filter?.userId != null) {
    params.push(filter.userId)
    userParam = `$${params.length}`
    conditions.push(`user_id = ${userParam}`)
  }
  if (filter?.agentId != null) {
    params.push(filter.agentId)
    agentParam = `$${params.length}`
    conditions.push(`agent_id = ${agentParam}`)
  }
  if (filter?.conversationId != null) {
    params.push(filter.conversationId)
    convParam = `$${params.length}`
    conditions.push(`conversation_id = ${convParam}`)
  }
  if (filter?.sourceId != null) {
    params.push(filter.sourceId)
    conditions.push(`source_id = $${params.length}`)
  }
  if (filter?.idempotencyKey != null) {
    params.push(filter.idempotencyKey)
    conditions.push(`idempotency_key = $${params.length}`)
  }

  // Visibility gate — denormalized onto chunks so unscoped queries cannot
  // leak narrowly-visible rows even when identity fields are omitted.
  // NULL visibility = public (no scoping). Every other visibility level
  // requires the caller to have supplied a matching identity field; if the
  // corresponding identity is absent, that branch is not emitted, so rows
  // at that level remain hidden.
  const visBranches: string[] = [`visibility IS NULL`]
  if (tenantParam) visBranches.push(`(visibility = 'tenant' AND tenant_id = ${tenantParam})`)
  if (groupParam) visBranches.push(`(visibility = 'group' AND group_id = ${groupParam})`)
  if (userParam) visBranches.push(`(visibility = 'user' AND user_id = ${userParam})`)
  if (agentParam) visBranches.push(`(visibility = 'agent' AND agent_id = ${agentParam})`)
  if (convParam) visBranches.push(`(visibility = 'conversation' AND conversation_id = ${convParam})`)
  conditions.push(`(${visBranches.join(' OR ')})`)

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function mapRowToScoredChunk(
  row: Record<string, unknown>,
  scores: { semantic?: number; keyword?: number; rrf?: number }
): ScoredChunk {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    bucketId: row.source_bucket_id as string,
    tenantId: (row.source_tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
    sourceId: row.source_id as string,
    content: row.content as string,
    embedding: [], // Don't return the full vector - too large and unnecessary
    embeddingModel: row.embedding_model as string,
    chunkIndex: row.chunk_index as number,
    totalChunks: row.total_chunks as number,
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>,
    indexedAt: new Date(row.indexed_at as string),
    scores: {
      semantic: scores.semantic,
      keyword: scores.keyword,
      rrf: scores.rrf,
    },
  }
}

function mapRowToBucket(row: Record<string, unknown>): Bucket {
  const raw = row.index_defaults
  const indexDefaults = raw
    ? (typeof raw === 'string' ? JSON.parse(raw) : raw) as Bucket['indexDefaults']
    : undefined
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Bucket['status'],
    embeddingModel: (row.embedding_model as string) ?? undefined,
    queryEmbeddingModel: (row.query_embedding_model as string) ?? undefined,
    indexDefaults,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
  }
}

function mapRowToSource(row: Record<string, unknown>): typegraphSource {
  return {
    id: row.source_id as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.source_group_id as string) ?? undefined,
    userId: (row.source_user_id as string) ?? undefined,
    agentId: (row.source_agent_id as string) ?? undefined,
    conversationId: (row.source_conversation_id as string) ?? undefined,
    title: row.source_title as string,
    url: (row.source_url as string) ?? undefined,
    contentHash: row.source_content_hash as string,
    chunkCount: row.source_chunk_count as number,
    status: row.source_status as typegraphSource['status'],
    visibility: (row.source_visibility as typegraphSource['visibility']) ?? undefined,
    graphExtracted: (row.source_graph_extracted as boolean) ?? false,
    indexedAt: new Date(row.source_indexed_at as string),
    createdAt: new Date(row.source_created_at as string),
    updatedAt: new Date(row.source_updated_at as string),
    metadata: (typeof row.source_metadata === 'string' ? JSON.parse(row.source_metadata) : row.source_metadata ?? {}) as Record<string, unknown>,
    subject: (typeof row.source_subject === 'string' ? JSON.parse(row.source_subject) : row.source_subject ?? undefined) as typegraphSource['subject'],
  }
}
