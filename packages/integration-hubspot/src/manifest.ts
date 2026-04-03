import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { contactsJob } from './jobs/contacts.js'
import { companiesJob } from './jobs/companies.js'
import { dealsJob } from './jobs/deals.js'

export const HubSpotIntegration: IntegrationDefinition = {
  id: 'hubspot',
  name: 'HubSpot',
  description: 'CRM and marketing automation',
  author: 'HubSpot',
  category: 'crm',
  scope: 'workspace',
  connectPermission: 'admin',

  auth: {
    type: 'oauth2',
    scopes: [
      'crm.objects.owners.read',
      'crm.objects.deals.read',
      'crm.objects.companies.read',
      'crm.objects.contacts.read',
      'oauth',
    ],
  },

  api: {
    baseUrl: 'https://api.hubapi.com',
    type: 'rest',
    endpoints: {
      contacts: '/crm/v3/objects/contacts',
      companies: '/crm/v3/objects/companies',
      deals: '/crm/v3/objects/deals',
      owners: '/crm/v3/owners',
      accessToken: '/oauth/v1/access-tokens/@token',
    },
  },

  features: {
    jobs: true,
    webhooks: true,
    incrementalJobs: true,
  },

  display: {
    logo: 'logo.webp',
    permissionsSummary: [
      'Read contacts & companies',
      'Read deals & pipelines',
      'Access owner info',
    ],
    aboutSummary: 'Read-only CRM data access',
  },

  jobs: [contactsJob, companiesJob, dealsJob],
  entities: ['contacts', 'companies', 'deals'],
}
