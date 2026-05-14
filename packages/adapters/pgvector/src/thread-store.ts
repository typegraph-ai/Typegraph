import type { ThreadStorageFilter, typegraphThread, UpsertThreadInput } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return (value ?? fallback) as T
}

function mapThreadRow(row: Record<string, unknown>): typegraphThread {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    graphId: (row.graph_id as string) ?? 'public',
    organizationId: (row.organization_id as string) ?? undefined,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    url: (row.url as string) ?? undefined,
    metadata: parseJson(row.metadata, {}),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export class PgThreadStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string,
  ) {}

  async upsert(input: UpsertThreadInput): Promise<typegraphThread> {
    const rows = await this.sql(
      `INSERT INTO ${this.tableName}
        (id, tenant_id, graph_id, organization_id, group_id, user_id, agent_id, name, description,
         url, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         graph_id = EXCLUDED.graph_id,
         organization_id = EXCLUDED.organization_id,
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         url = EXCLUDED.url,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.graphId,
        input.organizationId ?? null,
        input.groupId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.name,
        input.description ?? null,
        input.url ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    )
    return mapThreadRow(rows[0]!)
  }

  async get(tenantId: string, id: string): Promise<typegraphThread | null> {
    const rows = await this.sql(`SELECT * FROM ${this.tableName} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    return rows.length > 0 ? mapThreadRow(rows[0]!) : null
  }

  async list(filter?: ThreadStorageFilter | null): Promise<typegraphThread[]> {
    const { where, params } = buildThreadWhere(filter)
    const rows = await this.sql(`SELECT * FROM ${this.tableName} ${where ? `WHERE ${where}` : ''} ORDER BY updated_at DESC`, params)
    return rows.map(mapThreadRow)
  }
}

function buildThreadWhere(filter?: ThreadStorageFilter | null): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter?.tenantId != null) { params.push(filter.tenantId); conditions.push(`tenant_id = $${params.length}`) }
  if (filter?.organizationId != null) { params.push(filter.organizationId); conditions.push(`organization_id = $${params.length}`) }
  if (filter?.groupId != null) { params.push(filter.groupId); conditions.push(`group_id = $${params.length}`) }
  if (filter?.userId != null) { params.push(filter.userId); conditions.push(`user_id = $${params.length}`) }
  if (filter?.agentId != null) { params.push(filter.agentId); conditions.push(`agent_id = $${params.length}`) }
  if (filter?.graphIds != null) {
    if (filter.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.graphIds)
      conditions.push(`graph_id = ANY($${params.length}::text[])`)
    }
  }
  if (filter?.threadIds != null && filter.threadIds.length > 0) { params.push(filter.threadIds); conditions.push(`id = ANY($${params.length}::text[])`) }
  return { where: conditions.join(' AND '), params }
}
