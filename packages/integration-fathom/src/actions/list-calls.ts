import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'

export const ListCallsInput = z.object({
  limit: z.number().optional().describe('Maximum number of calls to return'),
  cursor: z.string().optional().describe('Pagination cursor from previous response'),
})

export const ListCallsOutput = z.object({
  meetings: z.array(z.object({
    id: z.string(),
    title: z.string(),
    scheduled_at: z.string(),
    duration_seconds: z.number(),
    recording_available: z.boolean(),
  })),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
})

export async function listCalls(
  client: ApiClient,
  input: z.infer<typeof ListCallsInput>,
): Promise<z.infer<typeof ListCallsOutput>> {
  // const response = await client.get('/meetings', {
  //   limit: String(input.limit ?? 20),
  //   ...(input.cursor ? { cursor: input.cursor } : {}),
  // })
  // return response.data

  throw new Error('FathomIntegration list-calls action is not yet implemented')
}
