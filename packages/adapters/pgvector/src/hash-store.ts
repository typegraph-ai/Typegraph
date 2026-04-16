import type { HashStoreAdapter, HashRecord } from '@typegraph-ai/sdk'
import type { SqlExecutor } from './adapter.js'

function mapRow(row: Record<string, unknown>): HashRecord {
  return {
    idempotencyKey: row.idempotency_key as string,
    contentHash: row.content_hash as string,
    bucketId: row.bucket_id as string,
    tenantId: (row.tenant_id as string) ?? undefined,
    embeddingModel: row.embedding_model as string,
    indexedAt: new Date(row.indexed_at as string),
    chunkCount: row.chunk_count as number,
  }
}

export class PgHashStore implements HashStoreAdapter {
  constructor(
    private sql: SqlExecutor,
    private tableName: string
  ) {}

  async initialize(): Promise<void> {
    // Tables created via migrations.ts HASH_TABLE_SQL
  }

  async get(key: string): Promise<HashRecord | null> {
    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} WHERE store_key = $1`,
      [key]
    )
    if (rows.length === 0) return null
    return mapRow(rows[0]!)
  }

  async getMany(keys: string[]): Promise<Map<string, HashRecord>> {
    if (keys.length === 0) return new Map()
    const rows = await this.sql(
      `SELECT * FROM ${this.tableName} WHERE store_key = ANY($1::text[])`,
      [keys]
    )
    const map = new Map<string, HashRecord>()
    for (const row of rows) {
      map.set(row.store_key as string, mapRow(row))
    }
    return map
  }

  async set(key: string, record: HashRecord): Promise<void> {
    await this.sql(
      `INSERT INTO ${this.tableName}
        (store_key, idempotency_key, content_hash, bucket_id, tenant_id, embedding_model, indexed_at, chunk_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (store_key) DO UPDATE SET
        idempotency_key = EXCLUDED.idempotency_key,
        content_hash    = EXCLUDED.content_hash,
        bucket_id       = EXCLUDED.bucket_id,
        tenant_id       = EXCLUDED.tenant_id,
        embedding_model = EXCLUDED.embedding_model,
        indexed_at      = EXCLUDED.indexed_at,
        chunk_count     = EXCLUDED.chunk_count`,
      [
        key,
        record.idempotencyKey,
        record.contentHash,
        record.bucketId,
        record.tenantId ?? null,
        record.embeddingModel,
        record.indexedAt.toISOString(),
        record.chunkCount,
      ]
    )
  }

  async delete(key: string): Promise<void> {
    await this.sql(
      `DELETE FROM ${this.tableName} WHERE store_key = $1`,
      [key]
    )
  }

  async listByBucket(bucketId: string, tenantId?: string): Promise<HashRecord[]> {
    const rows = tenantId != null
      ? await this.sql(
          `SELECT * FROM ${this.tableName} WHERE bucket_id = $1 AND tenant_id = $2`,
          [bucketId, tenantId]
        )
      : await this.sql(
          `SELECT * FROM ${this.tableName} WHERE bucket_id = $1 AND tenant_id IS NULL`,
          [bucketId]
        )
    return rows.map(mapRow)
  }

  async getLastRunTime(bucketId: string, tenantId?: string): Promise<Date | null> {
    const rows = await this.sql(
      `SELECT last_run FROM ${this.tableName}_run_times
       WHERE bucket_id = $1 AND tenant_id = COALESCE($2, '')`,
      [bucketId, tenantId ?? null]
    )
    if (rows.length === 0) return null
    return new Date(rows[0]!.last_run as string)
  }

  async setLastRunTime(bucketId: string, tenantId: string | undefined, time: Date): Promise<void> {
    await this.sql(
      `INSERT INTO ${this.tableName}_run_times (bucket_id, tenant_id, last_run)
       VALUES ($1, COALESCE($2, ''), $3)
       ON CONFLICT (bucket_id, tenant_id) DO UPDATE SET
        last_run = EXCLUDED.last_run`,
      [bucketId, tenantId ?? null, time.toISOString()]
    )
  }

  async deleteByIdempotencyKeys(keys: string[], bucketId: string, tenantId?: string): Promise<number> {
    if (keys.length === 0) return 0
    const rows = await this.sql(
      `DELETE FROM ${this.tableName}
       WHERE idempotency_key = ANY($1::text[])
         AND bucket_id = $2
         AND ${tenantId != null ? 'tenant_id = $3' : 'tenant_id IS NULL'}
       RETURNING store_key`,
      tenantId != null ? [keys, bucketId, tenantId] : [keys, bucketId]
    )
    return rows.length
  }

  async deleteByBucket(bucketId: string, tenantId?: string): Promise<void> {
    if (tenantId != null) {
      await this.sql(
        `DELETE FROM ${this.tableName} WHERE bucket_id = $1 AND tenant_id = $2`,
        [bucketId, tenantId]
      )
      await this.sql(
        `DELETE FROM ${this.tableName}_run_times WHERE bucket_id = $1 AND tenant_id = $2`,
        [bucketId, tenantId]
      )
    } else {
      await this.sql(
        `DELETE FROM ${this.tableName} WHERE bucket_id = $1 AND tenant_id IS NULL`,
        [bucketId]
      )
      await this.sql(
        `DELETE FROM ${this.tableName}_run_times WHERE bucket_id = $1 AND tenant_id IS NULL`,
        [bucketId]
      )
    }
  }

  /** Delete ALL hash entries for a bucket regardless of tenant. Used by bucket cascade delete. */
  async deleteAllByBucket(bucketId: string): Promise<void> {
    await this.sql(
      `DELETE FROM ${this.tableName} WHERE bucket_id = $1`,
      [bucketId]
    )
    await this.sql(
      `DELETE FROM ${this.tableName}_run_times WHERE bucket_id = $1`,
      [bucketId]
    )
  }
}
