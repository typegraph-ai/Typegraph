import type { VectorStoreAdapter, SearchOpts, ScoredChunkWithDocument, UndeployResult } from '@typegraph-ai/sdk'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@typegraph-ai/sdk'
import type { typegraphDocument, DocumentStorageFilter, DocumentStatus, UpsertDocumentInput } from '@typegraph-ai/sdk'
import type { EventStorageFilter, typegraphEventRecord, UpsertEventInput } from '@typegraph-ai/sdk'
import type { ThreadStorageFilter, typegraphThread, UpsertThreadInput } from '@typegraph-ai/sdk'
import type { UpsertLinkInput } from '@typegraph-ai/sdk'
import type { Bucket, BucketStorageFilter } from '@typegraph-ai/sdk'
import type { TypeGraphGraphRecord } from '@typegraph-ai/sdk'
import type { Job, JobFilter, UpsertJobInput, JobStatusPatch, PaginationOpts, PaginatedResult } from '@typegraph-ai/sdk'
import { ConfigError, DEFAULT_BUCKET_ID } from '@typegraph-ai/sdk'
import {
  REGISTRY_SQL, MODEL_TABLE_SQL, HASH_TABLE_SQL, DOCUMENTS_TABLE_SQL,
  BUCKETS_TABLE_SQL, GRAPHS_TABLE_SQL, BUSINESS_EVENTS_TABLE_SQL, LINKS_TABLE_SQL, ONTOLOGY_TABLE_SQL, TELEMETRY_TABLE_SQL, POLICIES_TABLE_SQL, JOBS_TABLE_SQL, THREADS_TABLE_SQL,
  sanitizeModelKey,
} from './migrations.js'
import { PgHashStore } from './hash-store.js'
import { PgDocumentStore, buildDocumentWhere } from './document-store.js'
import { PgEventStore, PgLinkStore } from './event-store.js'
import { PgThreadStore } from './thread-store.js'
import { PgJobStore } from './job-store.js'
import { PgMemoryStoreAdapter } from './memory-store.js'

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

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return (value ?? fallback) as T
}

function parseGraphAccess(value: unknown): TypeGraphGraphRecord['access'] {
  if (value == null) return undefined
  if (value === 'public') return 'public'
  return parseJson<TypeGraphGraphRecord['access'] | null>(value, null) ?? undefined
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
  documentsTable?: string | undefined
  bucketsTable?: string | undefined
  jobsTable?: string | undefined
}

