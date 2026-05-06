import type { typegraphIdentity } from '../types/identity.js'
import { ConfigError } from '../types/errors.js'

export type Nullable<T> = T | null | undefined

export function optionalObject<T extends object>(
  value: Nullable<T>,
  method: string,
  param: string = 'opts',
): T {
  if (value == null) return {} as T
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${method} ${param} must be an object when provided.`)
  }
  return value
}

export function requiredObject<T extends object>(
  value: Nullable<T>,
  method: string,
  param: string,
): T {
  if (value == null) {
    throw new ConfigError(`${method} ${param} is required.`)
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${method} ${param} must be an object.`)
  }
  return value
}

export function compactObject<T extends object>(value: T): Partial<T> {
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined && entry !== null) output[key] = entry
  }
  return output as Partial<T>
}

export function optionalCompactObject<T extends object>(
  value: Nullable<T>,
  method: string,
  param: string = 'opts',
): Partial<T> {
  return compactObject(optionalObject(value, method, param))
}

export function compactIdentity(value: Nullable<typegraphIdentity>): typegraphIdentity {
  const identity = optionalObject<typegraphIdentity>(value, 'identity', 'identity')
  return compactObject({
    tenantId: identity.tenantId,
    groupId: identity.groupId,
    userId: identity.userId,
    agentId: identity.agentId,
    conversationId: identity.conversationId,
    agentName: identity.agentName,
    agentDescription: identity.agentDescription,
    agentVersion: identity.agentVersion,
  })
}

export function withDefaultTenant<T extends typegraphIdentity>(
  opts: Nullable<T>,
  tenantId: string | undefined,
  method: string,
): T {
  const normalized = optionalCompactObject<T>(opts, method) as T
  if (normalized.tenantId === undefined && tenantId !== undefined) {
    return { ...normalized, tenantId }
  }
  return normalized
}

export function hasMeaningfulFilter(value: object): boolean {
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (entry == null) continue
    if (Array.isArray(entry) && entry.length === 0) continue
    return true
  }
  return false
}

export function assertHasMeaningfulFilter(value: object, method: string): void {
  if (!hasMeaningfulFilter(value)) {
    throw new ConfigError(`${method} requires at least one filter field.`)
  }
}
