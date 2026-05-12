import { generateId } from '@typegraph-ai/sdk'
import type { EventStorageFilter, typegraphEventRecord, UpsertEventInput, UpsertLinkInput } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'
import { entityRefKey } from './identity.js'

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return (value ?? fallback) as T
}

export function mapEventRow(row: Record<string, unknown>): typegraphEventRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    graphId: (row.graph_id as string) ?? 'public',
    organizationId: (row.organization_id as string) ?? undefined,
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
        (id, tenant_id, graph_id, organization_id, group_id, user_id, agent_id, thread_id, name, description,
         occurred_at, participants, participant_ids, content, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::text[],$14,$15::jsonb,NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         graph_id = EXCLUDED.graph_id,
         organization_id = EXCLUDED.organization_id,
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
        input.threadId ?? null,
        input.name,
        input.description ?? null,
        input.occurredAt.toISOString(),
        JSON.stringify(input.participants ?? []),
        (input.participants ?? []).map(entityRefKey),
        input.content ?? null,
        JSON.stringify(input.metadata ?? {}),
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
        (id, tenant_id, graph_id, from_kind, from_id, to_kind, to_id, relation, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
       ON CONFLICT (tenant_id, graph_id, from_kind, from_id, to_kind, to_id, relation) DO UPDATE SET
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        id,
        input.tenantId,
        input.graphId ?? 'public',
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
  if (filter?.organizationId != null) { params.push(filter.organizationId); conditions.push(`organization_id = $${params.length}`) }
  if (filter?.groupId != null) { params.push(filter.groupId); conditions.push(`group_id = $${params.length}`) }
  if (filter?.userId != null) { params.push(filter.userId); conditions.push(`user_id = $${params.length}`) }
  if (filter?.agentId != null) { params.push(filter.agentId); conditions.push(`agent_id = $${params.length}`) }
  if (filter?.threadId != null) { params.push(filter.threadId); conditions.push(`thread_id = $${params.length}`) }
  if (filter?.graphIds != null) {
    if (filter.graphIds.length === 0) {
      conditions.push('FALSE')
    } else {
      params.push(filter.graphIds)
      conditions.push(`graph_id = ANY($${params.length}::text[])`)
    }
  }
  if (filter?.eventIds != null && filter.eventIds.length > 0) { params.push(filter.eventIds); conditions.push(`id = ANY($${params.length}::text[])`) }
  return { where: conditions.join(' AND '), params }
}
