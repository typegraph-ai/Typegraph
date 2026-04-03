import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { contactsJob } from './jobs/contacts.js'
import { companiesJob } from './jobs/companies.js'
import { tasksJob } from './jobs/tasks.js'

export const AttioIntegration: IntegrationDefinition = {
  id: 'attio',
  name: 'Attio',
  description: 'CRM and relationship workspace',
  author: 'Attio',
  category: 'crm',
  scope: 'workspace',
  connectPermission: 'admin',

  auth: {
    type: 'oauth2',
    scopes: [
      'records:read',
      'records:write',
      'objects:read',
      'objects:write',
      'lists:read',
      'lists:write',
      'comments:read',
      'comments:write',
      'notes:read',
      'notes:write',
      'tasks:read',
      'tasks:write',
      'call_recordings:read',
      'webhooks:read',
      'webhooks:write',
    ],
  },

  api: {
    baseUrl: 'https://api.attio.com/v2',
    type: 'rest',
    endpoints: {
      listRecords: 'objects/{object}/records/query',
      getRecord: 'objects/{object}/records/{record_id}',
      listObjects: 'objects',
      listTasks: 'tasks',
      listNotes: 'notes',
      listLists: 'lists',
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
      'Read contacts & companies',
      'Access tasks & notes',
      'View workspace data',
    ],
    aboutSummary: 'CRM and relationship workspace',
  },

  jobs: [contactsJob, companiesJob, tasksJob],
  entities: ['contacts', 'companies', 'tasks'],
}
