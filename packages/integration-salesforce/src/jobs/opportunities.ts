import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches opportunities from a Salesforce instance using SOQL.
 *
 * High-level flow:
 * 1. Build a SOQL SELECT query for Opportunity fields
 * 2. If incremental, add WHERE LastModifiedDate > lastRunAt
 * 3. Execute the query against the /services/data/v59.0/query endpoint
 * 4. Parse the query response which contains a records array
 * 5. Transform each record into a RawDocument via toSalesforceOpportunity mapper
 * 6. Yield each document
 * 7. If response.done is false, follow nextRecordsUrl for more pages
 */
export const opportunitiesJob: JobTypeDefinition = {
  type: 'salesforce_opportunities',
  label: 'Salesforce: Opportunities',
  description: 'Fetches opportunities from Salesforce',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'SalesforceOpportunity',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['api'],
  configSchema: [
    {
      key: 'max_records',
      label: 'Max Records',
      type: 'number',
      required: false,
      placeholder: '10000',
    },
    {
      key: 'stages',
      label: 'Stage Names',
      type: 'text',
      required: false,
      placeholder: "e.g. Prospecting,Negotiation (comma-separated, empty = all)",
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Build SOQL query
    // const fields = [
    //   'Id', 'Name', 'Amount', 'StageName', 'Probability', 'CloseDate',
    //   'Type', 'AccountId', 'OwnerId', 'Description', 'CreatedDate', 'LastModifiedDate'
    // ].join(', ')
    //
    // let soql = `SELECT ${fields} FROM Opportunity`
    // const conditions: string[] = []
    //
    // // Incremental: only fetch records modified since last run
    // if (ctx.lastRunAt) {
    //   conditions.push(`LastModifiedDate > ${ctx.lastRunAt.toISOString()}`)
    // }
    // if (ctx.job.config.stages) {
    //   const stages = (ctx.job.config.stages as string).split(',').map(s => `'${s.trim()}'`).join(',')
    //   conditions.push(`StageName IN (${stages})`)
    // }
    // if (conditions.length > 0) {
    //   soql += ` WHERE ${conditions.join(' AND ')}`
    // }
    // soql += ' ORDER BY LastModifiedDate DESC'
    // if (ctx.job.config.max_records) {
    //   soql += ` LIMIT ${ctx.job.config.max_records}`
    // }
    //
    // 2. Execute query with pagination
    // let queryUrl = `query?q=${encodeURIComponent(soql)}`
    //
    // do {
    //   const response = await ctx.client!.get<SalesforceQueryResponse<SalesforceRawOpportunity>>(
    //     queryUrl
    //   )
    //
    //   for (const record of response.data.records) {
    //     const opportunity = toSalesforceOpportunity(record)
    //     yield {
    //       id: `salesforce-opportunity-${record.Id}`,
    //       content: [opportunity.name, opportunity.stageName, opportunity.amount?.toString()].filter(Boolean).join(' - '),
    //       title: opportunity.name,
    //       updatedAt: new Date(record.LastModifiedDate),
    //       metadata: opportunity,
    //     }
    //   }
    //
    //   if (!response.data.done && response.data.nextRecordsUrl) {
    //     queryUrl = response.data.nextRecordsUrl
    //   } else {
    //     break
    //   }
    // } while (true)

    throw new Error('SalesforceIntegration opportunities job is not yet implemented')

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
