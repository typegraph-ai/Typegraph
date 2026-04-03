import type { d8umDocument, DocumentFilter, DocumentStatus, UpsertDocumentInput } from '@d8um-ai/core'
import type { SqlExecutor } from './adapter.js'

function mapDocRow(row: Record<string, unknown>): d8umDocument {
  return {
    id: row.id as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    sessionId: (row.session_id as string) ?? undefined,
    title: row.title as string,
    url: (row.url as string) ?? undefined,
    contentHash: row.content_hash as string,
    chunkCount: row.chunk_count as number,
    status: row.status as d8umDocument['status'],
    visibility: (row.visibility as d8umDocument['visibility']) ?? undefined,
    documentType: (row.document_type as string) ?? undefined,
    sourceType: (row.source_type as string) ?? undefined,
    indexedAt: new Date(row.indexed_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {}) as Record<string, unknown>,
  }
}

export class PgDocumentStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string
  ) {}

  async upsert(input: UpsertDocumentInput): Promise<d8umDocument> {
    const rows = await this.sql(
      `INSERT INTO ${this.tableName}
        (bucket_id, tenant_id, group_id, user_id, agent_id, session_id,
         title, url, content_hash, chunk_count, status,
         visibility, document_type, source_type, metadata, indexed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
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
           session_id = EXCLUDED.session_id,
           document_type = EXCLUDED.document_type,
           source_type = EXCLUDED.source_type,
           metadata = EXCLUDED.metadata,
           indexed_at = NOW(),
           updated_at = NOW()
       RETURNING *`,
      [
        input.bucketId,
        input.tenantId ?? null,
        input.groupId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.title,
        input.url ?? null,
        input.contentHash,
        input.chunkCount,
        input.status,
        input.visibility ?? null,
        input.documentType ?? null,
        input.sourceType ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    )
    return mapDocRow(rows[0]!)
  }

  async get(id: string): Promise<d8umDocument | null> {
    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    )
    if (rows.length === 0) return null
    return mapDocRow(rows[0]!)
  }

  async list(filter: DocumentFilter): Promise<d8umDocument[]> {
    const { where, params } = buildDocWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''
    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} ${filterClause} ORDER BY updated_at DESC`,
      params
    )
    return rows.map(mapDocRow)
  }

  async delete(filter: DocumentFilter): Promise<number> {
    const { where, params } = buildDocWhere(filter)
    if (!where) throw new Error('deleteDocuments() requires at least one filter field')
    const rows = await this.sql(
      `DELETE FROM ${this.tableName} WHERE ${where} RETURNING id`,
      params
    )
    return rows.length
  }

  async updateStatus(id: string, status: DocumentStatus, chunkCount?: number): Promise<void> {
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

function buildDocWhere(filter: DocumentFilter): { where: string; params: unknown[] } {
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
  if (filter.sessionId != null) {
    params.push(filter.sessionId)
    conditions.push(`session_id = $${params.length}`)
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
  if (filter.documentType != null) {
    if (Array.isArray(filter.documentType)) {
      params.push(filter.documentType)
      conditions.push(`document_type = ANY($${params.length}::text[])`)
    } else {
      params.push(filter.documentType)
      conditions.push(`document_type = $${params.length}`)
    }
  }
  if (filter.sourceType != null) {
    if (Array.isArray(filter.sourceType)) {
      params.push(filter.sourceType)
      conditions.push(`source_type = ANY($${params.length}::text[])`)
    } else {
      params.push(filter.sourceType)
      conditions.push(`source_type = $${params.length}`)
    }
  }
  if (filter.documentIds != null && filter.documentIds.length > 0) {
    params.push(filter.documentIds)
    conditions.push(`id = ANY($${params.length}::uuid[])`)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

export { buildDocWhere }
