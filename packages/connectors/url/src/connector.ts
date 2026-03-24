import type { Connector, RawDocument } from '@d8um/core'
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import TurndownService from 'turndown'
// @ts-expect-error -- no type declarations
import { gfm } from 'turndown-plugin-gfm'

export const DEFAULT_STRIP_ELEMENTS = [
  'nav', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe', 'svg',
]

export const DEFAULT_STRIP_SELECTORS = [
  '.cookie-card', '.cookie-modal', '.consent_blackbar', '.mutiny-banner',
  '.sidebar', '.breadcrumbs', '.skiplink',
  '#consent-manager', '#table-of-contents',
  '.nav', '.navbar', '#navbar', '.navigation', '.menu',
  '.footer', '.widget',
  '.ad', '.ads', '.advertisement', '.sponsored',
  '.social', '.share', '.sharing',
  '.disqus', '.related', '#related-topics',
  '.recommended', '.suggestions',
  '.cookie', '.popup', '.modal', '.overlay',
  '.breadcrumb', '.meta', '.tags', '.skip',
  '#header', '#footer', '#nav', '#navigation', '#sidebar',
  '#social', '#ads', '#cookie-notice', '#popup', '#modal',
  '.sidebar-wrapper',
]

export interface UrlConnectorConfig {
  urls: string[]
  sitemapUrls?: string[]
  maxPages?: number
  crawlDelay?: number
  userAgent?: string
  stripElements?: string[]
  stripSelectors?: string[]
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
    for (const url of this.config.urls) {
      const doc = await this.fetchPage(url)
      if (doc) yield doc
    }
  }

  async *fetchSince(since: Date): AsyncIterable<RawDocument<UrlMeta>> {
    for (const url of this.config.urls) {
      const doc = await this.fetchPage(url, since)
      if (doc) yield doc
    }
  }

  async healthCheck(): Promise<void> {
    if (this.config.urls.length === 0) {
      throw new Error('No URLs configured')
    }
    const res = await fetch(this.config.urls[0]!, {
      method: 'HEAD',
      headers: this.buildHeaders(),
    })
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status} ${res.statusText}`)
    }
  }

  /** Fetch and parse a single page. Returns null if skipped (e.g. 304). */
  async fetchPage(url: string, ifModifiedSince?: Date): Promise<RawDocument<UrlMeta> | null> {
    const headers = this.buildHeaders()
    if (ifModifiedSince) {
      headers['If-Modified-Since'] = ifModifiedSince.toUTCString()
    }

    const res = await fetch(url, { headers })

    if (res.status === 304) return null
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    const lastModified = res.headers.get('last-modified')
    const html = await res.text()

    const isHtml = contentType.includes('text/html') || html.trimStart().startsWith('<')

    let title = ''
    let content = ''
    let links: string[] = []

    if (isHtml) {
      const result = this.parseHtml(html, url)
      title = result.title
      content = result.content
      links = result.links
    } else {
      // Plain text or other content — use as-is
      content = html
      title = url
    }

    return {
      id: normalizeUrlForId(url),
      content,
      title,
      url,
      updatedAt: lastModified ? new Date(lastModified) : new Date(),
      metadata: {
        fetchedAt: new Date(),
        statusCode: res.status,
        contentType,
        links,
      },
    }
  }

  private parseHtml(html: string, baseUrl: string): { title: string; content: string; links: string[] } {
    const $ = cheerio.load(html)

    const title = $('title').first().text().trim() || $('h1').first().text().trim() || baseUrl

    // Extract links BEFORE stripping elements (nav/footer contain most links)
    const links: string[] = []
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (href) {
        const resolved = resolveUrl(href, baseUrl)
        if (resolved) links.push(resolved)
      }
    })

    // --- Cheerio preprocessing ---

    // Expand accordions and hidden content so turndown can see it
    expandHiddenContent($)

    // Strip decorative images (logos, icons, tracking pixels)
    stripDecorativeImages($)

    // Strip unwanted elements for content extraction
    const stripElements = this.config.stripElements ?? DEFAULT_STRIP_ELEMENTS
    const stripSelectors = this.config.stripSelectors ?? DEFAULT_STRIP_SELECTORS

    for (const el of stripElements) {
      $(el).remove()
    }
    for (const sel of stripSelectors) {
      $(sel).remove()
    }

    // --- Turndown conversion ---

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })

    // GFM support: tables, strikethrough, task lists
    turndown.use(gfm)

    // Custom rule: render <details>/<summary> as bold heading + body
    turndown.addRule('details-summary', {
      filter: 'details' as any,
      replacement(content: string, node: any) {
        const summaryEl = node.querySelector?.('summary')
        const summaryText = (summaryEl?.textContent ?? 'Details').trim()
        // Get content excluding the summary
        const bodyContent = content.replace(summaryText, '').trim()
        return `\n\n**${summaryText}**\n\n${bodyContent}\n\n`
      },
    })

    // Prevent summary from rendering separately
    turndown.addRule('summary-skip', {
      filter: 'summary' as any,
      replacement(_content: string, node: any) {
        return (node.textContent ?? '').trim()
      },
    })

    // Skip decorative images that survived cheerio preprocessing
    turndown.addRule('skip-decorative-images', {
      filter(node: any) {
        if (node.nodeName !== 'IMG') return false
        const alt = (node.getAttribute?.('alt') ?? '').toLowerCase()
        const src = (node.getAttribute?.('src') ?? '').toLowerCase()

        // Empty alt = explicitly decorative per HTML spec
        if (node.getAttribute?.('alt') === '') return true
        // Logo/icon images
        if (/\blogo\b/.test(alt) && alt.split(/\s+/).length <= 4) return true
        if (/\/(logos?|brand-logos?|icons?)\//i.test(src)) return true

        return false
      },
      replacement() { return '' },
    })

    turndown.remove(['script', 'style', 'noscript'])

    const bodyHtml = $('body').html() ?? ''
    const content = turndown.turndown(bodyHtml)
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return { title, content, links: [...new Set(links)] }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent
    }
    return headers
  }
}

// --- Cheerio preprocessing helpers ---

/** Expand accordions, details/summary, and hidden content so turndown can process it. */
function expandHiddenContent($: CheerioAPI): void {
  // Open all <details> elements
  $('details').attr('open', '')

  // Unhide aria-hidden and hidden elements
  $('[aria-hidden="true"]').removeAttr('aria-hidden')
  $('[hidden]').removeAttr('hidden')

  // Strip display:none from inline styles
  $('[style*="display: none"], [style*="display:none"]').each((_, el) => {
    const style = $(el).attr('style') ?? ''
    $(el).attr('style', style.replace(/display\s*:\s*none\s*;?/gi, ''))
  })

  // Expand aria-expanded="false" accordion panels
  $('[aria-expanded="false"]').each((_, el) => {
    $(el).attr('aria-expanded', 'true')
    const controlsId = $(el).attr('aria-controls')
    if (controlsId) {
      $(`#${controlsId}`)
        .removeAttr('hidden')
        .removeAttr('aria-hidden')
        .css('display', '')
    }
  })

  // Handle common accordion class patterns
  const accordionSelectors = [
    '[class*="accordion-content"]',
    '[class*="accordion-body"]',
    '[class*="collapse"]',
    '[class*="expandable"]',
  ].join(', ')

  $(accordionSelectors).each((_, el) => {
    $(el).removeAttr('hidden').removeAttr('aria-hidden')
    const style = $(el).attr('style') ?? ''
    $(el).attr('style', style
      .replace(/display\s*:\s*none\s*;?/gi, '')
      .replace(/height\s*:\s*0[^;]*;?/gi, '')
      .replace(/overflow\s*:\s*hidden\s*;?/gi, '')
    )
  })

  // Remove common CSS hiding classes
  const hidingClasses = ['hidden', 'd-none', 'sr-only', 'visually-hidden', 'invisible']
  for (const cls of hidingClasses) {
    $(`.${cls}`).each((_, el) => {
      // Only unhide if element has meaningful text content
      const text = $(el).text().trim()
      if (text.length > 20) {
        $(el).removeClass(cls)
      }
    })
  }
}

