/**
 * Identity context for all typegraph operations.
 * Every API call can pass identity fields to scope the operation.
 * This replaces the previous `tenantId`-only model with a full identity hierarchy.
 */
export interface typegraphIdentity {
  /** Organization-level isolation. */
  tenantId?: string | undefined
  /** Team, channel, or project shared context. */
  groupId?: string | undefined
  /** Individual user. */
  userId?: string | undefined
  /** Specific agent instance. Maps to gen_ai.agent.id in OpenTelemetry. */
  agentId?: string | undefined
  /** Conversation thread. Maps to gen_ai.conversation.id in OpenTelemetry. */
  conversationId?: string | undefined
  /** Human-readable agent name. Maps to gen_ai.agent.name in OpenTelemetry. */
  agentName?: string | undefined
  /** Agent description. Maps to gen_ai.agent.description in OpenTelemetry. */
  agentDescription?: string | undefined
  /** Agent version string. Maps to gen_ai.agent.version in OpenTelemetry. */
  agentVersion?: string | undefined
}
