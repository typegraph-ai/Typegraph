import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'

export const ListRecordsInput = z.object({
  object: z.string().describe('Object API slug (e.g. "people", "companies")'),
  page_size: z.number().optional().describe('Number of records per page'),
  page_token: z.string().optional().describe('Pagination token for next page'),
})

export const ListRecordsOutput = z.object({
  records: z.array(z.record(z.unknown())),
  next_page_token: z.string().optional(),
  total: z.number(),
})

export async function listRecords(
  client: ApiClient,
  input: z.infer<typeof ListRecordsInput>,
): Promise<z.infer<typeof ListRecordsOutput>> {
  // const response = await client.post<AttioListRecordsResponse>(
  //   `objects/${input.object}/records/query`,
  //   {
  //     page_size: input.page_size ?? 100,
  //     ...(input.page_token ? { page_token: input.page_token } : {}),
  //   }
  // )
  //
  // return {
  //   records: response.data.data.map(record => ({
  //     id: record.id.record_id,
  //     values: record.values,
  //     created_at: record.created_at,
  //   })),
  //   next_page_token: response.data.next_page_token,
  //   total: response.data.data.length,
  // }

  throw new Error('AttioIntegration listRecords is not yet implemented')
}
