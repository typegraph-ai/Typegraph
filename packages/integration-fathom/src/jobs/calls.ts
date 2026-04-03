import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches calls (meetings) from Fathom incrementally.
 *
 * High-level flow:
 * 1. Check ctx.state.lastCursor for incremental cursor
 * 2. Call GET /meetings with cursor-based pagination
 * 3. For each meeting with recording_available, optionally fetch:
 *    - GET /recordings/{recording_id}/summary for summary + action items
 *    - GET /recordings/{recording_id}/transcript for full transcript
 * 4. Transform each call into a RawDocument via toFathomCall mapper
 * 5. Include transcript content in the document body for search indexing
 * 6. Yield each document
 * 7. Update ctx.state.lastCursor with the pagination cursor
 */
export const callsJob: JobTypeDefinition = {
  type: 'fathom_calls',
  label: 'Fathom: Calls',
  description: 'Fetches call recordings and transcripts from Fathom',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'FathomCall',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['public_api'],
  configSchema: [
    {
      key: 'include_transcripts',
      label: 'Include Full Transcripts',
      type: 'boolean',
      required: false,
    },
    {
      key: 'include_summaries',
      label: 'Include Call Summaries',
      type: 'boolean',
      required: false,
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Get the incremental cursor from previous run
    // const cursor = ctx.state?.lastCursor as string | undefined
    //
    // 2. Loop through pages of meetings
    // let hasMore = true
    // let nextCursor = cursor
    // while (hasMore) {
    //   const response = await ctx.client!.get<FathomMeetingsListResponse>(
    //     '/meetings',
    //     {
    //       ...(nextCursor ? { cursor: nextCursor } : {}),
    //       limit: '50',
    //     }
    //   )
    //
    //   for (const meeting of response.data.meetings) {
    //     // 3. Optionally fetch summary and transcript
    //     let summary: FathomRecordingSummaryResponse | undefined
    //     let transcript: FathomRecordingTranscriptResponse | undefined
    //
    //     if (meeting.recording_available) {
    //       summary = (await ctx.client!.get<FathomRecordingSummaryResponse>(
    //         `/recordings/${meeting.id}/summary`
    //       )).data
    //
    //       if (ctx.job.config.include_transcripts !== false) {
    //         transcript = (await ctx.client!.get<FathomRecordingTranscriptResponse>(
    //           `/recordings/${meeting.id}/transcript`
    //         )).data
    //       }
    //     }
    //
    //     // 4. Map and yield
    //     const mapped = toFathomCall(meeting, summary)
    //     const transcriptContent = transcript
    //       ? toFathomTranscript(meeting.id, transcript).content
    //       : undefined
    //
    //     yield {
    //       id: `fathom-call-${meeting.id}`,
    //       content: [mapped.summary, transcriptContent].filter(Boolean).join('\n\n'),
    //       title: mapped.title || `Call ${meeting.id}`,
    //       updatedAt: new Date(meeting.updated_at),
    //       metadata: mapped,
    //     }
    //   }
    //
    //   hasMore = response.data.has_more
    //   nextCursor = response.data.next_cursor
    // }
    //
    // 5. Update the cursor for next incremental run
    // if (nextCursor) ctx.state.lastCursor = nextCursor

    throw new Error('FathomIntegration calls job is not yet implemented')

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
