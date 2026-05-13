import type { Brand } from './identity.js'
import type { AgentId, GroupId, OrganizationId, ThreadId, UserId } from './identity.js'
import type { OntologyConfig } from './ontology.js'

export type GraphId = Brand<string, 'GraphId'>

export const GraphId = (id: string): GraphId => id as GraphId

export interface GraphAccessPrincipals {
  organizations?: OrganizationId[] | string[] | undefined
  groups?: GroupId[] | string[] | undefined
  users?: UserId[] | string[] | undefined
  agents?: AgentId[] | string[] | undefined
  threads?: ThreadId[] | string[] | undefined
}

export interface GraphAccessConfig {
  read?: GraphAccessPrincipals | undefined
  write?: GraphAccessPrincipals | undefined
}

export interface GraphConfig {
  name?: string | undefined
  description?: string | undefined
  extends?: string[] | undefined
  access?: 'public' | GraphAccessConfig | undefined
  ontology?: OntologyConfig | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface TypeGraphGraphRecord extends GraphConfig {
  id: string
  tenantId: string
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
}
