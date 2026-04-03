import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches calls from a Gong workspace incrementally.
 *
 * High-level flow:
 * 1. Check ctx.state.lastSyncedAt for incremental cursor
 * 2. Call POST /v2/calls/extensive with fromDateTime filter
 *    - For first run (no cursor), use a reasonable lookback (e.g. 90 days)
 * 3. Handle cursor-based pagination via records.cursor
 * 4. Transform each call into a RawDocument via toGongCall mapper
 * 5. Yield each document with party info in content for search indexing
 * 6. Update ctx.state.lastSyncedAt with current timestamp
 */
export const callsJob: JobTypeDefinition = {
  type: 'gong_calls',
  label: 'Gong: Calls',
  description: 'Fetches call recordings from Gong',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'GongCall',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['api:calls:read:basic', 'api:calls:read:media-url'],
  configSchema: [
    {
      key: 'lookback_days',
      label: 'Initial Lookback (days)',
      type: 'number',
      required: false,
    },
    {
      key: 'include_private',
      label: 'Include Private Calls',
      type: 'boolean',
      required: false,
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Get the incremental cursor from previous run
    // const lastSyncedAt = ctx.state?.lastSyncedAt as string | undefined
    // const lookbackDays = ctx.job.config.lookback_days ?? 90
    // const fromDateTime = lastSyncedAt
    //   ?? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
    //
    // 2. Loop through pages of calls
    // let cursor: string | undefined
    // do {
    //   const response = await ctx.client!.post<GongCallsListResponse>(
    //     '/v2/calls/extensive',
    //     {
    //       filter: {
    //         fromDateTime,
    //         toDateTime: new Date().toISOString(),
    //       },
    //       ...(cursor ? { cursor } : {}),
    //     }
    //   )
    //
    //   for (const call of response.data.calls) {
    //     const mapped = toGongCall(call)
    //     const partyNames = mapped.parties?.map(p => p.name).filter(Boolean).join(', ')
    //
    //     yield {
    //       id: `gong-call-${call.id}`,
    //       content: [mapped.title, `Direction: ${mapped.direction}`, partyNames].filter(Boolean).join('\n'),
    //       title: mapped.title || `Gong Call ${call.id}`,
    //       updatedAt: mapped.started ?? new Date(),
    //       metadata: mapped,
    //     }
    //   }
    //
    //   cursor = response.data.records.cursor
    // } while (cursor)
    //
    // 3. Update the cursor for next incremental run
    // ctx.state.lastSyncedAt = new Date().toISOString()

    throw new Error('GongIntegration calls job is not yet implemented')

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
