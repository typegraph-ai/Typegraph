import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches companies from an Attio workspace.
 *
 * High-level flow:
 * 1. POST to objects/companies/records/query with pagination token
 * 2. Each page returns an array of record objects with nested attribute values
 * 3. Extract name, domains, industry, size from the values map
 * 4. Transform each record into a RawDocument via toAttioCompany mapper
 * 5. Yield each document
 * 6. Continue until no next_page_token is returned
 */
export const companiesJob: JobTypeDefinition = {
  type: 'attio_companies',
  label: 'Attio: Companies',
  description: 'Fetches companies from Attio workspace',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'AttioCompany',
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
    // 2. Loop through pages of company records
    // do {
    //   const response = await ctx.client!.post<AttioListRecordsResponse>(
    //     'objects/companies/records/query',
    //     {
    //       page_size: ctx.job.config.page_size ?? 100,
    //       ...(pageToken ? { page_token: pageToken } : {}),
    //     }
    //   )
    //
    //   for (const record of response.data.data) {
    //     const company = toAttioCompany(record)
    //     yield {
    //       id: `attio-company-${record.id.record_id}`,
    //       content: [company.name, company.industry].filter(Boolean).join(' - '),
    //       title: company.name,
    //       updatedAt: new Date(record.created_at),
    //       metadata: company,
    //     }
    //   }
    //
    //   pageToken = response.data.next_page_token
    // } while (pageToken)

    throw new Error('AttioIntegration companies job is not yet implemented')

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
