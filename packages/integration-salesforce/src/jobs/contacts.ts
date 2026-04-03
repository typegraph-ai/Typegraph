import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches contacts from a Salesforce instance using SOQL.
 *
 * High-level flow:
 * 1. Build a SOQL SELECT query for Contact fields
 * 2. Execute the query against the /services/data/v59.0/query endpoint
 * 3. Parse the query response which contains a records array
 * 4. Transform each record into a RawDocument via toSalesforceContact mapper
 * 5. Yield each document
 * 6. If response.done is false, follow nextRecordsUrl for more pages
 */
export const contactsJob: JobTypeDefinition = {
  type: 'salesforce_contacts',
  label: 'Salesforce: Contacts',
  description: 'Fetches contacts from Salesforce',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'SalesforceContact',
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
      key: 'custom_where',
      label: 'Additional WHERE clause',
      type: 'text',
      required: false,
      placeholder: "e.g. Department = 'Sales'",
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Build SOQL query
    // const fields = [
    //   'Id', 'FirstName', 'LastName', 'Email', 'Phone', 'AccountId',
    //   'Title', 'Department', 'MailingStreet', 'MailingCity', 'MailingState',
    //   'MailingPostalCode', 'MailingCountry', 'CreatedDate', 'LastModifiedDate'
    // ].join(', ')
    //
    // let soql = `SELECT ${fields} FROM Contact`
    // if (ctx.job.config.custom_where) {
    //   soql += ` WHERE ${ctx.job.config.custom_where}`
    // }
    // soql += ' ORDER BY LastModifiedDate DESC'
    // if (ctx.job.config.max_records) {
    //   soql += ` LIMIT ${ctx.job.config.max_records}`
    // }
    //
    // 2. Execute query with pagination
    // let queryUrl = `query?q=${encodeURIComponent(soql)}`
    // let recordCount = 0
    //
    // do {
    //   const response = await ctx.client!.get<SalesforceQueryResponse<SalesforceRawContact>>(
    //     queryUrl
    //   )
    //
    //   for (const record of response.data.records) {
    //     const contact = toSalesforceContact(record)
    //     yield {
    //       id: `salesforce-contact-${record.Id}`,
    //       content: [contact.firstName, contact.lastName, contact.title, contact.email].filter(Boolean).join(' - '),
    //       title: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    //       updatedAt: new Date(record.LastModifiedDate),
    //       metadata: contact,
    //     }
    //     recordCount++
    //   }
    //
    //   if (!response.data.done && response.data.nextRecordsUrl) {
    //     queryUrl = response.data.nextRecordsUrl
    //   } else {
    //     break
    //   }
    // } while (true)

    throw new Error('SalesforceIntegration contacts job is not yet implemented')

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
