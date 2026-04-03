import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { callsJob } from './jobs/calls.js'

export const FathomIntegration: IntegrationDefinition = {
  id: 'fathom',
  name: 'Fathom',
  description: 'Call intelligence platform',
  author: 'Fathom',
  category: 'sales',
  scope: 'workspace',
  connectPermission: 'admin',

  auth: {
    type: 'oauth2',
    scopes: ['public_api'],
  },

  api: {
    baseUrl: 'https://api.fathom.ai/external/v1',
    type: 'rest',
    endpoints: {
      meetings: '/meetings',
      recordingSummary: '/recordings/{recording_id}/summary',
      recordingTranscript: '/recordings/{recording_id}/transcript',
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
      'Read meeting summaries',
      'View participant info',
    ],
    aboutSummary: 'Import call transcripts from Fathom',
  },

  jobs: [callsJob],
  entities: ['calls', 'transcripts'],
}
