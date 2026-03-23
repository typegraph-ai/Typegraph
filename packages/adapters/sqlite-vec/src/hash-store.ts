import type { HashStoreAdapter, HashRecord } from '@d8um/core'

export class SqliteHashStore implements HashStoreAdapter {
  constructor(private db: any) {}

  async initialize(): Promise<void> {
    // TODO: CREATE TABLE IF NOT EXISTS for hashes and run_times
    throw new Error('Not implemented')
  }

  async get(key: string): Promise<HashRecord | null> {
    throw new Error('Not implemented')
  }

  async set(key: string, record: HashRecord): Promise<void> {
    throw new Error('Not implemented')
  }

  async delete(key: string): Promise<void> {
    throw new Error('Not implemented')
  }

  async listBySource(sourceId: string, tenantId?: string): Promise<HashRecord[]> {
    throw new Error('Not implemented')
  }

  async getLastRunTime(sourceId: string, tenantId?: string): Promise<Date | null> {
    throw new Error('Not implemented')
  }

  async setLastRunTime(sourceId: string, tenantId: string | undefined, time: Date): Promise<void> {
    throw new Error('Not implemented')
  }

  async deleteBySource(sourceId: string, tenantId?: string): Promise<void> {
    throw new Error('Not implemented')
  }
}
