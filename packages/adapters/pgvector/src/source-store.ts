import type { typegraphSource, SourceFilter, SourceStatus, UpsertSourceInput, PaginationOpts, PaginatedResult } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

type UpsertedSourceRecord = typegraphSource & { wasCreated?: boolean | undefined }

function mapSourceRow(row: Record<string, unknown>): typegraphSource {
  const subject = typeof row.subject === 'string'
    ? JSON.parse(row.subject)
    : row.subject ?? undefined
  return {
    id: row.id as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
    title: row.title as string,
    url: (row.url as string) ?? undefined,
    contentHash: row.content_hash as string,
    chunkCount: row.chunk_count as number,
    status: row.status as typegraphSource['status'],
    visibility: (row.visibility as typegraphSource['visibility']) ?? undefined,
    graphExtracted: (row.graph_extracted as boolean) ?? false,
    indexedAt: new Date(row.indexed_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {}) as Record<string, unknown>,
    subject: subject as typegraphSource['subject'],
  }
}

export class PgSourceStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string
  ) {}

  async upsert(input: UpsertSourceInput): Promise<UpsertedSourceRecord> {
    const rows = await this.sql(
      `INSERT INTO ${this.tableName}
        (id, bucket_id, tenant_id, group_id, user_id, agent_id, conversation_id,
         title, url, content_hash, chunk_count, status,
         visibility, graph_extracted, metadata, subject, indexed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
       ON CONFLICT (bucket_id, COALESCE(tenant_id, ''), content_hash)
         DO UPDATE SET
           title = EXCLUDED.title,
           url = EXCLUDED.url,
           chunk_count = EXCLUDED.chunk_count,
           status = EXCLUDED.status,
           visibility = EXCLUDED.visibility,
           group_id = EXCLUDED.group_id,
           user_id = EXCLUDED.user_id,
           agent_id = EXCLUDED.agent_id,
           conversation_id = EXCLUDED.conversation_id,
           graph_extracted = EXCLUDED.graph_extracted,
           metadata = EXCLUDED.metadata,
           subject = EXCLUDED.subject,
           indexed_at = NOW(),
           updated_at = NOW()
       RETURNING *, (xmax = 0) AS was_created`,
      [
        input.id,
        input.bucketId,
        input.tenantId ?? null,
        input.groupId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.conversationId ?? null,
        input.title,
        input.url ?? null,
        input.contentHash,
        input.chunkCount,
        input.status,
        input.visibility ?? null,
        input.graphExtracted ?? false,
        JSON.stringify(input.metadata ?? {}),
        input.subject ? JSON.stringify(input.subject) : null,
      ]
    )
    return {
      ...mapSourceRow(rows[0]!),
      wasCreated: rows[0]!.was_created as boolean,
    }
  }

  async get(id: string): Promise<typegraphSource | null> {
    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    )
    if (rows.length === 0) return null
    return mapSourceRow(rows[0]!)
  }

  async list(filter: SourceFilter, pagination?: PaginationOpts): Promise<typegraphSource[] | PaginatedResult<typegraphSource>> {
    const { where, params } = buildSourceWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''

    if (pagination) {
      const limit = pagination.limit ?? 100
      const offset = pagination.offset ?? 0
      const countRows = await this.sql(
        `SELECT COUNT(*)::int AS total FROM ${this.tableName} ${filterClause}`,
        params
      )
      const total = (countRows[0]?.total as number) ?? 0
      const rows = await this.sql(
        `SELECT * FROM ${this.tableName} ${filterClause} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )
      return { items: rows.map(mapSourceRow), total, limit, offset }
    }

    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} ${filterClause} ORDER BY updated_at DESC`,
      params
    )
    return rows.map(mapSourceRow)
  }

  async delete(filter: SourceFilter): Promise<{ count: number; ids: string[] }> {
    const { where, params } = buildSourceWhere(filter)
    if (!where) throw new Error('deleteSources() requires at least one filter field')
    const rows = await this.sql(
      `DELETE FROM ${this.tableName} WHERE ${where} RETURNING id`,
      params
    )
    return { count: rows.length, ids: rows.map(r => r.id as string) }
  }

  async update(id: string, input: Partial<Pick<typegraphSource, 'title' | 'url' | 'visibility' | 'metadata' | 'subject'>>): Promise<typegraphSource | null> {
    const setClauses: string[] = ['updated_at = NOW()']
    const params: unknown[] = []
    if (input.title !== undefined) { params.push(input.title); setClauses.push(`title = $${params.length}`) }
    if (input.url !== undefined) { params.push(input.url); setClauses.push(`url = $${params.length}`) }
    if (input.visibility !== undefined) { params.push(input.visibility); setClauses.push(`visibility = $${params.length}`) }
    if (input.metadata !== undefined) { params.push(JSON.stringify(input.metadata)); setClauses.push(`metadata = $${params.length}::jsonb`) }
    if (input.subject !== undefined) { params.push(input.subject ? JSON.stringify(input.subject) : null); setClauses.push(`subject = $${params.length}::jsonb`) }
    params.push(id)
    const rows = await this.sql(
      `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    )
    return rows.length > 0 ? mapSourceRow(rows[0]!) : null
  }

  async updateStatus(id: string, status: SourceStatus, chunkCount?: number): Promise<void> {
    if (chunkCount != null) {
      await this.sql(
        `UPDATE ${this.tableName}
         SET status = $1, chunk_count = $2, indexed_at = NOW(), updated_at = NOW()
         WHERE id = $3`,
        [status, chunkCount, id]
      )
    } else {
      await this.sql(
        `UPDATE ${this.tableName}
         SET status = $1, updated_at = NOW()
         WHERE id = $2`,
        [status, id]
      )
    }
  }
}

function buildSourceWhere(filter: SourceFilter): { where: string; params: unknown[] } {
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
  if (filter.status != null) {
    if (Array.isArray(filter.status)) {
      params.push(filter.status)
      conditions.push(`status = ANY($${params.length}::text[])`)
    } else {
      params.push(filter.status)
      conditions.push(`status = $${params.length}`)
    }
  }
  if (filter.visibility != null) {
    if (Array.isArray(filter.visibility)) {
      params.push(filter.visibility)
      conditions.push(`visibility = ANY($${params.length}::text[])`)
    } else {
      params.push(filter.visibility)
      conditions.push(`visibility = $${params.length}`)
    }
  }
  if (filter.sourceIds != null && filter.sourceIds.length > 0) {
    params.push(filter.sourceIds)
    conditions.push(`id = ANY($${params.length}::text[])`)
  }
  if (filter.graphExtracted != null) {
    params.push(filter.graphExtracted)
    conditions.push(`graph_extracted = $${params.length}`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

export { buildSourceWhere }
