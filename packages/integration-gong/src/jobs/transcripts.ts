import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches call transcripts from a Gong workspace incrementally.
 *
 * High-level flow:
 * 1. Check ctx.state.lastTranscriptSyncedAt for incremental cursor
 * 2. First fetch recent call IDs via POST /v2/calls/extensive with fromDateTime
 * 3. For each batch of call IDs, call POST /v2/calls/transcript
 *    - Gong requires call IDs to be passed in the request body
 * 4. Handle cursor-based pagination via records.cursor
 * 5. Transform each transcript into a RawDocument via toGongTranscript mapper
 * 6. Flatten transcript segments into searchable content
 * 7. Yield each document
 * 8. Update ctx.state.lastTranscriptSyncedAt with current timestamp
 */
export const transcriptsJob: JobTypeDefinition = {
  type: 'gong_transcripts',
  label: 'Gong: Transcripts',
  description: 'Fetches call transcripts from Gong',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'GongCallTranscript',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['api:calls:read:transcript'],
  configSchema: [
    {
      key: 'lookback_days',
      label: 'Initial Lookback (days)',
      type: 'number',
      required: false,
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Get the incremental cursor
    // const lastSyncedAt = ctx.state?.lastTranscriptSyncedAt as string | undefined
    // const lookbackDays = ctx.job.config.lookback_days ?? 90
    // const fromDateTime = lastSyncedAt
    //   ?? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
    //
    // 2. Fetch recent call IDs
    // const callsResponse = await ctx.client!.post<GongCallsListResponse>(
    //   '/v2/calls/extensive',
    //   { filter: { fromDateTime, toDateTime: new Date().toISOString() } }
    // )
    // const callIds = callsResponse.data.calls.map(c => c.id)
    //
    // 3. Fetch transcripts in batches
    // const batchSize = 20
    // for (let i = 0; i < callIds.length; i += batchSize) {
    //   const batch = callIds.slice(i, i + batchSize)
    //   let cursor: string | undefined
    //   do {
    //     const response = await ctx.client!.post<GongCallTranscriptResponse>(
    //       '/v2/calls/transcript',
    //       {
    //         filter: { callIds: batch },
    //         ...(cursor ? { cursor } : {}),
    //       }
    //     )
    //
    //     for (const rawTranscript of response.data.callTranscripts) {
    //       const mapped = toGongTranscript(rawTranscript)
    //       const content = rawTranscript.transcript
    //         .flatMap(seg => seg.sentences.map(s => `[${seg.speakerId}]: ${s.text}`))
    //         .join('\n')
    //
    //       yield {
    //         id: `gong-transcript-${rawTranscript.callId}`,
    //         content,
    //         title: `Transcript for call ${rawTranscript.callId}`,
    //         updatedAt: new Date(),
    //         metadata: mapped,
    //       }
    //     }
    //
    //     cursor = response.data.records.cursor
    //   } while (cursor)
    // }
    //
    // 4. Update the cursor
    // ctx.state.lastTranscriptSyncedAt = new Date().toISOString()

    throw new Error('GongIntegration transcripts job is not yet implemented')

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
