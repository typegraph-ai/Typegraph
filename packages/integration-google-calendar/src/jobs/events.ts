import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches events from Google Calendar.
 *
 * High-level flow:
 * 1. Fetch list of calendars via calendarList.list
 * 2. For each calendar, paginate through events.list
 * 3. If incremental, use updatedMin param set to ctx.lastRunAt
 * 4. Transform each event into a RawDocument via toEventDocument mapper
 * 5. Yield each document
 */
export const eventsJob: JobTypeDefinition = {
  type: 'google_calendar_events',
  label: 'Google Calendar: Events',
  description: 'Fetches events from Google Calendar',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'GoogleCalendarEvent',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ],
  configSchema: [
    {
      key: 'calendar_ids',
      label: 'Calendar IDs',
      type: 'text',
      required: false,
      placeholder: 'primary,team@group.calendar.google.com (comma-separated, empty = all)',
    },
    {
      key: 'time_min_days',
      label: 'Days Back to Fetch',
      type: 'number',
      required: false,
      placeholder: '30',
    },
    {
      key: 'include_recurring',
      label: 'Expand Recurring Events',
      type: 'boolean',
      required: false,
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Determine calendar list
    //    - If ctx.job.config.calendar_ids provided, use those
    //    - Otherwise, fetch all calendars via calendarList.list
    //
    // const calendarIds = ctx.job.config.calendar_ids
    //   ? (ctx.job.config.calendar_ids as string).split(',').map(s => s.trim())
    //   : await fetchAllCalendarIds(ctx)
    //
    // 2. Compute time boundaries
    //    const updatedMin = ctx.lastRunAt
    //      ? ctx.lastRunAt.toISOString()
    //      : undefined
    //    const timeMinDays = (ctx.job.config.time_min_days as number) ?? 30
    //    const timeMin = new Date(Date.now() - timeMinDays * 24 * 60 * 60 * 1000).toISOString()
    //
    // 3. For each calendar:
    //    let pageToken: string | undefined
    //
    //    do {
    //      const response = await ctx.client!.get<GoogleCalendarEventsListResponse>(
    //        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    //        {
    //          maxResults: '250',
    //          singleEvents: ctx.job.config.include_recurring ? 'true' : 'false',
    //          orderBy: ctx.job.config.include_recurring ? 'startTime' : 'updated',
    //          timeMin,
    //          ...(updatedMin ? { updatedMin } : {}),
    //          ...(pageToken ? { pageToken } : {}),
    //        }
    //      )
    //
    //      for (const event of response.data.items) {
    //        if (event.status === 'cancelled') continue
    //        yield toEventDocument(event, calendarId, response.data.summary)
    //      }
    //
    //      pageToken = response.data.nextPageToken
    //    } while (pageToken)

    throw new Error('GoogleCalendarIntegration events job is not yet implemented')

    return {
      jobId: ctx.job.id,
      bucketId: ctx.job.bucketId,
      status: 'completed',
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      durationMs: 0,
    }
  },
}
