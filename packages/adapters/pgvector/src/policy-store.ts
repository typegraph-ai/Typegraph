import type { PolicyStoreAdapter, Policy, CreatePolicyInput, UpdatePolicyInput, PolicyType } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

export interface PgPolicyStoreConfig {
  sql: SqlExecutor
  /** Schema-qualified table name, e.g. '"cust_abc".typegraph_policies' */
  policiesTable?: string
}

export class PgPolicyStore implements PolicyStoreAdapter {
  private sql: SqlExecutor
  private table: string

  constructor(config: PgPolicyStoreConfig) {
    this.sql = config.sql
    this.table = config.policiesTable ?? 'typegraph_policies'
  }

  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    const id = `pol_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const rows = await this.sql(
      `INSERT INTO ${this.table} (id, name, policy_type, tenant_id, group_id, user_id, agent_id, rules, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.name,
        input.policyType,
        input.tenantId ?? null,
        input.groupId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        JSON.stringify(input.rules),
        input.enabled ?? true,
      ],
    )
    return this.mapRow(rows[0]!)
  }

  async getPolicy(id: string): Promise<Policy | null> {
    const rows = await this.sql(
      `SELECT * FROM ${this.table} WHERE id = $1`,
      [id],
    )
    return rows.length > 0 ? this.mapRow(rows[0]!) : null
  }

  async listPolicies(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (filter?.tenantId) {
      conditions.push(`tenant_id = $${idx++}`)
      params.push(filter.tenantId)
    }
    if (filter?.policyType) {
      conditions.push(`policy_type = $${idx++}`)
      params.push(filter.policyType)
    }
    if (filter?.enabled !== undefined) {
      conditions.push(`enabled = $${idx++}`)
      params.push(filter.enabled)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.sql(
      `SELECT * FROM ${this.table} ${where} ORDER BY created_at DESC`,
      params,
    )
    return rows.map((r: Record<string, unknown>) => this.mapRow(r))
  }

  async updatePolicy(id: string, input: UpdatePolicyInput): Promise<Policy> {
    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (input.name !== undefined) {
      sets.push(`name = $${idx++}`)
      params.push(input.name)
    }
    if (input.rules !== undefined) {
      sets.push(`rules = $${idx++}`)
      params.push(JSON.stringify(input.rules))
    }
    if (input.enabled !== undefined) {
      sets.push(`enabled = $${idx++}`)
      params.push(input.enabled)
    }

    sets.push(`updated_at = NOW()`)
    params.push(id)

    const rows = await this.sql(
      `UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    )

    if (rows.length === 0) {
      throw new Error(`Policy not found: ${id}`)
    }
    return this.mapRow(rows[0]!)
  }

  async deletePolicy(id: string): Promise<void> {
    await this.sql(`DELETE FROM ${this.table} WHERE id = $1`, [id])
  }

  private mapRow(row: Record<string, unknown>): Policy {
    return {
      id: row.id as string,
      name: row.name as string,
      policyType: row.policy_type as PolicyType,
      tenantId: row.tenant_id as string | undefined,
      groupId: row.group_id as string | undefined,
      userId: row.user_id as string | undefined,
      agentId: row.agent_id as string | undefined,
      rules: typeof row.rules === 'string' ? JSON.parse(row.rules) : (row.rules as Policy['rules']),
      enabled: row.enabled as boolean,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    }
  }
}
