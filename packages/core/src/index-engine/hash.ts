import { createHash } from 'crypto'
import type { RawDocument } from '../types/connector.js'

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function resolveIdempotencyKey(
  doc: RawDocument,
  spec: string[] | ((doc: RawDocument) => string)
): string {
  if (typeof spec === 'function') return spec(doc)

  return spec.map(field => {
    if (field.startsWith('metadata.')) {
      const key = field.slice('metadata.'.length)
      return String(doc.metadata[key] ?? '')
    }
    return String((doc as unknown as Record<string, unknown>)[field] ?? '')
  }).join('::')
}

export function buildHashStoreKey(
  tenantId: string | undefined,
  sourceId: string,
  idempotencyKey: string
): string {
  return [tenantId ?? '__global__', sourceId, idempotencyKey].join('::')
}
