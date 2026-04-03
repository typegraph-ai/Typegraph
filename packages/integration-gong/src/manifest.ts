import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { callsJob } from './jobs/calls.js'
import { transcriptsJob } from './jobs/transcripts.js'
import { usersJob } from './jobs/users.js'

export const GongIntegration: IntegrationDefinition = {
  id: 'gong',
  name: 'Gong',
  description: 'Revenue intelligence platform',
  author: 'Gong.io',
  category: 'sales',
  scope: 'workspace',
  connectPermission: 'admin',

  auth: {
    type: 'oauth2',
    scopes: [
      'api:calls:read:basic',
      'api:calls:read:media-url',
      'api:calls:read:extensive',
      'api:calls:read:transcript',
      'api:users:read',
    ],
  },

  api: {
    baseUrl: 'https://api.gong.io',
    type: 'rest',
    endpoints: {
      callsExtensive: '/v2/calls/extensive',
      callsTranscript: '/v2/calls/transcript',
      users: '/v2/users',
    },
  },

  features: {
    jobs: true,
    webhooks: true,
    incrementalJobs: true,
  },

  display: {
    logo: 'logo.png',
    permissionsSummary: [
      'Access call recordings',
      'Read call transcripts',
      'View user info',
    ],
    aboutSummary: 'Revenue intelligence and call analytics',
  },

  jobs: [callsJob, transcriptsJob, usersJob],
  entities: ['calls', 'transcripts', 'users'],
}
