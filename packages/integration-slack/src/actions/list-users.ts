import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'
import { SlackUserSchema } from '../models.js'

export const ListUsersInput = z.object({
  limit: z.number().optional().describe('Max users to return'),
  include_bots: z.boolean().optional().describe('Include bot users'),
})

export const ListUsersOutput = z.object({
  users: z.array(SlackUserSchema),
  total: z.number(),
})

export async function listUsers(
  client: ApiClient,
  input: z.infer<typeof ListUsersInput>,
): Promise<z.infer<typeof ListUsersOutput>> {
  // const users: SlackUser[] = []
  // let cursor: string | undefined
  //
  // do {
  //   const response = await client.get<SlackUsersListResponse>(
  //     'users.list',
  //     { limit: '200', ...(cursor ? { cursor } : {}) }
  //   )
  //   for (const member of response.data.members) {
  //     if (!input.include_bots && member.is_bot) continue
  //     users.push(toSlackUser(member))
  //     if (input.limit && users.length >= input.limit) break
  //   }
  //   cursor = response.data.response_metadata?.next_cursor
  // } while (cursor && (!input.limit || users.length < input.limit))
  //
  // return { users, total: users.length }

  throw new Error('SlackIntegration listUsers is not yet implemented')
}
