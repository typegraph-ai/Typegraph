import type { d8umSource } from '../../types/source.js'
import type { d8umQuery } from '../../types/query.js'
import type { NormalizedResult } from '../merger.js'

export class CachedRunner {
  async run(query: d8umQuery, sources: d8umSource[]): Promise<NormalizedResult[]> {
    // TODO: check cache TTL, fetch if expired, search cached results
    throw new Error('Not implemented')
  }
}
