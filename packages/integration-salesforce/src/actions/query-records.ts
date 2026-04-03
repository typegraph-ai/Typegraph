import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'

export const QueryRecordsInput = z.object({
  soql: z.string().describe('SOQL query string (e.g. "SELECT Id, Name FROM Account LIMIT 10")'),
})

export const QueryRecordsOutput = z.object({
  records: z.array(z.record(z.unknown())),
  totalSize: z.number(),
  done: z.boolean(),
})

export async function queryRecords(
  client: ApiClient,
  input: z.infer<typeof QueryRecordsInput>,
): Promise<z.infer<typeof QueryRecordsOutput>> {
  // const response = await client.get<SalesforceQueryResponse<Record<string, unknown>>>(
  //   `query?q=${encodeURIComponent(input.soql)}`
  // )
  //
  // return {
  //   records: response.data.records,
  //   totalSize: response.data.totalSize,
  //   done: response.data.done,
  // }

  throw new Error('SalesforceIntegration queryRecords is not yet implemented')
}
