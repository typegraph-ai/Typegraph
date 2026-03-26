# @d8um/integration-google-calendar

Google Calendar integration for d8um — sync calendars and events into your sources.

## Install

```bash
npm install @d8um/integration-google-calendar
```

## Register

```ts
import { registerJobType } from '@d8um/core'
import { GoogleCalendarIntegration } from '@d8um/integration-google-calendar'

for (const job of GoogleCalendarIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- calendars
- events

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `google_calendar_events` | Fetches events from Google Calendar | incremental |

## Actions

| Function | Description |
| --- | --- |
| `listEvents(client, input)` | List calendar events |

## Models

Zod schemas: `GoogleCalendarSchema`, `GoogleCalendarEventSchema`, `GoogleCalendarDateTimeSchema`, `GoogleCalendarAttendeeSchema`

## Related

- [d8um](../../README.md)
