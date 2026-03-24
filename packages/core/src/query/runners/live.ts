import type { d8umSource } from '../../types/source.js'
import type { d8umQuery } from '../../types/query.js'
import type { NormalizedResult } from '../merger.js'

export class LiveRunner {
  async run(query: d8umQuery, sources: d8umSource[]): Promise<NormalizedResult[]> {
    // TODO: call connector.query() on each live source, normalize results
    throw new Error('Not implemented')
  }
}
