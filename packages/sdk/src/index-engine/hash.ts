import { createHash } from 'crypto'
import type { SourceInput } from '../types/connector.js'

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

const AUTO_HASH_THRESHOLD = 128

export function resolveIdempotencyKey(
  source: SourceInput,
  spec: string[] | ((source: SourceInput) => string)
): string {
  const raw = typeof spec === 'function'
    ? spec(source)
    : spec.map(field => {
        if (field.startsWith('metadata.')) {
          const key = field.slice('metadata.'.length)
          return String(source.metadata?.[key] ?? '')
        }
        return String((source as unknown as Record<string, unknown>)[field] ?? '')
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
