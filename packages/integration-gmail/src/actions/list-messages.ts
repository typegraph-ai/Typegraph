import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'
import { GmailMessageSchema } from '../models.js'

export const ListMessagesInput = z.object({
  query: z.string().optional().describe('Gmail search query (e.g. from:user@example.com)'),
  labelIds: z.array(z.string()).optional().describe('Label IDs to filter by'),
  maxResults: z.number().optional().describe('Max messages to return'),
})

export const ListMessagesOutput = z.object({
  messages: z.array(GmailMessageSchema),
  total: z.number(),
})

export async function listMessages(
  client: ApiClient,
  input: z.infer<typeof ListMessagesInput>,
): Promise<z.infer<typeof ListMessagesOutput>> {
  // const messages: GmailMessage[] = []
  // let pageToken: string | undefined
  //
  // do {
  //   const response = await client.get<GmailMessagesListResponse>(
  //     '/gmail/v1/users/me/messages',
  //     {
  //       ...(input.query ? { q: input.query } : {}),
  //       ...(input.labelIds ? { labelIds: input.labelIds.join(',') } : {}),
  //       maxResults: String(input.maxResults ?? 100),
  //       ...(pageToken ? { pageToken } : {}),
  //     }
  //   )
  //
  //   if (!response.data.messages) break
  //
  //   for (const msgRef of response.data.messages) {
  //     const msgResponse = await client.get<GmailRawMessage>(
  //       `/gmail/v1/users/me/messages/${msgRef.id}`,
  //       { format: 'full' }
  //     )
  //
  //     messages.push(toGmailMessage(msgResponse.data))
  //     if (input.maxResults && messages.length >= input.maxResults) break
  //   }
  //
  //   pageToken = response.data.nextPageToken
  // } while (pageToken && (!input.maxResults || messages.length < input.maxResults))
  //
  // return { messages, total: messages.length }

  throw new Error('GmailIntegration listMessages is not yet implemented')
}
