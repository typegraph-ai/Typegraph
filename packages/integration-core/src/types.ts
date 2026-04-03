import type { JobTypeDefinition } from '@d8um-ai/core'

// ── Integration Manifest ──

/**
 * Complete definition of a 3rd party integration.
 * Each integration package exports one of these as its primary export.
 */
export interface IntegrationDefinition {
  /** Unique identifier, e.g. 'slack', 'hubspot' */
  id: string
  /** Human-readable name */
  name: string
  description: string
  author: string
  category: IntegrationCategory

  /** Whether this integration connects at the workspace or individual level */
  scope: 'workspace' | 'individual'
  /** Who can initiate a connection */
  connectPermission: 'admin' | 'member'

  /**
   * Auth requirements - describes WHAT is needed, not HOW to do it.
   * The consuming app provides the auth implementation (e.g. via OAuth proxy, API keys, etc.)
   */
  auth: {
    type: 'oauth2' | 'api_key' | 'oauth2_cc'
    scopes: string[]
    tokenType?: 'bearer' | 'basic' | undefined
  }

  /** API surface description */
  api: {
    baseUrl: string
    type: 'rest' | 'graphql'
    endpoints: Record<string, string>
  }

  /** What this integration supports */
  features: {
    jobs: boolean
    webhooks: boolean
    incrementalJobs: boolean
  }

  /** Display metadata for UI */
  display: {
    /** Logo filename co-located in the package root (e.g. 'logo.png') */
    logo: string
    permissionsSummary: string[]
    aboutSummary: string
  }

  /** Job definitions - uses core's JobTypeDefinition directly */
  jobs: JobTypeDefinition[]
  /** Entity names this integration provides (e.g. ['messages', 'channels', 'users']) */
  entities: string[]
}

export type IntegrationCategory =
  | 'crm'
  | 'communication'
  | 'productivity'
  | 'sales'
  | 'storage'
  | 'finance'