export class PgVectorAdapter implements VectorStoreAdapter {
  private sql: SqlExecutor
  private transaction?: PgVectorAdapterConfig['transaction']
  readonly hashStore: PgHashStore
  readonly documentStore: PgDocumentStore
  readonly eventStore: PgEventStore
  readonly threadStore: PgThreadStore
  readonly linkStore: PgLinkStore
  readonly jobStore: PgJobStore
  private tablePrefix: string
  private hashesTable: string
  private documentsTable: string
  private registryTable: string
  private bucketsTable: string
  private graphsTable: string
  private eventsTable: string
  private threadsTable: string
  private linksTable: string
  private ontologyTable: string
  private telemetryTable: string
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
    this.tablePrefix = config.tablePrefix ?? `${prefix}typegraph_document_chunks`
    this.hashesTable = config.hashesTable ?? `${prefix}typegraph_hashes`
    this.documentsTable = config.documentsTable ?? `${prefix}typegraph_documents`
    this.bucketsTable = config.bucketsTable ?? `${prefix}typegraph_buckets`
    this.graphsTable = `${prefix}typegraph_graphs`
    this.eventsTable = `${prefix}typegraph_events`
    this.threadsTable = `${prefix}typegraph_threads`
    this.linksTable = `${prefix}typegraph_links`
    this.ontologyTable = `${prefix}typegraph_ontology`
    this.telemetryTable = `${prefix}typegraph_telemetry`
    this.policiesTable = `${prefix}typegraph_policies`
    this.jobsTable = config.jobsTable ?? `${prefix}typegraph_jobs`
    this.registryTable = `${this.tablePrefix}_registry`
    this.hashStore = new PgHashStore(this.sql, this.hashesTable)
    this.documentStore = new PgDocumentStore(this.sql, this.documentsTable)
    this.eventStore = new PgEventStore(this.sql, this.eventsTable)
    this.threadStore = new PgThreadStore(this.sql, this.threadsTable)
    this.linkStore = new PgLinkStore(this.sql, this.linksTable)
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
    await this.execStatements(DOCUMENTS_TABLE_SQL(this.documentsTable))
    await this.execStatements(BUCKETS_TABLE_SQL(this.bucketsTable))
    await this.execStatements(GRAPHS_TABLE_SQL(this.graphsTable))
    await this.execStatements(BUSINESS_EVENTS_TABLE_SQL(this.eventsTable))
    await this.execStatements(THREADS_TABLE_SQL(this.threadsTable))
    await this.execStatements(LINKS_TABLE_SQL(this.linksTable))
    await this.execStatements(ONTOLOGY_TABLE_SQL(this.ontologyTable))
    await this.execStatements(TELEMETRY_TABLE_SQL(this.telemetryTable))
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
      this.documentsTable,
      this.bucketsTable,
      this.graphsTable,
      this.eventsTable,
      this.threadsTable,
      this.linksTable,
      this.ontologyTable,
      this.telemetryTable,
      this.policiesTable,
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
    await this.sql(`DROP TABLE IF EXISTS ${this.graphsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.documentsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.eventsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.threadsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.linksTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.ontologyTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.telemetryTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.policiesTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.jobsTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.hashesTable}_run_times`)
    await this.sql(`DROP TABLE IF EXISTS ${this.hashesTable}`)
    await this.sql(`DROP TABLE IF EXISTS ${this.registryTable}`)

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

  createMemoryStore(config?: { embeddingDimensions?: number | undefined }): PgMemoryStoreAdapter {
    return new PgMemoryStoreAdapter({
      sql: this.sql,
      schema: this.schema,
      embeddingDimensions: config?.embeddingDimensions,
    })
  }

  async upsertDocumentChunks(model: string, chunks: EmbeddedChunk[]): Promise<void> {
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
    const tenantIds: string[] = []
    const graphIds: string[] = []
    const groupIds: (string | null)[] = []
    const userIds: (string | null)[] = []
    const agentIds: (string | null)[] = []
    const threadIds: (string | null)[] = []
    const documentIds: string[] = []
    const idempotencyKeys: string[] = []
    const contents: string[] = []
    const embeddings: string[] = []
    const embeddingModels: string[] = []
    const chunkIndices: number[] = []
    const totalChunks: number[] = []
    const accessScopes: string[] = []
    const accessScopeIds: string[][] = []
    const metadatas: string[] = []
    const indexedAts: string[] = []

    for (const chunk of chunks) {
      chunkIds.push(chunk.id)
      bucketIds.push(chunk.bucketId)
      tenantIds.push(chunk.tenantId)
      graphIds.push(chunk.graphId)
      groupIds.push(chunk.groupId ?? null)
      userIds.push(chunk.userId ?? null)
      agentIds.push(chunk.agentId ?? null)
      threadIds.push(chunk.threadId ?? null)
      documentIds.push(chunk.documentId)
      idempotencyKeys.push(chunk.idempotencyKey)
      contents.push(chunk.content)
      embeddings.push(`[${chunk.embedding.join(',')}]`)
      embeddingModels.push(chunk.embeddingModel)
      chunkIndices.push(chunk.chunkIndex)
      totalChunks.push(chunk.totalChunks)
      accessScopes.push('[]')
      accessScopeIds.push([])
      metadatas.push(JSON.stringify(chunk.metadata))
      indexedAts.push(chunk.indexedAt.toISOString())
    }

    return [
      chunkIds, bucketIds, tenantIds, graphIds, groupIds, userIds, agentIds, threadIds,
      documentIds, idempotencyKeys, contents, embeddings,
      embeddingModels, chunkIndices, totalChunks, accessScopes, accessScopeIds, metadatas, indexedAts,
    ]
  }

