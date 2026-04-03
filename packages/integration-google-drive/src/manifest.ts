import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { filesJob } from './jobs/files.js'

export const GoogleDriveIntegration: IntegrationDefinition = {
  id: 'google-drive',
  name: 'Google Drive',
  description: 'File storage and sharing',
  author: 'Google',
  category: 'storage',
  scope: 'individual',
  connectPermission: 'member',

  auth: {
    type: 'oauth2',
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  api: {
    baseUrl: 'https://www.googleapis.com',
    type: 'rest',
    endpoints: {
      profile: '/oauth2/v2/userinfo',
      files: '/drive/v3/files',
      about: '/drive/v3/about',
    },
  },

  features: {
    jobs: true,
    webhooks: false,
    incrementalJobs: false,
  },

  display: {
    logo: 'logo.png',
    permissionsSummary: [
      'Read file metadata',
      'Access file contents',
      'List folders and files',
    ],
    aboutSummary: 'File storage and sharing integration for Google Drive',
  },

  jobs: [filesJob],
  entities: ['files', 'folders'],
}
