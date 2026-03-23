import type { HashStoreAdapter, HashRecord } from '@d8um/core'

export class PgHashStore implements HashStoreAdapter {
  constructor(
    private sql: any,
    private tableName: string
  ) {}

  async initialize(): Promise<void> {
    // Tables created via migrations.ts INIT_SQL
  }

  async get(key: string): Promise<HashRecord | null> {
    // TODO: SELECT * FROM ${tableName} WHERE store_key = $1
    throw new Error('Not implemented')
  }

  async set(key: string, record: HashRecord): Promise<void> {
    // TODO: INSERT ... ON CONFLICT (store_key) DO UPDATE
    throw new Error('Not implemented')
  }

  async delete(key: string): Promise<void> {
    // TODO: DELETE FROM ${tableName} WHERE store_key = $1
    throw new Error('Not implemented')
  }

  async listBySource(sourceId: string, tenantId?: string): Promise<HashRecord[]> {
    // TODO: SELECT * FROM ${tableName} WHERE source_id = $1 AND tenant_id = $2
    throw new Error('Not implemented')
  }

  async getLastRunTime(sourceId: string, tenantId?: string): Promise<Date | null> {
    // TODO: SELECT last_run FROM ${tableName}_run_times WHERE ...
    throw new Error('Not implemented')
  }

  async setLastRunTime(sourceId: string, tenantId: string | undefined, time: Date): Promise<void> {
    // TODO: INSERT ... ON CONFLICT DO UPDATE
    throw new Error('Not implemented')
  }

  async deleteBySource(sourceId: string, tenantId?: string): Promise<void> {
    // TODO: DELETE FROM ${tableName} WHERE source_id = $1 AND tenant_id = $2
    throw new Error('Not implemented')
  }
}
