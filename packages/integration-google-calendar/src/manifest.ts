import type { IntegrationDefinition } from '@d8um-ai/integration-core'
import { eventsJob } from './jobs/events.js'

export const GoogleCalendarIntegration: IntegrationDefinition = {
  id: 'google-calendar',
  name: 'Google Calendar',
  description: 'Calendar and scheduling',
  author: 'Google',
  category: 'productivity',
  scope: 'individual',
  connectPermission: 'member',

  auth: {
    type: 'oauth2',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  api: {
    baseUrl: 'https://www.googleapis.com',
    type: 'rest',
    endpoints: {
      profile: '/oauth2/v2/userinfo',
      calendarList: '/calendar/v3/users/me/calendarList',
      events: '/calendar/v3/calendars/primary/events',
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
      'View calendar properties',
      'Read calendar events',
    ],
    aboutSummary: 'Read-only access to your Google Calendar events',
  },

  jobs: [eventsJob],
  entities: ['calendars', 'events'],
}
