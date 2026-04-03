import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'

export const FetchCallTranscriptsInput = z.object({
  callIds: z.array(z.string()).describe('List of Gong call IDs to fetch transcripts for'),
})

export const FetchCallTranscriptsOutput = z.object({
  requestId: z.string(),
  callTranscripts: z.array(z.object({
    callId: z.string(),
    transcript: z.array(z.object({
      speakerId: z.string(),
      topic: z.string().optional(),
      sentences: z.array(z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      })),
    })),
  })),
})

export async function fetchCallTranscripts(
  client: ApiClient,
  input: z.infer<typeof FetchCallTranscriptsInput>,
): Promise<z.infer<typeof FetchCallTranscriptsOutput>> {
  // const response = await client.post('/v2/calls/transcript', {
  //   filter: { callIds: input.callIds },
  // })
  // return response.data

  throw new Error('GongIntegration fetch-call-transcripts action is not yet implemented')
}