  private async executeChunkUpsert(table: string, params: unknown[][]): Promise<void> {
    await this.sql(
      `INSERT INTO ${table}
        (id, bucket_id, tenant_id, graph_id, group_id, user_id, agent_id, thread_id,
         document_id, idempotency_key, content, embedding,
         embedding_model, chunk_index, total_chunks, access_scope, access_scope_ids, metadata, indexed_at)
       SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
        $9::text[], $10::text[], $11::text[], $12::vector[],
        $13::text[], $14::int[], $15::int[], $16::jsonb[], $17::text[][], $18::jsonb[], $19::timestamptz[]
       )
       ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET
        id              = EXCLUDED.id,
        graph_id        = EXCLUDED.graph_id,
        document_id     = EXCLUDED.document_id,
        content         = EXCLUDED.content,
        embedding       = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        total_chunks    = EXCLUDED.total_chunks,
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
      normalizedFilter.threadId != null ||
      normalizedFilter.documentId != null ||
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
        `SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
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
    const useSemantic = normalizedOpts.retrieval?.semantic !== false
    const useKeyword = normalizedOpts.retrieval?.keyword ?? true
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
              useSemantic ? `SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked` : '',
              useKeyword ? `SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
                   embedding, embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   NULL::double precision AS similarity, kw_score,
                   NULL::bigint AS vrank, krank
            FROM keyword_ranked` : '',
            ].filter(Boolean).join('\n            UNION ALL\n            ')}
          ),
          scored AS (
            SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, kw_score,
              (COALESCE(1.0::float8 / (60 + vrank), 0) + COALESCE(1.0::float8 / (60 + krank), 0))::double precision AS rrf_score
            FROM combined
          )
        SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
               embedding_model, chunk_index, total_chunks, metadata, indexed_at,
               MAX(similarity) AS similarity,
               MAX(kw_score) AS keyword_score,
               SUM(rrf_score)::double precision AS rrf_score
        FROM scored
        GROUP BY id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
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

  // --- Document record methods ---

  async upsertDocumentRecord(input: UpsertDocumentInput): Promise<typegraphDocument & { wasCreated?: boolean | undefined }> {
    return this.documentStore.upsert(input)
  }

  async getDocument(id: string): Promise<typegraphDocument | null> {
    return this.documentStore.get(id)
  }

  async listDocuments(filter?: DocumentStorageFilter | null, pagination?: import('@typegraph-ai/sdk').PaginationOpts | null): Promise<typegraphDocument[] | import('@typegraph-ai/sdk').PaginatedResult<typegraphDocument>> {
    return this.documentStore.list(filter, pagination)
  }

  async deleteDocuments(filter: DocumentStorageFilter | null): Promise<number> {
    const { count, ids } = await this.documentStore.delete(filter)
    if (ids.length === 0) return 0

    // Cascade: delete chunks from all registered model tables
    let totalChunksDeleted = 0
    for (const table of this.modelTables.values()) {
      // Collect idempotency keys before deleting chunks (for hash cleanup)
      const ikeyRows = await this.sql(
        `SELECT DISTINCT idempotency_key, bucket_id, tenant_id FROM ${table}
         WHERE document_id = ANY($1::text[])`,
        [ids]
      )
      const chunkRows = await this.sql(
        `DELETE FROM ${table} WHERE document_id = ANY($1::text[]) RETURNING id`,
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

  async updateDocument(id: string, input: Partial<Pick<typegraphDocument, 'name' | 'description' | 'url' | 'metadata'>>): Promise<typegraphDocument> {
    const document = await this.documentStore.update(id, input)
    if (!document) throw new Error(`Document not found: ${id}`)
    return document
  }

  async updateDocumentStatus(id: string, status: DocumentStatus, chunkCount?: number): Promise<void> {
    return this.documentStore.updateStatus(id, status, chunkCount)
  }

  // --- Event/thread/link record methods ---

  async upsertEvent(input: UpsertEventInput): Promise<typegraphEventRecord> {
    return this.eventStore.upsert(input)
  }

  async getEvent(tenantId: string, id: string): Promise<typegraphEventRecord | null> {
    return this.eventStore.get(tenantId, id)
  }

  async listEvents(filter?: EventStorageFilter | null): Promise<typegraphEventRecord[]> {
    return this.eventStore.list(filter)
  }

  async upsertThread(input: UpsertThreadInput): Promise<typegraphThread> {
    return this.threadStore.upsert(input)
  }

  async getThread(tenantId: string, id: string): Promise<typegraphThread | null> {
    return this.threadStore.get(tenantId, id)
  }

  async listThreads(filter?: ThreadStorageFilter | null): Promise<typegraphThread[]> {
    return this.threadStore.list(filter)
  }

  async upsertLink(input: UpsertLinkInput): Promise<void> {
    return this.linkStore.upsert(input)
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

  // --- Search with document JOIN ---

  async searchWithDocuments(
    model: string,
    embedding: number[],
    query: string,
    opts: (SearchOpts & { documentFilter?: DocumentStorageFilter | undefined }) | null
  ): Promise<ScoredChunkWithDocument[]> {
    const normalizedOpts = requireSearchOpts(opts, 'searchWithDocuments') as SearchOpts & { documentFilter?: DocumentStorageFilter | undefined }
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = normalizedOpts.count
    const useSemantic = normalizedOpts.retrieval?.semantic !== false
    const useKeyword = normalizedOpts.retrieval?.keyword ?? true
    if (!useSemantic && !useKeyword) return []
    const relaxedQuery = buildRelaxedKeywordQuery(query)
    const { where: chunkFilterWhere, params: chunkFilterParams } = buildWhere(normalizedOpts.filter, 'c')
    // Add temporal filtering
    if (normalizedOpts.temporalAt) {
      chunkFilterParams.push(normalizedOpts.temporalAt.toISOString())
    }
    const temporalCond = normalizedOpts.temporalAt ? ` AND c.indexed_at <= $${chunkFilterParams.length}` : ''
    const chunkFilterClause = (chunkFilterWhere ? `AND ${chunkFilterWhere}` : '') + temporalCond
    const { where: documentFilterWhere, params: documentFilterParams } = buildDocumentWhere(normalizedOpts.documentFilter ?? {}, 's')

    // Base params: $1=vector, $2=strict query, $3=count, $4=relaxed query
    // Then chunk filter params, then document filter params
    const baseOffset = 4
    const reindexedChunkFilter = chunkFilterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )
    const documentParamOffset = baseOffset + chunkFilterParams.length
    const documentFilterClause = documentFilterWhere
      ? `AND ${documentFilterWhere.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + documentParamOffset}`)}`
      : ''

    const allParams = [vectorStr, query, count, relaxedQuery, ...chunkFilterParams, ...documentFilterParams]

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunkWithDocument[]> => {
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
            JOIN ${this.documentsTable} s ON c.document_id = s.id
            WHERE TRUE ${reindexedChunkFilter} ${documentFilterClause}
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
            JOIN ${this.documentsTable} s ON c.document_id = s.id
            WHERE (c.search_vector @@ tsq.strict_q OR c.search_vector @@ tsq.relaxed_q) ${reindexedChunkFilter} ${documentFilterClause}
            ORDER BY kw_score DESC
            LIMIT ${count * 3}
          ),` : ''}
          combined AS (
            ${[
              useSemantic ? `SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   similarity, NULL::double precision AS kw_score,
                   vrank, NULL::bigint AS krank
            FROM vector_ranked` : '',
              useKeyword ? `SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
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
            SELECT id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   MAX(similarity) AS similarity,
                   MAX(kw_score) AS keyword_score,
                   SUM(rrf_score)::double precision AS rrf_score
            FROM scored
            GROUP BY id, bucket_id, tenant_id, graph_id, document_id, idempotency_key, content,
                     embedding_model, chunk_index, total_chunks, metadata, indexed_at
            ORDER BY SUM(rrf_score)::double precision DESC
            LIMIT $3
          )
        SELECT fc.*,
               s.id AS document_record_id, s.name AS document_name, s.description AS document_description, s.url AS document_url,
               s.content_hash AS document_content_hash, s.chunk_count AS document_chunk_count,
               s.status AS document_status, s.access_scope AS document_access_scope,
               s.bucket_id AS document_bucket_id, s.tenant_id AS document_tenant_id, s.graph_id AS document_graph_id,
               s.group_id AS document_group_id, s.user_id AS document_user_id,
               s.agent_id AS document_agent_id, s.thread_id AS document_thread_id,
               s.indexed_at AS document_indexed_at, s.created_at AS document_created_at,
               s.updated_at AS document_updated_at, s.metadata AS document_metadata,
               s.access_scope_ids AS document_access_scope_ids
        FROM final_chunks fc
        JOIN ${this.documentsTable} s ON fc.document_id = s.id
        ORDER BY fc.rrf_score DESC`,
        allParams
      )

      return rows.map(row => ({
        ...mapRowToScoredChunk(row, {
          semantic: (row.similarity as number) ?? undefined,
          keyword: (row.keyword_score as number) ?? undefined,
          rrf: Number(row.rrf_score),
        }),
        document: mapRowToDocument(row),
      }))
    }

    if (this.transaction) {
      return this.transaction((sql) => runQuery(sql, true)) as Promise<ScoredChunkWithDocument[]>
    }
    return runQuery(this.sql, false)
  }

  // --- Chunk range fetch (for neighbor expansion) ---

  async getChunksByRange(
    model: string,
    documentId: string,
    fromIndex: number,
    toIndex: number
  ): Promise<ScoredChunk[]> {
    const table = await this.getTable(model)
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
      `INSERT INTO ${this.bucketsTable}
        (id, name, description, status, tenant_id, graph_id, group_id, user_id, agent_id, thread_id,
         access_scope, access_scope_ids, embedding_model, search_embedding_model, index_defaults, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::text[], $13, $14, $15::jsonb, NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         status = EXCLUDED.status,
         graph_id = EXCLUDED.graph_id,
         group_id = EXCLUDED.group_id, user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id, thread_id = EXCLUDED.thread_id,
         access_scope = EXCLUDED.access_scope,
         access_scope_ids = EXCLUDED.access_scope_ids,
         embedding_model = EXCLUDED.embedding_model,
         search_embedding_model = EXCLUDED.search_embedding_model,
         index_defaults = EXCLUDED.index_defaults,
         updated_at = NOW()
       RETURNING *`,
      [
        bucket.id, bucket.name, bucket.description ?? null, bucket.status,
        bucket.tenantId, bucket.graph ?? 'public', bucket.groupId ?? null, bucket.userId ?? null,
        bucket.agentId ?? null, bucket.threadId ?? null,
        JSON.stringify([]), [],
        bucket.embeddingModel ?? null, bucket.searchEmbeddingModel ?? null,
        bucket.indexDefaults || bucket.graphExtraction !== undefined
          ? JSON.stringify({ ...(bucket.indexDefaults ?? {}), ...(bucket.graphExtraction !== undefined ? { graphExtraction: bucket.graphExtraction } : {}) })
          : null,
      ]
    )
    return mapRowToBucket(rows[0]!)
  }

  async getBucket(id: string, tenantId?: string): Promise<Bucket | null> {
    const rows = tenantId
      ? await this.sql(`SELECT * FROM ${this.bucketsTable} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
      : await this.sql(`SELECT * FROM ${this.bucketsTable} WHERE id = $1 LIMIT 1`, [id])
    return rows.length > 0 ? mapRowToBucket(rows[0]!) : null
  }

  async getBuckets(ids: string[], tenantId?: string): Promise<Bucket[]> {
    if (ids.length === 0) return []
    const rows = tenantId
      ? await this.sql(
        `SELECT * FROM ${this.bucketsTable} WHERE tenant_id = $1 AND id = ANY($2::text[])`,
        [tenantId, ids]
      )
      : await this.sql(
        `SELECT * FROM ${this.bucketsTable} WHERE id = ANY($1::text[])`,
        [ids]
      )
    return rows.map(mapRowToBucket)
  }

  async listBuckets(filter?: BucketStorageFilter, pagination?: import('@typegraph-ai/sdk').PaginationOpts): Promise<Bucket[] | import('@typegraph-ai/sdk').PaginatedResult<Bucket>> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.name) { params.push(filter.name); conditions.push(`name = $${params.length}`) }
    if (filter?.tenantId) { params.push(filter.tenantId); conditions.push(`tenant_id = $${params.length}`) }
    if (filter?.groupId) { params.push(filter.groupId); conditions.push(`group_id = $${params.length}`) }
    if (filter?.userId) { params.push(filter.userId); conditions.push(`user_id = $${params.length}`) }
    if (filter?.agentId) { params.push(filter.agentId); conditions.push(`agent_id = $${params.length}`) }
    if (filter?.threadId) { params.push(filter.threadId); conditions.push(`thread_id = $${params.length}`) }
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

  async deleteBucket(id: string, tenantId?: string): Promise<void> {
    if (id === DEFAULT_BUCKET_ID) {
      throw new Error('Cannot delete the default bucket.')
    }
    // Cascade: delete all documents (which cascades to chunks + hashes)
    await this.deleteDocuments(tenantId ? { bucketId: id, tenantId } : { bucketId: id })
    // Clean up any remaining hash entries for this bucket in the same tenant.
    if (tenantId) {
      await this.hashStore.deleteByBucket(id, tenantId)
    } else {
      await this.hashStore.deleteAllByBucket(id)
    }
    // Delete the bucket record
    if (tenantId) {
      await this.sql(`DELETE FROM ${this.bucketsTable} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    } else {
      await this.sql(`DELETE FROM ${this.bucketsTable} WHERE id = $1`, [id])
    }
  }

  async upsertGraphRecord(input: TypeGraphGraphRecord): Promise<TypeGraphGraphRecord> {
    const rows = await this.sql(
      `INSERT INTO ${this.graphsTable}
        (id, tenant_id, name, description, extends, access, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5::text[],$6::jsonb,$7::jsonb,NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         extends = EXCLUDED.extends,
         access = EXCLUDED.access,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.name ?? null,
        input.description ?? null,
        input.extends ?? [],
        input.access == null ? null : JSON.stringify(input.access),
        JSON.stringify(input.metadata ?? {}),
      ],
    )
    return mapRowToGraph(rows[0]!)
  }

  async getGraphRecord(tenantId: string, id: string): Promise<TypeGraphGraphRecord | null> {
    const rows = await this.sql(`SELECT * FROM ${this.graphsTable} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    return rows.length > 0 ? mapRowToGraph(rows[0]!) : null
  }

  async listGraphRecords(tenantId: string): Promise<TypeGraphGraphRecord[]> {
    const rows = await this.sql(`SELECT * FROM ${this.graphsTable} WHERE tenant_id = $1 ORDER BY id`, [tenantId])
    return rows.map(mapRowToGraph)
  }

  async deleteGraphRecord(tenantId: string, id: string): Promise<void> {
    if (id === 'public') throw new ConfigError('Cannot delete public graph.')
    await this.sql(`DELETE FROM ${this.graphsTable} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
  }

  async destroy(): Promise<void> {
    // No-op - the developer owns the connection lifecycle
  }
}

function buildWhere(filter?: ChunkFilter | null, alias?: string): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const col = (name: string) => alias ? `${alias}.${name}` : name

  if (filter?.bucketId != null) {
    params.push(filter.bucketId)
    conditions.push(`${col('bucket_id')} = $${params.length}`)
  }
  if (filter?.bucketIds != null && filter.bucketIds.length > 0) {
    params.push(filter.bucketIds)
    conditions.push(`${col('bucket_id')} = ANY($${params.length}::text[])`)
  }
  if (filter?.chunkRefs != null) {
    if (filter.chunkRefs.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.chunkRefs.map(ref => ref.bucketId))
      const bucketParam = `$${params.length}`
      params.push(filter.chunkRefs.map(ref => ref.documentId))
      const documentParam = `$${params.length}`
      params.push(filter.chunkRefs.map(ref => ref.chunkIndex))
      const chunkParam = `$${params.length}`
      conditions.push(
        `(${col('bucket_id')}, ${col('document_id')}, ${col('chunk_index')}) IN (` +
        `SELECT * FROM unnest(${bucketParam}::text[], ${documentParam}::text[], ${chunkParam}::int[])` +
        `)`
      )
    }
  }
  if (filter?.tenantId != null) {
    params.push(filter.tenantId)
    conditions.push(`${col('tenant_id')} = $${params.length}`)
  }
  if (filter?.groupId != null) {
    params.push(filter.groupId)
    conditions.push(`${col('group_id')} = $${params.length}`)
  }
  if (filter?.userId != null) {
    params.push(filter.userId)
    conditions.push(`${col('user_id')} = $${params.length}`)
  }
  if (filter?.agentId != null) {
    params.push(filter.agentId)
    conditions.push(`${col('agent_id')} = $${params.length}`)
  }
  if (filter?.threadId != null) {
    params.push(filter.threadId)
    conditions.push(`${col('thread_id')} = $${params.length}`)
  }
  if (filter?.graphIds != null) {
    if (filter.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.graphIds)
      conditions.push(`${col('graph_id')} = ANY($${params.length}::text[])`)
    }
  }
  if (filter?.documentId != null) {
    params.push(filter.documentId)
    conditions.push(`${col('document_id')} = $${params.length}`)
  }
  if (filter?.idempotencyKey != null) {
    params.push(filter.idempotencyKey)
    conditions.push(`${col('idempotency_key')} = $${params.length}`)
  }
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
    bucketId: (row.bucket_id ?? row.document_bucket_id) as string,
    tenantId: (row.tenant_id ?? row.document_tenant_id) as string,
    graphId: (row.graph_id ?? row.document_graph_id ?? 'public') as string,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    threadId: (row.thread_id as string) ?? undefined,
    documentId: row.document_id as string,
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
    graph: (row.graph_id as string) ?? 'public',
    graphExtraction: indexDefaults?.graphExtraction,
    embeddingModel: (row.embedding_model as string) ?? undefined,
    searchEmbeddingModel: (row.search_embedding_model as string) ?? undefined,
    indexDefaults,
    tenantId: row.tenant_id as string,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    threadId: (row.thread_id as string) ?? undefined,
  }
}

function mapRowToGraph(row: Record<string, unknown>): TypeGraphGraphRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: (row.name as string) ?? undefined,
    description: (row.description as string) ?? undefined,
    extends: (row.extends as string[] | undefined) ?? [],
    access: parseGraphAccess(row.access),
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at as string) : undefined,
  }
}

function mapRowToDocument(row: Record<string, unknown>): typegraphDocument {
  return {
    id: (row.document_record_id ?? row.id) as string,
    bucketId: (row.document_bucket_id ?? row.bucket_id) as string,
    tenantId: (row.document_tenant_id ?? row.tenant_id) as string,
    graphId: (row.document_graph_id ?? row.graph_id ?? 'public') as string,
    groupId: (row.document_group_id as string) ?? undefined,
    userId: (row.document_user_id as string) ?? undefined,
    agentId: (row.document_agent_id as string) ?? undefined,
    threadId: (row.document_thread_id as string) ?? undefined,
    name: (row.document_name ?? row.name) as string,
    description: (row.document_description ?? row.description) as string | undefined,
    url: (row.document_url as string) ?? undefined,
    contentHash: row.document_content_hash as string,
    chunkCount: row.document_chunk_count as number,
    status: row.document_status as typegraphDocument['status'],
    indexedAt: new Date(row.document_indexed_at as string),
    createdAt: new Date(row.document_created_at as string),
    updatedAt: new Date(row.document_updated_at as string),
    metadata: (typeof row.document_metadata === 'string' ? JSON.parse(row.document_metadata) : row.document_metadata ?? {}) as Record<string, unknown>,
  }
}
