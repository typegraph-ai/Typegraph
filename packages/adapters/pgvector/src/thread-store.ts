import { accessScopeKeys } from '@typegraph-ai/sdk'
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
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    metadata: parseJson(row.metadata, {}),
    accessScope: parseJson(row.access_scope, []),
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
        (id, tenant_id, group_id, user_id, agent_id, name, description,
         metadata, access_scope, access_scope_ids, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::text[],NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         metadata = EXCLUDED.metadata,
         access_scope = EXCLUDED.access_scope,
         access_scope_ids = EXCLUDED.access_scope_ids,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.groupId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.name,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.accessScope ?? []),
        accessScopeKeys(input.accessScope),
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
  if (filter?.groupId != null) { params.push(filter.groupId); conditions.push(`group_id = $${params.length}`) }
  if (filter?.userId != null) { params.push(filter.userId); conditions.push(`user_id = $${params.length}`) }
  if (filter?.agentId != null) { params.push(filter.agentId); conditions.push(`agent_id = $${params.length}`) }
  if (filter?.threadIds != null && filter.threadIds.length > 0) { params.push(filter.threadIds); conditions.push(`id = ANY($${params.length}::text[])`) }
  if (filter?.accessScope !== undefined) {
    const accessScopeIds = accessScopeKeys(filter.accessScope)
    if (accessScopeIds.length === 0) {
      conditions.push('cardinality(access_scope_ids) = 0')
    } else {
      params.push(accessScopeIds)
      conditions.push(`(cardinality(access_scope_ids) = 0 OR access_scope_ids && $${params.length}::text[])`)
    }
  }
  return { where: conditions.join(' AND '), params }
}
