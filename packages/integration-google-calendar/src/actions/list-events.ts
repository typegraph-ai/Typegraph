import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'
import { GoogleCalendarEventSchema } from '../models.js'

export const ListEventsInput = z.object({
  calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
  timeMin: z.string().optional().describe('Start of time range (ISO 8601)'),
  timeMax: z.string().optional().describe('End of time range (ISO 8601)'),
  maxResults: z.number().optional().describe('Max events to return'),
  query: z.string().optional().describe('Free text search terms'),
})

export const ListEventsOutput = z.object({
  events: z.array(GoogleCalendarEventSchema),
  total: z.number(),
})

export async function listEvents(
  client: ApiClient,
  input: z.infer<typeof ListEventsInput>,
): Promise<z.infer<typeof ListEventsOutput>> {
  // const calendarId = input.calendarId ?? 'primary'
  // const events: GoogleCalendarEvent[] = []
  // let pageToken: string | undefined
  //
  // do {
  //   const response = await client.get<GoogleCalendarEventsListResponse>(
  //     `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  //     {
  //       maxResults: String(input.maxResults ?? 250),
  //       singleEvents: 'true',
  //       orderBy: 'startTime',
  //       ...(input.timeMin ? { timeMin: input.timeMin } : {}),
  //       ...(input.timeMax ? { timeMax: input.timeMax } : {}),
  //       ...(input.query ? { q: input.query } : {}),
  //       ...(pageToken ? { pageToken } : {}),
  //     }
  //   )
  //
  //   for (const event of response.data.items) {
  //     if (event.status === 'cancelled') continue
  //     events.push(toGoogleCalendarEvent(event))
  //     if (input.maxResults && events.length >= input.maxResults) break
  //   }
  //
  //   pageToken = response.data.nextPageToken
  // } while (pageToken && (!input.maxResults || events.length < input.maxResults))
  //
  // return { events, total: events.length }

  throw new Error('GoogleCalendarIntegration listEvents is not yet implemented')
}
