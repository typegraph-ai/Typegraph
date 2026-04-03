import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { messagesJob } from './jobs/messages.js'

export const GmailIntegration: IntegrationDefinition = {
  id: 'gmail',
  name: 'Gmail',
  description: 'Email integration for Gmail',
  author: 'Google',
  category: 'communication',
  scope: 'individual',
  connectPermission: 'member',

  auth: {
    type: 'oauth2',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  api: {
    baseUrl: 'https://www.googleapis.com',
    type: 'rest',
    endpoints: {
      profile: '/gmail/v1/users/me/profile',
      messages: '/gmail/v1/users/me/messages',
      threads: '/gmail/v1/users/me/threads',
      labels: '/gmail/v1/users/me/labels',
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
      'Read email messages',
      'Send emails',
      'Manage labels',
    ],
    aboutSummary: 'Email integration for Gmail',
  },

  jobs: [messagesJob],
  entities: ['messages', 'threads', 'labels'],
}
