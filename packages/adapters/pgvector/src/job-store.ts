import type { Job, JobFilter, JobStatus, JobStatusPatch, UpsertJobInput, PaginationOpts, PaginatedResult } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

const TERMINAL_STATUSES: JobStatus[] = ['complete', 'failed']

function mapJobRow(row: Record<string, unknown>): Job {
  const processed = row.progress_processed as number | null
  const total = row.progress_total as number | null
  const progress = total != null ? { processed: processed ?? 0, total } : undefined
  const resultRaw = row.result
  const result = resultRaw == null
    ? undefined
    : (typeof resultRaw === 'string' ? JSON.parse(resultRaw) : resultRaw) as Job['result']
  return {
    id: row.id as string,
    type: row.type as Job['type'],
    status: row.status as JobStatus,
    bucketId: (row.bucket_id as string) ?? undefined,
    result,
    error: (row.error as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    progress,
  }
}

export class PgJobStore {
  constructor(
    private sql: SqlExecutor,
    private tableName: string
  ) {}

  async upsert(input: UpsertJobInput): Promise<Job> {
    const status = input.status ?? 'pending'
    const rows = await this.sql(
      `INSERT INTO ${this.tableName}
        (id, type, status, bucket_id, progress_processed, progress_total, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         bucket_id = EXCLUDED.bucket_id,
         progress_processed = EXCLUDED.progress_processed,
         progress_total = EXCLUDED.progress_total,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id,
        input.type,
        status,
        input.bucketId ?? null,
        input.progressProcessed ?? 0,
        input.progressTotal ?? null,
      ]
    )
    return mapJobRow(rows[0]!)
  }

  async get(id: string): Promise<Job | null> {
    const rows = await this.sql(`SELECT * FROM ${this.tableName} WHERE id = $1`, [id])
    if (rows.length === 0) return null
    return mapJobRow(rows[0]!)
  }

  async list(filter?: JobFilter | null, pagination?: PaginationOpts | null): Promise<Job[] | PaginatedResult<Job>> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.bucketId != null) {
      params.push(filter.bucketId)
      conditions.push(`bucket_id = $${params.length}`)
    }
    if (filter?.status != null) {
      params.push(filter.status)
      conditions.push(`status = $${params.length}`)
    }
    if (filter?.type != null) {
      params.push(filter.type)
      conditions.push(`type = $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    if (pagination) {
      const limit = pagination.limit ?? 100
      const offset = pagination.offset ?? 0
      const countRows = await this.sql(
        `SELECT COUNT(*)::int AS total FROM ${this.tableName} ${where}`,
        params
      )
      const total = (countRows[0]?.total as number) ?? 0
      const rows = await this.sql(
        `SELECT * FROM ${this.tableName} ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )
      return { items: rows.map(mapJobRow), total, limit, offset }
    }

    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} ${where} ORDER BY created_at DESC`,
      params
    )
    return rows.map(mapJobRow)
  }

  async updateStatus(id: string, patch: JobStatusPatch): Promise<void> {
    const setClauses: string[] = ['updated_at = NOW()']
    const params: unknown[] = []

    if (patch.status !== undefined) {
      params.push(patch.status)
      setClauses.push(`status = $${params.length}`)
      const terminal = TERMINAL_STATUSES.includes(patch.status)
      if (terminal && patch.completedAt === undefined) {
        setClauses.push(`completed_at = NOW()`)
      }
    }
    if (patch.completedAt !== undefined) {
      params.push(patch.completedAt)
      setClauses.push(`completed_at = $${params.length}`)
    }
    if (patch.result !== undefined) {
      params.push(JSON.stringify(patch.result))
      setClauses.push(`result = $${params.length}::jsonb`)
    }
    if (patch.error !== undefined) {
      params.push(patch.error)
      setClauses.push(`error = $${params.length}`)
    }
    if (patch.progressProcessed !== undefined) {
      params.push(patch.progressProcessed)
      setClauses.push(`progress_processed = $${params.length}`)
    }
    if (patch.progressTotal !== undefined) {
      params.push(patch.progressTotal)
      setClauses.push(`progress_total = $${params.length}`)
    }

    params.push(id)
    await this.sql(
      `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params
    )
  }

  async incrementProgress(id: string, processedDelta: number): Promise<void> {
    await this.sql(
      `UPDATE ${this.tableName}
       SET progress_processed = progress_processed + $1, updated_at = NOW()
       WHERE id = $2`,
      [processedDelta, id]
    )
  }
}
