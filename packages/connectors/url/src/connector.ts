import type { Connector, RawDocument } from '@d8um/core'

export interface UrlConnectorConfig {
  urls: string[]
  sitemapUrls?: string[]
  maxPages?: number
  crawlDelay?: number
  userAgent?: string
  filter?: (url: string) => boolean
}

export type UrlMeta = {
  fetchedAt: Date
  statusCode: number
  contentType: string
  links?: string[]
}

export class UrlConnector implements Connector<UrlMeta> {
  constructor(private config: UrlConnectorConfig) {}

  async *fetch(): AsyncIterable<RawDocument<UrlMeta>> {
    // TODO: implement with undici or native fetch + cheerio for HTML stripping
    throw new Error('Not implemented')
  }

  async *fetchSince(since: Date): AsyncIterable<RawDocument<UrlMeta>> {
    // TODO: use Last-Modified / sitemap <lastmod> to filter
    throw new Error('Not implemented')
  }

  async healthCheck(): Promise<void> {
    // TODO: HEAD request on first URL
  }
}
