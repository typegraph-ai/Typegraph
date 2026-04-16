import type { PolicyStoreAdapter, PolicyEvalContext, PolicyDecision, PolicyRule, Policy } from '../types/policy.js'
import type { typegraphEventSink, typegraphEvent } from '../types/events.js'
import type { typegraphIdentity } from '../types/identity.js'

/**
 * Evaluates policies against SDK actions.
 *
 * Default behavior: all actions are ALLOWED unless a matching deny rule exists.
 * When a deny rule matches, the action is blocked and a `policy.violation` event is emitted.
 */
export class PolicyEngine {
  constructor(
    private store: PolicyStoreAdapter,
    private eventSink?: typegraphEventSink,
  ) {}

  /**
   * Evaluate all applicable policies for the given context.
   * Returns a decision with any violations found.
   */
  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDecision> {
    const policies = await this.loadApplicable(ctx.identity)
    const violations: PolicyDecision['violations'] = []

    for (const policy of policies) {
      for (const rule of policy.rules) {
        if (rule.action !== ctx.action) continue
        if (rule.effect !== 'deny') continue
        if (!this.matchesConditions(rule, ctx)) continue

        violations.push({
          policyId: policy.id,
          policyName: policy.name,
          rule,
        })
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
    }
  }

  /**
   * Evaluate and throw a PolicyViolationError if denied.
   * Emits a `policy.violation` event for each violation.
   */
  async enforce(ctx: PolicyEvalContext): Promise<void> {
    const decision = await this.evaluate(ctx)
    if (decision.allowed) return

    // Emit violation events
    for (const v of decision.violations) {
      this.emitViolation(ctx, v.policyId, v.policyName, v.rule)
    }

    const names = decision.violations.map((v) => v.policyName).join(', ')
    throw new PolicyViolationError(
      `Action '${ctx.action}' denied by policy: ${names}`,
      decision.violations,
    )
  }

  /** Load all enabled policies that apply to this identity scope. */
  private async loadApplicable(identity: typegraphIdentity): Promise<Policy[]> {
    const policies = await this.store.listPolicies({ enabled: true })

    return policies.filter((p) => {
      // A policy applies if its scope fields match or are unset (wildcard)
      if (p.tenantId && p.tenantId !== identity.tenantId) return false
      if (p.groupId && p.groupId !== identity.groupId) return false
      if (p.userId && p.userId !== identity.userId) return false
      if (p.agentId && p.agentId !== identity.agentId) return false
      return true
    })
  }

  /** Check if a rule's conditions match the evaluation context. */
  private matchesConditions(rule: PolicyRule, ctx: PolicyEvalContext): boolean {
    if (!rule.conditions || Object.keys(rule.conditions).length === 0) return true

    // Simple key-value matching against context metadata
    for (const [key, value] of Object.entries(rule.conditions)) {
      const actual = ctx.metadata?.[key]
      if (actual !== value) return false
    }
    return true
  }

  private emitViolation(ctx: PolicyEvalContext, policyId: string, policyName: string, rule: PolicyRule): void {
    if (!this.eventSink) return
    const event: typegraphEvent = {
      id: crypto.randomUUID(),
      eventType: 'policy.violation',
      identity: ctx.identity,
      targetId: ctx.targetId,
      payload: {
        action: ctx.action,
        policyId,
        policyName,
        ruleEffect: rule.effect,
        ruleAction: rule.action,
      },
      timestamp: new Date(),
    }
    this.eventSink.emit(event)
  }
}

/**
 * Error thrown when a policy denies an action.
 */
export class PolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly violations: PolicyDecision['violations'],
  ) {
    super(message)
    this.name = 'PolicyViolationError'
  }
}
