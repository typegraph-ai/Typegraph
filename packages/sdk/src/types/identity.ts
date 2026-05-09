export interface EntityRef {
  type: string
  id: string
}

export type AccessScope = EntityRef[]

declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type TenantId = Brand<string, 'TenantId'>
export type GroupId = Brand<string, 'GroupId'>
export type UserId = Brand<string, 'UserId'>
export type AgentId = Brand<string, 'AgentId'>
export type ThreadId = Brand<string, 'ThreadId'>
export type EntityId = Brand<string, 'EntityId'>

export const TenantId = (id: string): TenantId => id as TenantId
export const GroupId = (id: string): GroupId => id as GroupId
export const UserId = (id: string): UserId => id as UserId
export const AgentId = (id: string): AgentId => id as AgentId
export const ThreadId = (id: string): ThreadId => id as ThreadId
export const EntityId = (id: string): EntityId => id as EntityId
export const entityRef = (type: string, id: string): EntityRef => ({ type, id })

/**
 * Public request context for TypeGraph operations.
 *
 * `tenantId` is the hard outer namespace boundary. `principals` are additional
 * caller principals used for read access checks. `access` is the write-side
 * access list for records created or updated by the operation.
 */
export interface TypeGraphContext {
  groupId?: GroupId | string | undefined
  userId?: UserId | string | undefined
  agentId?: AgentId | string | undefined
  threadId?: ThreadId | string | undefined
  principals?: EntityRef[] | undefined
  access?: EntityRef[] | undefined
  /** Human-readable agent name. Maps to gen_ai.agent.name in OpenTelemetry. */
  agentName?: string | undefined
  /** Agent description. Maps to gen_ai.agent.description in OpenTelemetry. */
  agentDescription?: string | undefined
  /** Agent version string. Maps to gen_ai.agent.version in OpenTelemetry. */
  agentVersion?: string | undefined
  /** OpenTelemetry trace ID for distributed tracing correlation. */
  traceId?: string | undefined
  /** OpenTelemetry span ID for distributed tracing correlation. */
  spanId?: string | undefined
}

export interface TypeGraphOptions {
  context?: TypeGraphContext | undefined
  abortSignal?: AbortSignal | undefined
}

export interface TypeGraphWriteOptions extends TypeGraphOptions {
  bucketId?: string | undefined
  graphExtraction?: boolean | undefined
  idempotencyKey?: string | undefined
}

/**
 * Internal identity shape used by lower-level bridges. The public request
 * identity requires `tenantId`; internals allow it to be defaulted by the
 * TypeGraph instance before execution.
 */
export interface typegraphIdentity {
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  entities?: EntityRef[] | undefined
  agentName?: string | undefined
  agentDescription?: string | undefined
  agentVersion?: string | undefined
}

export function entityRefKey(ref: EntityRef): string {
  return `${ref.type}:${ref.id}`
}

export function accessScopeKeys(accessScope?: AccessScope | null): string[] {
  if (!accessScope || accessScope.length === 0) return []
  return [...new Set(accessScope.map(entityRefKey))]
}

export function identityAccessScope(identity?: typegraphIdentity | null): AccessScope {
  const refs: EntityRef[] = []
  if (!identity) return refs
  if (identity.groupId) refs.push({ type: 'group', id: identity.groupId })
  if (identity.userId) refs.push({ type: 'user', id: identity.userId })
  if (identity.agentId) refs.push({ type: 'agent', id: identity.agentId })
  if (identity.threadId) refs.push({ type: 'thread', id: identity.threadId })
  if (identity.entities) refs.push(...identity.entities)
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = entityRefKey(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
