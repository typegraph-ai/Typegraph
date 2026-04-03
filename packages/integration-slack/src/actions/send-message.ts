import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'

export const SendMessageInput = z.object({
  channel: z.string().describe('Channel ID to send the message to'),
  text: z.string().describe('Message text'),
  thread_ts: z.string().optional().describe('Thread timestamp to reply to'),
})

export const SendMessageOutput = z.object({
  ok: z.boolean(),
  channel: z.string(),
  ts: z.string(),
  message: z.object({
    text: z.string(),
    ts: z.string(),
  }),
})

export async function sendMessage(
  client: ApiClient,
  input: z.infer<typeof SendMessageInput>,
): Promise<z.infer<typeof SendMessageOutput>> {
  // const response = await client.post('chat.postMessage', {
  //   channel: input.channel,
  //   text: input.text,
  //   ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
  // })
  // return response.data

  throw new Error('SlackIntegration sendMessage is not yet implemented')
}
