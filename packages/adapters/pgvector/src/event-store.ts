import { accessScopeKeys, entityRefKey, generateId } from '@typegraph-ai/sdk'
import type { EventStorageFilter, typegraphEventRecord, UpsertEventInput, UpsertLinkInput } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return (value ?? fallback) as T
}

export function mapEventRow(row: Record<string, unknown>): typegraphEventRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    groupId: (row.group_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    threadId: (row.thread_id as string) ?? undefined,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    occurredAt: new Date(row.occurred_at as string),
    participants: parseJson(row.participants, []),
    content: (row.content as string) ?? undefined,
    metadata: parseJson(row.metadata, {}),
    accessScope: parseJson(row.access_scope, []),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export class PgEventStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string,
  ) {}

  async upsert(input: UpsertEventInput): Promise<typegraphEventRecord> {
    const rows = await this.sql(
      `INSERT INTO ${this.tableName}
        (id, tenant_id, group_id, user_id, agent_id, thread_id, name, description,
         occurred_at, participants, participant_ids, content, metadata, access_scope,
         access_scope_ids, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::text[],$12,$13::jsonb,$14::jsonb,$15::text[],NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         group_id = EXCLUDED.group_id,
         user_id = EXCLUDED.user_id,
         agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         occurred_at = EXCLUDED.occurred_at,
         participants = EXCLUDED.participants,
         participant_ids = EXCLUDED.participant_ids,
         content = EXCLUDED.content,
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
        input.threadId ?? null,
        input.name,
        input.description ?? null,
        input.occurredAt.toISOString(),
        JSON.stringify(input.participants ?? []),
        (input.participants ?? []).map(entityRefKey),
        input.content ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.accessScope ?? []),
        accessScopeKeys(input.accessScope),
      ],
    )
    return mapEventRow(rows[0]!)
  }

  async get(tenantId: string, id: string): Promise<typegraphEventRecord | null> {
    const rows = await this.sql(`SELECT * FROM ${this.tableName} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    return rows.length > 0 ? mapEventRow(rows[0]!) : null
  }

  async list(filter?: EventStorageFilter | null): Promise<typegraphEventRecord[]> {
    const { where, params } = buildEventWhere(filter)
    const rows = await this.sql(`SELECT * FROM ${this.tableName} ${where ? `WHERE ${where}` : ''} ORDER BY occurred_at DESC`, params)
    return rows.map(mapEventRow)
  }
}

export class PgLinkStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string,
  ) {}

  async upsert(input: UpsertLinkInput): Promise<void> {
    const id = input.id ?? generateId('link')
    await this.sql(
      `INSERT INTO ${this.tableName}
        (id, tenant_id, from_kind, from_id, to_kind, to_id, relation, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
       ON CONFLICT (tenant_id, from_kind, from_id, to_kind, to_id, relation) DO UPDATE SET
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        id,
        input.tenantId,
        input.fromKind,
        input.fromId,
        input.toKind,
        input.toId,
        input.relation,
        JSON.stringify(input.metadata ?? {}),
      ],
    )
  }
}

export function buildEventWhere(filter?: EventStorageFilter | null): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter?.tenantId != null) { params.push(filter.tenantId); conditions.push(`tenant_id = $${params.length}`) }
  if (filter?.groupId != null) { params.push(filter.groupId); conditions.push(`group_id = $${params.length}`) }
  if (filter?.userId != null) { params.push(filter.userId); conditions.push(`user_id = $${params.length}`) }
  if (filter?.agentId != null) { params.push(filter.agentId); conditions.push(`agent_id = $${params.length}`) }
  if (filter?.threadId != null) { params.push(filter.threadId); conditions.push(`thread_id = $${params.length}`) }
  if (filter?.eventIds != null && filter.eventIds.length > 0) { params.push(filter.eventIds); conditions.push(`id = ANY($${params.length}::text[])`) }
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
