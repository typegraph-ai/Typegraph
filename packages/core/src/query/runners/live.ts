import type { D8umSource } from '../../types/source.js'
import type { D8umQuery } from '../../types/query.js'
import type { NormalizedResult } from '../merger.js'

export class LiveRunner {
  async run(query: D8umQuery, sources: D8umSource[]): Promise<NormalizedResult[]> {
    // TODO: call connector.query() on each live source, normalize results
    throw new Error('Not implemented')
  }
}
