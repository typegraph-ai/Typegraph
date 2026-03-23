import type { Connector, RawDocument, Chunk, ChunkOpts } from '@d8um/core'
import { notionChunker } from './chunker.js'

export interface NotionConnectorConfig {
  apiKey: string
  databaseIds?: string[]
  pageIds?: string[]
}

export type NotionMeta = {
  pageId: string
  workspaceId?: string
  parentPageId?: string
  lastEditedBy?: string
  notionUrl: string
  properties?: Record<string, unknown>
}

export class NotionConnector implements Connector<NotionMeta> {
  constructor(private config: NotionConnectorConfig) {}

  async *fetch(): AsyncIterable<RawDocument<NotionMeta>> {
    // TODO: implement with @notionhq/client
    throw new Error('Not implemented')
  }

  async *fetchSince(since: Date): AsyncIterable<RawDocument<NotionMeta>> {
    // TODO: use Notion search API filter: last_edited_time after `since`
    throw new Error('Not implemented')
  }

  chunk(doc: RawDocument<NotionMeta>, opts: ChunkOpts): Chunk[] {
    return notionChunker(doc, opts)
  }

  async healthCheck(): Promise<void> {
    // TODO: call GET /v1/users/me
  }
}
