const DEFAULT_BASE_URL = 'https://api.typegraph.dev'
const DEFAULT_TIMEOUT = 30_000

export interface CloudConfig {
  /** API key for the typegraph cloud service. */
  apiKey: string
  /** Base URL for the cloud API. Defaults to 'https://api.typegraph.dev'. */
  baseUrl?: string | undefined
  /** Default tenant ID for all operations. */
  tenantId?: string | undefined
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number | undefined
}

export class TypegraphApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'TypegraphApiError'
  }
}

export class HttpClient {
  private baseUrl: string
  private apiKey: string
  private tenantId: string | undefined
  private timeout: number

  constructor(config: CloudConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.tenantId = config.tenantId
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(path, params)
    return this.request<T>(url, { method: 'GET' })
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'POST' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'PATCH' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  async delete<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const init: RequestInit = { method: 'DELETE' }
    if (body !== undefined) init.body = JSON.stringify(body, dateReplacer)
    return this.request<T>(url, init)
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl + '/')
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }
    return url.toString()
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
    if (this.tenantId) {
      headers['X-Tenant-Id'] = this.tenantId
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch((err) => { console.error('[typegraph] Failed to read error response body:', err instanceof Error ? err.message : err); return '' })
        throw new TypegraphApiError(
          `typegraph API error: ${response.status} ${response.statusText}`,
          response.status,
          body ? tryParseJson(body) : undefined,
        )
      }

      const text = await response.text()
      if (!text) return undefined as T
      return JSON.parse(text, dateReviver) as T
    } catch (error) {
      if (error instanceof TypegraphApiError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new TypegraphApiError('Request timed out', 0)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

function dateReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value)
    if (!isNaN(date.getTime())) return date
  }
  return value
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
