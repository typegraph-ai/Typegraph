import type { VectorStoreAdapter, SearchOpts, ScoredChunkWithDocument, UndeployResult } from '@typegraph-ai/sdk'
import type { EmbeddedChunk, ChunkFilter, ScoredChunk } from '@typegraph-ai/sdk'
import type { typegraphDocument, DocumentFilter, DocumentStatus, UpsertDocumentInput } from '@typegraph-ai/sdk'
import type { Bucket } from '@typegraph-ai/sdk'
import { generateId, DEFAULT_BUCKET_ID } from '@typegraph-ai/sdk'
import {
  REGISTRY_SQL, MODEL_TABLE_SQL, HASH_TABLE_SQL, DOCUMENTS_TABLE_SQL,
  BUCKETS_TABLE_SQL, EVENTS_TABLE_SQL, POLICIES_TABLE_SQL,
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
  /** Postgres schema name. Defaults to 'public'. */
  schema?: string | undefined
  tablePrefix?: string | undefined
  hashesTable?: string | undefined
  documentsTable?: string | undefined
  bucketsTable?: string | undefined
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
  private eventsTable: string
  private policiesTable: string

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
    this.documentsTable = config.documentsTable ?? `${prefix}typegraph_documents`
    this.bucketsTable = config.bucketsTable ?? `${prefix}typegraph_buckets`
    this.eventsTable = `${prefix}typegraph_events`
    this.policiesTable = `${prefix}typegraph_policies`
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
    if (this.schema) {
      await this.sql(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`)
    }
    await this.execStatements(REGISTRY_SQL(this.registryTable))
    await this.execStatements(HASH_TABLE_SQL(this.hashesTable))
    await this.execStatements(DOCUMENTS_TABLE_SQL(this.documentsTable))
    await this.execStatements(BUCKETS_TABLE_SQL(this.bucketsTable))
    await this.execStatements(EVENTS_TABLE_SQL(this.eventsTable))
    await this.execStatements(POLICIES_TABLE_SQL(this.policiesTable))
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
    await this.sql(`DROP TABLE IF EXISTS ${this.documentsTable}`)
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

  private async getTable(model: string): Promise<string> {
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

  async upsertDocument(model: string, chunks: EmbeddedChunk[]): Promise<void> {
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
    const sourceIds: string[] = []
    const tenantIds: (string | null)[] = []
    const groupIds: (string | null)[] = []
    const userIds: (string | null)[] = []
    const agentIds: (string | null)[] = []
    const conversationIds: (string | null)[] = []
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
      chunkIds.push(generateId('chk'))
      sourceIds.push(chunk.bucketId)
      tenantIds.push(chunk.tenantId ?? null)
      groupIds.push(chunk.groupId ?? null)
      userIds.push(chunk.userId ?? null)
      agentIds.push(chunk.agentId ?? null)
      conversationIds.push(chunk.conversationId ?? null)
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

    return [
      chunkIds, sourceIds, tenantIds, groupIds, userIds, agentIds, conversationIds,
      documentIds, idempotencyKeys, contents, embeddings,
      embeddingModels, chunkIndices, totalChunks, metadatas, indexedAts,
    ]
  }

  private async executeChunkUpsert(table: string, params: unknown[][]): Promise<void> {
    await this.sql(
      `INSERT INTO ${table}
        (id, bucket_id, tenant_id, group_id, user_id, agent_id, conversation_id,
         document_id, idempotency_key, content, embedding,
         embedding_model, chunk_index, total_chunks, metadata, indexed_at)
       SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
        $8::text[], $9::text[], $10::text[], $11::vector[],
        $12::text[], $13::int[], $14::int[], $15::jsonb[], $16::timestamptz[]
       )
       ON CONFLICT (idempotency_key, chunk_index, bucket_id) DO UPDATE SET
        content         = EXCLUDED.content,
        embedding       = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        total_chunks    = EXCLUDED.total_chunks,
        metadata        = EXCLUDED.metadata,
        indexed_at      = EXCLUDED.indexed_at`,
      params
    )
  }

  async delete(model: string, filter: ChunkFilter): Promise<void> {
    const table = await this.getTable(model)
    const { where, params } = buildWhere(filter)
    if (!where) throw new Error('delete() requires at least one filter field')
    await this.sql(`DELETE FROM ${table} WHERE ${where}`, params)
  }

  async search(model: string, embedding: number[], opts: SearchOpts): Promise<ScoredChunk[]> {
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const { where, params } = buildWhere(opts.filter)
    // Add temporal filtering if requested
    const temporalConditions: string[] = where ? [where] : []
    if (opts.temporalAt) {
      params.push(opts.temporalAt.toISOString())
      temporalConditions.push(`indexed_at <= $${params.length}`)
    }
    const filterClause = temporalConditions.length > 0 ? `WHERE ${temporalConditions.join(' AND ')}` : ''
    const count = opts.count

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunk[]> => {
      if (inTransaction && opts.iterativeScan !== false) {
        await sql(`SET LOCAL hnsw.iterative_scan = relaxed_order;`)
      }
      const paramOffset = params.length
      const rows = await sql(
        `SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
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
    opts: SearchOpts
  ): Promise<ScoredChunk[]> {
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = opts.count
    const { where: filterWhere, params: filterParams } = buildWhere(opts.filter)
    // Add temporal filtering — appended to filterParams so it gets reindexed with everything else
    if (opts.temporalAt) {
      filterParams.push(opts.temporalAt.toISOString())
    }
    const temporalCond = opts.temporalAt ? ` AND indexed_at <= $${filterParams.length}` : ''
    const filterClause = (filterWhere ? `AND ${filterWhere}` : '') + temporalCond

    // Offset param indices past filter params: $1=vectorStr, $2=query, $3=count, then filter params
    const baseOffset = 3
    const reindexedFilter = filterClause.replace(
      /\$(\d+)/g,
      (_, n) => `$${parseInt(n) + baseOffset}`
    )

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunk[]> => {
      if (inTransaction && opts.iterativeScan !== false) {
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
            LIMIT ${count * 3}
          ),
          keyword_ranked AS (
            SELECT *, ts_rank(search_vector, tsq.q) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, tsq.q) DESC) AS krank
            FROM ${table}, tsq
            WHERE search_vector @@ tsq.q ${reindexedFilter}
            ORDER BY ts_rank(search_vector, tsq.q) DESC
            LIMIT ${count * 3}
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
              (COALESCE(1.0::float8 / (60 + vrank), 0) + COALESCE(1.0::float8 / (60 + krank), 0))::double precision AS rrf_score
            FROM combined
          )
        SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
               embedding_model, chunk_index, total_chunks, metadata, indexed_at,
               MAX(similarity) AS similarity,
               MAX(kw_score) AS keyword_score,
               SUM(rrf_score)::double precision AS rrf_score
        FROM scored
        GROUP BY id, bucket_id, tenant_id, document_id, idempotency_key, content,
                 embedding_model, chunk_index, total_chunks, metadata, indexed_at
        ORDER BY SUM(rrf_score)::double precision DESC
        LIMIT $3`,
        [vectorStr, query, count, ...filterParams]
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

  async countChunks(model: string, filter: ChunkFilter): Promise<number> {
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

  async upsertDocumentRecord(input: UpsertDocumentInput): Promise<typegraphDocument> {
    return this.documentStore.upsert(input)
  }

  async getDocument(id: string): Promise<typegraphDocument | null> {
    return this.documentStore.get(id)
  }

  async listDocuments(filter: DocumentFilter, pagination?: import('@typegraph-ai/sdk').PaginationOpts): Promise<typegraphDocument[] | import('@typegraph-ai/sdk').PaginatedResult<typegraphDocument>> {
    return this.documentStore.list(filter, pagination)
  }

  async deleteDocuments(filter: DocumentFilter): Promise<number> {
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

  async updateDocument(id: string, input: Partial<Pick<typegraphDocument, 'title' | 'url' | 'visibility' | 'documentType' | 'sourceType' | 'metadata'>>): Promise<typegraphDocument> {
    const doc = await this.documentStore.update(id, input)
    if (!doc) throw new Error(`Document not found: ${id}`)
    return doc
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
    const table = await this.getTable(model)
    const vectorStr = `[${embedding.join(',')}]`
    const count = opts.count
    const { where: chunkFilterWhere, params: chunkFilterParams } = buildWhere(opts.filter)
    // Add temporal filtering
    if (opts.temporalAt) {
      chunkFilterParams.push(opts.temporalAt.toISOString())
    }
    const temporalCond = opts.temporalAt ? ` AND c.indexed_at <= $${chunkFilterParams.length}` : ''
    const chunkFilterClause = (chunkFilterWhere ? `AND ${chunkFilterWhere}` : '') + temporalCond
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

    const runQuery = async (sql: SqlExecutor, inTransaction: boolean): Promise<ScoredChunkWithDocument[]> => {
      if (inTransaction && opts.iterativeScan !== false) {
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
            LIMIT ${count * 3}
          ),
          keyword_ranked AS (
            SELECT c.*, ts_rank(c.search_vector, tsq.q) AS kw_score,
                   ROW_NUMBER() OVER (ORDER BY ts_rank(c.search_vector, tsq.q) DESC) AS krank
            FROM ${table} c
            CROSS JOIN tsq
            JOIN ${this.documentsTable} d ON c.document_id = d.id
            WHERE c.search_vector @@ tsq.q ${reindexedChunkFilter} ${docFilterClause}
            ORDER BY ts_rank(c.search_vector, tsq.q) DESC
            LIMIT ${count * 3}
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
              (COALESCE(1.0::float8 / (60 + vrank), 0) + COALESCE(1.0::float8 / (60 + krank), 0))::double precision AS rrf_score
            FROM combined
          ),
          final_chunks AS (
            SELECT id, bucket_id, tenant_id, document_id, idempotency_key, content,
                   embedding_model, chunk_index, total_chunks, metadata, indexed_at,
                   MAX(similarity) AS similarity,
                   MAX(kw_score) AS keyword_score,
                   SUM(rrf_score)::double precision AS rrf_score
            FROM scored
            GROUP BY id, bucket_id, tenant_id, document_id, idempotency_key, content,
                     embedding_model, chunk_index, total_chunks, metadata, indexed_at
            ORDER BY SUM(rrf_score)::double precision DESC
            LIMIT $3
          )
        SELECT fc.*,
               d.id AS doc_id, d.title AS doc_title, d.url AS doc_url,
               d.content_hash AS doc_content_hash, d.chunk_count AS doc_chunk_count,
               d.status AS doc_status, d.visibility AS doc_visibility,
               d.group_id AS doc_group_id, d.user_id AS doc_user_id,
               d.agent_id AS doc_agent_id, d.conversation_id AS doc_conversation_id,
               d.document_type AS doc_document_type, d.source_type AS doc_source_type,
               d.graph_extracted AS doc_graph_extracted,
               d.indexed_at AS doc_indexed_at, d.created_at AS doc_created_at,
               d.updated_at AS doc_updated_at, d.metadata AS doc_metadata
        FROM final_chunks fc
        JOIN ${this.documentsTable} d ON fc.document_id = d.id
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
    // Cascade: delete all documents (which cascades to chunks + hashes)
    await this.deleteDocuments({ bucketId: id })
    // Clean up any remaining hash entries for this bucket (all tenants)
    await this.hashStore.deleteAllByBucket(id)
    // Delete the bucket record
    await this.sql(`DELETE FROM ${this.bucketsTable} WHERE id = $1`, [id])
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
  if (filter.groupId != null) {
    params.push(filter.groupId)
    conditions.push(`group_id = $${params.length}`)
  }
  if (filter.userId != null) {
    params.push(filter.userId)
    conditions.push(`user_id = $${params.length}`)
  }
  if (filter.agentId != null) {
    params.push(filter.agentId)
    conditions.push(`agent_id = $${params.length}`)
  }
  if (filter.conversationId != null) {
    params.push(filter.conversationId)
    conditions.push(`conversation_id = $${params.length}`)
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
  scores: { semantic?: number; keyword?: number; rrf?: number }
): ScoredChunk {
  return {
    idempotencyKey: row.idempotency_key as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
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

function mapRowToDocument(row: Record<string, unknown>): typegraphDocument {
  return {
    id: row.doc_id as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.doc_group_id as string) ?? undefined,
    userId: (row.doc_user_id as string) ?? undefined,
    agentId: (row.doc_agent_id as string) ?? undefined,
    conversationId: (row.doc_conversation_id as string) ?? undefined,
    title: row.doc_title as string,
    url: (row.doc_url as string) ?? undefined,
    contentHash: row.doc_content_hash as string,
    chunkCount: row.doc_chunk_count as number,
    status: row.doc_status as typegraphDocument['status'],
    visibility: (row.doc_visibility as typegraphDocument['visibility']) ?? undefined,
    documentType: (row.doc_document_type as string) ?? undefined,
    sourceType: (row.doc_source_type as string) ?? undefined,
    graphExtracted: (row.doc_graph_extracted as boolean) ?? false,
    indexedAt: new Date(row.doc_indexed_at as string),
    createdAt: new Date(row.doc_created_at as string),
    updatedAt: new Date(row.doc_updated_at as string),
    metadata: (typeof row.doc_metadata === 'string' ? JSON.parse(row.doc_metadata) : row.doc_metadata ?? {}) as Record<string, unknown>,
  }
}
