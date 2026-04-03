import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches deals from a HubSpot CRM workspace incrementally.
 *
 * High-level flow:
 * 1. Check ctx.state.lastSyncedAt for incremental cursor
 * 2. Call GET /crm/v3/objects/deals/search with filter on lastmodifieddate > lastSyncedAt
 *    - For first run (no cursor), fall back to GET /crm/v3/objects/deals with pagination
 * 3. Request properties: dealname, amount, dealstage, pipeline, closedate, hubspot_owner_id
 * 4. Optionally resolve owner names via GET /crm/v3/owners/{ownerId}
 * 5. Transform each deal into a RawDocument via toHubSpotDeal mapper
 * 6. Yield each document
 * 7. Update ctx.state.lastSyncedAt with current timestamp
 */
export const dealsJob: JobTypeDefinition = {
  type: 'hubspot_deals',
  label: 'HubSpot: Deals',
  description: 'Fetches deals from HubSpot CRM incrementally',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'HubSpotDeal',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['crm.objects.deals.read'],
  configSchema: [
    {
      key: 'pipeline',
      label: 'Filter by Pipeline',
      type: 'text',
      required: false,
    },
    {
      key: 'include_archived',
      label: 'Include Archived Deals',
      type: 'boolean',
      required: false,
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Get the incremental cursor from previous run
    // const lastSyncedAt = ctx.state?.lastSyncedAt as string | undefined
    //
    // 2. Build search filter for incremental sync
    // const filters = lastSyncedAt
    //   ? [{
    //       propertyName: 'lastmodifieddate',
    //       operator: 'GTE',
    //       value: lastSyncedAt,
    //     }]
    //   : []
    //
    // 3. Define properties to fetch
    // const properties = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hubspot_owner_id']
    //
    // 4. Use search API for incremental, list API for full
    // let after: string | undefined
    // do {
    //   const response = lastSyncedAt
    //     ? await ctx.client!.post<HubSpotDealsListResponse>(
    //         '/crm/v3/objects/deals/search',
    //         {
    //           filterGroups: [{ filters }],
    //           properties,
    //           limit: 100,
    //           ...(after ? { after } : {}),
    //         }
    //       )
    //     : await ctx.client!.get<HubSpotDealsListResponse>(
    //         '/crm/v3/objects/deals',
    //         {
    //           limit: '100',
    //           properties: properties.join(','),
    //           ...(after ? { after } : {}),
    //         }
    //       )
    //
    //   for (const deal of response.data.results) {
    //     const mapped = toHubSpotDeal(deal)
    //     yield {
    //       id: `hubspot-deal-${deal.id}`,
    //       content: [mapped.dealName, mapped.stage, mapped.amount?.toString()].filter(Boolean).join(' '),
    //       title: mapped.dealName || deal.id,
    //       updatedAt: new Date(deal.updatedAt),
    //       metadata: mapped,
    //     }
    //   }
    //
    //   after = response.data.paging?.next?.after
    // } while (after)
    //
    // 5. Update the cursor for next incremental run
    // ctx.state.lastSyncedAt = new Date().toISOString()

    throw new Error('HubSpotIntegration deals job is not yet implemented')

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
