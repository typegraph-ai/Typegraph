import type { RawDocument } from '@d8um-ai/core'
import type { GoogleRawCalendarEvent } from '../types.js'
import type { GoogleCalendarEvent } from '../models.js'

/**
 * Transform a raw Google Calendar API event into a normalized GoogleCalendarEvent.
 */
export function toGoogleCalendarEvent(raw: GoogleRawCalendarEvent): GoogleCalendarEvent {
  return {
    id: raw.id,
    summary: raw.summary,
    description: raw.description,
    location: raw.location,
    start: {
      dateTime: raw.start.dateTime,
      date: raw.start.date,
      timeZone: raw.start.timeZone,
    },
    end: {
      dateTime: raw.end.dateTime,
      date: raw.end.date,
      timeZone: raw.end.timeZone,
    },
    status: raw.status,
    creator: raw.creator ? {
      email: raw.creator.email,
      displayName: raw.creator.displayName,
    } : undefined,
    organizer: raw.organizer ? {
      email: raw.organizer.email,
      displayName: raw.organizer.displayName,
    } : undefined,
    attendees: raw.attendees?.map(a => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      self: a.self,
      organizer: a.organizer,
    })),
    htmlLink: raw.htmlLink,
    recurringEventId: raw.recurringEventId,
    hangoutLink: raw.hangoutLink,
  }
}

/**
 * Transform a raw Google Calendar API event into a RawDocument for indexing.
 */
export function toEventDocument(raw: GoogleRawCalendarEvent, calendarId: string, calendarName: string): RawDocument {
  const startTime = raw.start.dateTime ?? raw.start.date ?? ''
  const endTime = raw.end.dateTime ?? raw.end.date ?? ''
  const attendeeList = raw.attendees?.map(a => a.displayName ?? a.email).join(', ') ?? ''

  const contentParts = [
    raw.summary ?? 'Untitled Event',
    raw.description,
    raw.location ? `Location: ${raw.location}` : undefined,
    attendeeList ? `Attendees: ${attendeeList}` : undefined,
  ].filter(Boolean)

  return {
    id: `gcal-event-${calendarId}-${raw.id}`,
    content: contentParts.join('\n'),
    title: raw.summary ?? 'Untitled Event',
    updatedAt: raw.updated ? new Date(raw.updated) : new Date(),
    metadata: {
      calendarId,
      calendarName,
      startTime,
      endTime,
      status: raw.status ?? 'confirmed',
      isAllDay: !raw.start.dateTime && !!raw.start.date,
      location: raw.location,
      organizerEmail: raw.organizer?.email,
      attendeeCount: raw.attendees?.length ?? 0,
      isRecurring: !!raw.recurringEventId,
      hangoutLink: raw.hangoutLink,
      htmlLink: raw.htmlLink,
    },
  }
}
