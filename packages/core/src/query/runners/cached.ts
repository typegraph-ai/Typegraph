import type { D8umSource } from '../../types/source.js'
import type { D8umQuery } from '../../types/query.js'
import type { NormalizedResult } from '../merger.js'

export class CachedRunner {
  async run(query: D8umQuery, sources: D8umSource[]): Promise<NormalizedResult[]> {
    // TODO: check cache TTL, fetch if expired, search cached results
    throw new Error('Not implemented')
  }
}
