import { ConfigError } from '@typegraph-ai/sdk'
import type { DocumentStatus, DocumentStorageFilter, PaginatedResult, PaginationOpts, typegraphDocument, UpsertDocumentInput, UpsertedDocumentRecord } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return (value ?? fallback) as T
}

function mapDocumentRow(row: Record<string, unknown>): typegraphDocument {
  return {
    id: row.id as string,
    bucketId: row.bucket_id as string,
    tenantId: row.tenant_id as string,
    graphId: (row.graph_id as string) ?? 'public',
    organizationId: (row.organization_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    threadId: (row.thread_id as string) ?? undefined,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    url: (row.url as string) ?? undefined,
    contentHash: row.content_hash as string,
    chunkCount: row.chunk_count as number,
    status: row.status as typegraphDocument['status'],
    indexedAt: new Date(row.indexed_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    metadata: parseJson(row.metadata, {}),
  }
}

export class PgDocumentStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string
  ) {}

  async upsert(input: UpsertDocumentInput): Promise<UpsertedDocumentRecord> {
    const rows = await this.sql(
      `INSERT INTO ${this.tableName}
        (id, bucket_id, tenant_id, graph_id, organization_id, group_id, user_id, agent_id, thread_id,
         name, description, url, content_hash, chunk_count, status,
         metadata, indexed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, NOW(), NOW())
       ON CONFLICT (bucket_id, tenant_id, content_hash)
         DO UPDATE SET
           graph_id = EXCLUDED.graph_id,
           organization_id = EXCLUDED.organization_id,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           url = EXCLUDED.url,
           chunk_count = EXCLUDED.chunk_count,
           status = EXCLUDED.status,
           group_id = EXCLUDED.group_id,
           user_id = EXCLUDED.user_id,
           agent_id = EXCLUDED.agent_id,
           thread_id = EXCLUDED.thread_id,
           metadata = EXCLUDED.metadata,
           indexed_at = NOW(),
           updated_at = NOW()
       RETURNING *, (xmax = 0) AS was_created`,
      [
        input.id,
        input.bucketId,
        input.tenantId,
        input.graphId,
        input.organizationId ?? null,
        input.groupId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.threadId ?? null,
        input.name,
        input.description ?? null,
        input.url ?? null,
        input.contentHash,
        input.chunkCount,
        input.status,
        JSON.stringify(input.metadata ?? {}),
      ]
    )
    return {
      ...mapDocumentRow(rows[0]!),
      wasCreated: rows[0]!.was_created as boolean,
    }
  }

  async get(tenantId: string, id: string): Promise<typegraphDocument | null> {
    const rows = await this.sql(`SELECT * FROM ${this.tableName} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    if (rows.length === 0) return null
    return mapDocumentRow(rows[0]!)
  }

  async list(filter?: DocumentStorageFilter | null, pagination?: PaginationOpts | null): Promise<typegraphDocument[] | PaginatedResult<typegraphDocument>> {
    const { where, params } = buildDocumentWhere(filter)
    const filterClause = where ? `WHERE ${where}` : ''

    if (pagination) {
      const limit = pagination.limit ?? 100
      const offset = pagination.offset ?? 0
      const countRows = await this.sql(`SELECT COUNT(*)::int AS total FROM ${this.tableName} ${filterClause}`, params)
      const total = (countRows[0]?.total as number) ?? 0
      const rows = await this.sql(
        `SELECT * FROM ${this.tableName} ${filterClause} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )
      return { items: rows.map(mapDocumentRow), total, limit, offset }
    }

    const rows = await this.sql(`SELECT * FROM ${this.tableName} ${filterClause} ORDER BY updated_at DESC`, params)
    return rows.map(mapDocumentRow)
  }

  async delete(filter: DocumentStorageFilter | null): Promise<{ count: number; documents: Array<{ tenantId: string; bucketId: string; id: string }> }> {
    const { where, params } = buildDocumentWhere(filter)
    if (!where) throw new ConfigError('documents.delete requires at least one filter field.')
    const rows = await this.sql(`DELETE FROM ${this.tableName} WHERE ${where} RETURNING tenant_id, bucket_id, id`, params)
    return {
      count: rows.length,
      documents: rows.map(r => ({
        tenantId: r.tenant_id as string,
        bucketId: r.bucket_id as string,
        id: r.id as string,
      })),
    }
  }

  async update(tenantId: string, id: string, input: Partial<Pick<typegraphDocument, 'name' | 'description' | 'url' | 'metadata'>>): Promise<typegraphDocument | null> {
    const setClauses: string[] = ['updated_at = NOW()']
    const params: unknown[] = []
    if (input.name !== undefined) { params.push(input.name); setClauses.push(`name = $${params.length}`) }
    if (input.description !== undefined) { params.push(input.description); setClauses.push(`description = $${params.length}`) }
    if (input.url !== undefined) { params.push(input.url); setClauses.push(`url = $${params.length}`) }
    if (input.metadata !== undefined) { params.push(JSON.stringify(input.metadata)); setClauses.push(`metadata = $${params.length}::jsonb`) }
    params.push(tenantId, id)
    const rows = await this.sql(`UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`, params)
    return rows.length > 0 ? mapDocumentRow(rows[0]!) : null
  }

  async updateStatus(tenantId: string, id: string, status: DocumentStatus, chunkCount?: number): Promise<void> {
    if (chunkCount != null) {
      await this.sql(
        `UPDATE ${this.tableName}
         SET status = $1, chunk_count = $2, indexed_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $3 AND id = $4`,
        [status, chunkCount, tenantId, id]
      )
    } else {
      await this.sql(`UPDATE ${this.tableName} SET status = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3`, [status, tenantId, id])
    }
  }
}

export function buildDocumentWhere(filter?: DocumentStorageFilter | null, alias?: string): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const col = (name: string) => alias ? `${alias}.${name}` : name

  if (filter?.bucketId != null) { params.push(filter.bucketId); conditions.push(`${col('bucket_id')} = $${params.length}`) }
  if (filter?.tenantId != null) { params.push(filter.tenantId); conditions.push(`${col('tenant_id')} = $${params.length}`) }
  if (filter?.organizationId != null) { params.push(filter.organizationId); conditions.push(`${col('organization_id')} = $${params.length}`) }
  if (filter?.groupId != null) { params.push(filter.groupId); conditions.push(`${col('group_id')} = $${params.length}`) }
  if (filter?.userId != null) { params.push(filter.userId); conditions.push(`${col('user_id')} = $${params.length}`) }
  if (filter?.agentId != null) { params.push(filter.agentId); conditions.push(`${col('agent_id')} = $${params.length}`) }
  if (filter?.threadId != null) { params.push(filter.threadId); conditions.push(`${col('thread_id')} = $${params.length}`) }
  if (filter?.graphIds != null) {
    if (filter.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.graphIds)
      conditions.push(`${col('graph_id')} = ANY($${params.length}::text[])`)
    }
  }
  if (filter?.status != null) {
    if (Array.isArray(filter.status)) {
      params.push(filter.status)
      conditions.push(`${col('status')} = ANY($${params.length}::text[])`)
    } else {
      params.push(filter.status)
      conditions.push(`${col('status')} = $${params.length}`)
    }
  }
  if (filter?.documentIds != null && filter.documentIds.length > 0) {
    params.push(filter.documentIds)
    conditions.push(`${col('id')} = ANY($${params.length}::text[])`)
  }
  return { where: conditions.join(' AND '), params }
}
