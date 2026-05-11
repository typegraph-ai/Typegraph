import type { AccessScope, TypeGraphContext, typegraphIdentity } from '../types/identity.js'
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
    organizationId: identity.organizationId,
    groupId: identity.groupId,
    userId: identity.userId,
    agentId: identity.agentId,
    threadId: identity.threadId,
    graphId: identity.graphId,
    entities: identity.entities,
    agentName: identity.agentName,
    agentDescription: identity.agentDescription,
    agentVersion: identity.agentVersion,
  })
}

const OLD_PUBLIC_CONTEXT_KEYS = [
  'tenantId',
  'organizationId',
  'groupId',
  'userId',
  'agentId',
  'threadId',
  'entities',
  'identity',
  'accessScope',
  'traceId',
  'spanId',
] as const

export function assertNoLegacyPublicContextKeys(value: object, method: string): void {
  const input = value as Record<string, unknown>
  for (const key of OLD_PUBLIC_CONTEXT_KEYS) {
    if (input[key] !== undefined) {
      throw new ConfigError(`${method} uses opts.context. Remove legacy top-level "${key}".`)
    }
  }
}

export function compactTypeGraphContext(context: Nullable<TypeGraphContext>, method: string): TypeGraphContext {
  if (context == null) return {}
  const value = optionalObject<TypeGraphContext>(context, method, 'context')
  if ((value as Record<string, unknown>).access !== undefined) {
    throw new ConfigError(`${method} context.access was removed. Configure graph access on typegraphInit({ graphs }) instead.`)
  }
  if ((value as Record<string, unknown>).principals !== undefined) {
    throw new ConfigError(`${method} context.principals was removed. Use organizationId/groupId/userId/agentId/threadId and graph access config instead.`)
  }
  return compactObject({
    organizationId: value.organizationId,
    groupId: value.groupId,
    userId: value.userId,
    agentId: value.agentId,
    threadId: value.threadId,
    agentName: value.agentName,
    agentDescription: value.agentDescription,
    agentVersion: value.agentVersion,
    traceId: value.traceId,
    spanId: value.spanId,
  }) as TypeGraphContext
}

export function contextToIdentity(context: TypeGraphContext | null | undefined, tenantId?: string): typegraphIdentity {
  const normalized = compactTypeGraphContext(context, 'context')
  return compactObject({
    tenantId,
    organizationId: normalized.organizationId,
    groupId: normalized.groupId,
    userId: normalized.userId,
    agentId: normalized.agentId,
    threadId: normalized.threadId,
    agentName: normalized.agentName,
    agentDescription: normalized.agentDescription,
    agentVersion: normalized.agentVersion,
  })
}

export function contextAccess(context: TypeGraphContext | null | undefined): AccessScope | undefined {
  void context
  return undefined
}

export function contextTelemetry(context: TypeGraphContext | null | undefined): { traceId?: string | undefined; spanId?: string | undefined } {
  const normalized = compactTypeGraphContext(context, 'context')
  return compactObject({
    traceId: normalized.traceId,
    spanId: normalized.spanId,
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
