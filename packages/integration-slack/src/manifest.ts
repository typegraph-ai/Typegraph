import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { channelsJob } from './jobs/channels.js'
import { messagesJob } from './jobs/messages.js'

export const SlackIntegration: IntegrationDefinition = {
  id: 'slack',
  name: 'Slack',
  description: 'Communication and collaboration platform',
  author: 'Slack',
  category: 'communication',
  scope: 'workspace',
  connectPermission: 'admin',

  auth: {
    type: 'oauth2',
    scopes: [
      'app_mentions:read',
      'channels:history',
      'channels:read',
      'chat:write',
      'chat:write.public',
      'commands',
      'groups:history',
      'groups:read',
      'im:history',
      'im:write',
      'mpim:read',
      'reactions:write',
      'users:read',
    ],
  },

  api: {
    baseUrl: 'https://slack.com/api',
    type: 'rest',
    endpoints: {
      authTest: 'auth.test',
      conversationsList: 'conversations.list',
      conversationsHistory: 'conversations.history',
      conversationsReplies: 'conversations.replies',
      usersList: 'users.list',
      usersInfo: 'users.info',
      chatPostMessage: 'chat.postMessage',
      teamInfo: 'team.info',
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
      'Read & send messages',
      'Access user & team info',
      'Read direct messages',
    ],
    aboutSummary: 'Team communication and collaboration',
  },

  jobs: [channelsJob, messagesJob],
  entities: ['channels', 'messages', 'users'],
}
