import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches contacts (people) from an Attio workspace.
 *
 * High-level flow:
 * 1. POST to objects/people/records/query with pagination token
 * 2. Each page returns an array of record objects with nested attribute values
 * 3. Extract name, email, phone, company from the values map
 * 4. Transform each record into a RawDocument via toAttioContact mapper
 * 5. Yield each document
 * 6. Continue until no next_page_token is returned
 */
export const contactsJob: JobTypeDefinition = {
  type: 'attio_contacts',
  label: 'Attio: Contacts',
  description: 'Fetches contacts from Attio workspace',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'AttioContact',
  schedule: 'daily',
  syncMode: 'full',
  scopes: ['records:read', 'objects:read'],
  configSchema: [
    {
      key: 'page_size',
      label: 'Page Size',
      type: 'number',
      required: false,
      placeholder: '100',
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Initialize pagination token
    // let pageToken: string | undefined
    //
    // 2. Loop through pages of people records
    // do {
    //   const response = await ctx.client!.post<AttioListRecordsResponse>(
    //     'objects/people/records/query',
    //     {
    //       page_size: ctx.job.config.page_size ?? 100,
    //       ...(pageToken ? { page_token: pageToken } : {}),
    //     }
    //   )
    //
    //   for (const record of response.data.data) {
    //     const contact = toAttioContact(record)
    //     yield {
    //       id: `attio-contact-${record.id.record_id}`,
    //       content: [contact.name, contact.title, contact.company].filter(Boolean).join(' - '),
    //       title: contact.name,
    //       updatedAt: new Date(record.created_at),
    //       metadata: contact,
    //     }
    //   }
    //
    //   pageToken = response.data.next_page_token
    // } while (pageToken)

    throw new Error('AttioIntegration contacts job is not yet implemented')

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
