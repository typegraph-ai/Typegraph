import type { typegraphIdentity } from './identity.js'

// ── Policy Types ──

export type PolicyType = 'access' | 'retention' | 'data_flow'

export type PolicyAction =
  | 'query'
  | 'index'
  | 'memory.write'
  | 'memory.read'
  | 'memory.delete'
  | 'document.delete'
  | 'bucket.delete'

export interface PolicyRule {
  /** What SDK action this rule applies to. */
  action: PolicyAction
  /** Whether the action is allowed or denied. */
  effect: 'allow' | 'deny'
  /** Optional conditions — identity field matchers, bucket patterns, etc. */
  conditions?: Record<string, unknown>
}

export interface Policy {
  id: string
  name: string
  policyType: PolicyType
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  rules: PolicyRule[]
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreatePolicyInput {
  name: string
  policyType: PolicyType
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  rules: PolicyRule[]
  enabled?: boolean | undefined
}

export interface UpdatePolicyInput {
  name?: string | undefined
  rules?: PolicyRule[] | undefined
  enabled?: boolean | undefined
}

export interface PolicyEvalContext {
  action: PolicyAction
  identity: typegraphIdentity
  targetId?: string | undefined
  targetType?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface PolicyDecision {
  allowed: boolean
  violations: PolicyViolation[]
}

export interface PolicyViolation {
  policyId: string
  policyName: string
  rule: PolicyRule
}

/**
 * Adapter for policy storage. Implementations can use Postgres, in-memory, etc.
 */
export interface PolicyStoreAdapter {
  createPolicy(input: CreatePolicyInput): Promise<Policy>
  getPolicy(id: string): Promise<Policy | null>
  listPolicies(filter?: { tenantId?: string; policyType?: PolicyType; enabled?: boolean }): Promise<Policy[]>
  updatePolicy(id: string, input: UpdatePolicyInput): Promise<Policy>
  deletePolicy(id: string): Promise<void>
}