/** Remove decorative images: logos, icons, tracking pixels, social icons. */
function stripDecorativeImages($: CheerioAPI): void {
  // Remove images in known decorative containers
  const decorativeContainerSelectors = [
    '[class*="logo-carousel"]', '[class*="logo-strip"]',
    '[class*="brand-logo"]', '[class*="client-logo"]',
    '[class*="partner-logo"]', '[class*="customer-logo"]',
    '[class*="logo-grid"]', '[class*="logo-wall"]',
    '[class*="logo-bar"]', '[class*="trusted-by"]',
    '[class*="as-seen"]', '[class*="featured-in"]',
  ].join(', ')

  $(decorativeContainerSelectors).find('img').remove()

  // Remove tiny images (icons/tracking pixels)
  $('img').each((_, img) => {
    const width = parseInt($(img).attr('width') ?? '', 10)
    const height = parseInt($(img).attr('height') ?? '', 10)
    if ((width && width < 40) || (height && height < 40)) {
      $(img).remove()
    }
  })

  // Remove images with logo/icon/brand in src path that also have short alt text
  $('img').each((_, img) => {
    const src = ($(img).attr('src') ?? '').toLowerCase()
    const alt = $(img).attr('alt')

    // Explicitly decorative per HTML spec
    if (alt === '') { $(img).remove(); return }

    // Tracking pixels
    if (/pixel|track|beacon|spacer|1x1|clear\.gif/i.test(src)) { $(img).remove(); return }

    // Logo/brand images with short alt
    const altLower = (alt ?? '').toLowerCase()
    if (/\/(logos?|brand-logos?|icons?|favicon)\//i.test(src) && altLower.split(/\s+/).length <= 4) {
      $(img).remove()
    }
  })
}

function normalizeUrlForId(url: string): string {
  try {
    const u = new URL(url)
    // Strip trailing slash, query, hash for consistent IDs
    let path = u.pathname
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    return `${u.hostname}${path}`
  } catch {
    return url
  }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    // Skip non-http links
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('#')) {
      return null
    }
    const resolved = new URL(href, baseUrl)
    // Only keep http(s) links
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null
    }
    return resolved.href
  } catch {
    return null
  }
}
