import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { contactsJob } from './jobs/contacts.js'
import { accountsJob } from './jobs/accounts.js'
import { opportunitiesJob } from './jobs/opportunities.js'

export const SalesforceIntegration: IntegrationDefinition = {
  id: 'salesforce',
  name: 'Salesforce',
  description: 'CRM and sales automation',
  author: 'Salesforce',
  category: 'crm',
  scope: 'workspace',
  connectPermission: 'admin',

  auth: {
    type: 'oauth2',
    scopes: [
      'api',
      'refresh_token',
      'offline_access',
    ],
  },

  api: {
    baseUrl: 'https://login.salesforce.com',
    type: 'rest',
    endpoints: {
      authorize: '/services/oauth2/authorize',
      token: '/services/oauth2/token',
      userinfo: '/services/oauth2/userinfo',
      query: '/services/data/v59.0/query',
      sobjects: '/services/data/v59.0/sobjects',
      contacts: '/services/data/v59.0/sobjects/Contact',
      accounts: '/services/data/v59.0/sobjects/Account',
      opportunities: '/services/data/v59.0/sobjects/Opportunity',
      leads: '/services/data/v59.0/sobjects/Lead',
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
      'Read contacts & accounts',
      'Access deals & pipelines',
      'Query records via SOQL',
    ],
    aboutSummary: 'CRM and sales automation',
  },

  jobs: [contactsJob, accountsJob, opportunitiesJob],
  entities: ['contacts', 'accounts', 'opportunities', 'leads'],
}
