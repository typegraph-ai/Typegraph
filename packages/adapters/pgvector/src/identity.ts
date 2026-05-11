import type { EntityRef } from '@typegraph-ai/sdk'

export type StorageAccessScope = EntityRef[]

export interface TypeGraphStorageIdentity {
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
  graphId?: string | undefined
  graphIds?: string[] | undefined
  entities?: EntityRef[] | undefined
  agentName?: string | undefined
  agentDescription?: string | undefined
  agentVersion?: string | undefined
}

export function entityRefKey(ref: EntityRef): string {
  return `${ref.type}:${ref.id}`
}

export function accessScopeKeys(accessScope?: StorageAccessScope | null): string[] {
  if (!accessScope || accessScope.length === 0) return []
  return [...new Set(accessScope.map(entityRefKey))]
}
