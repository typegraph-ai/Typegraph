import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches accounts from a Salesforce instance using SOQL.
 *
 * High-level flow:
 * 1. Build a SOQL SELECT query for Account fields
 * 2. Execute the query against the /services/data/v59.0/query endpoint
 * 3. Parse the query response which contains a records array
 * 4. Transform each record into a RawDocument via toSalesforceAccount mapper
 * 5. Yield each document
 * 6. If response.done is false, follow nextRecordsUrl for more pages
 */
export const accountsJob: JobTypeDefinition = {
  type: 'salesforce_accounts',
  label: 'Salesforce: Accounts',
  description: 'Fetches accounts from Salesforce',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'SalesforceAccount',
  schedule: 'daily',
  syncMode: 'full',
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
      key: 'account_types',
      label: 'Account Types',
      type: 'text',
      required: false,
      placeholder: "e.g. Customer,Partner (comma-separated, empty = all)",
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Build SOQL query
    // const fields = [
    //   'Id', 'Name', 'Type', 'Industry', 'Website', 'Phone',
    //   'BillingStreet', 'BillingCity', 'BillingState', 'BillingPostalCode',
    //   'BillingCountry', 'NumberOfEmployees', 'AnnualRevenue', 'OwnerId',
    //   'CreatedDate', 'LastModifiedDate'
    // ].join(', ')
    //
    // let soql = `SELECT ${fields} FROM Account`
    // const conditions: string[] = []
    // if (ctx.job.config.account_types) {
    //   const types = (ctx.job.config.account_types as string).split(',').map(t => `'${t.trim()}'`).join(',')
    //   conditions.push(`Type IN (${types})`)
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
    //   const response = await ctx.client!.get<SalesforceQueryResponse<SalesforceRawAccount>>(
    //     queryUrl
    //   )
    //
    //   for (const record of response.data.records) {
    //     const account = toSalesforceAccount(record)
    //     yield {
    //       id: `salesforce-account-${record.Id}`,
    //       content: [account.name, account.industry, account.type].filter(Boolean).join(' - '),
    //       title: account.name,
    //       updatedAt: new Date(record.LastModifiedDate),
    //       metadata: account,
    //     }
    //   }
    //
    //   if (!response.data.done && response.data.nextRecordsUrl) {
    //     queryUrl = response.data.nextRecordsUrl
    //   } else {
    //     break
    //   }
    // } while (true)

    throw new Error('SalesforceIntegration accounts job is not yet implemented')

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
