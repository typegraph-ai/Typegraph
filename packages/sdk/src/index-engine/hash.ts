import { createHash } from 'crypto'
import type { DocumentInput } from '../types/document.js'

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

const AUTO_HASH_THRESHOLD = 128

export function resolveIdempotencyKey(
  document: DocumentInput,
  spec: string[] | ((document: DocumentInput) => string)
): string {
  const raw = typeof spec === 'function'
    ? spec(document)
    : spec.map(field => {
        if (field.startsWith('metadata.')) {
          const key = field.slice('metadata.'.length)
          return String(document.metadata?.[key] ?? '')
        }
        return String((document as unknown as Record<string, unknown>)[field] ?? '')
      }).join('::')

  // Auto-hash long keys (e.g. when deduplicating by content)
  return raw.length > AUTO_HASH_THRESHOLD ? sha256(raw) : raw
}

export function buildHashStoreKey(
  tenantId: string | undefined,
  bucketId: string,
  idempotencyKey: string
): string {
  return [tenantId ?? '__global__', bucketId, idempotencyKey].join('::')
}
