import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches messages from Gmail.
 *
 * High-level flow:
 * 1. Build a search query using the q parameter
 * 2. If incremental, use after:YYYY/MM/DD based on ctx.lastRunAt
 * 3. Paginate through messages.list to get message IDs
 * 4. For each message ID, fetch the full message via messages.get (format=full)
 * 5. Extract headers, body, and attachments from the MIME payload
 * 6. Transform each message into a RawDocument via toMessageDocument mapper
 * 7. Yield each document
 */
export const messagesJob: JobTypeDefinition = {
  type: 'gmail_messages',
  label: 'Gmail: Messages',
  description: 'Fetches messages from Gmail',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'GmailMessage',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
  configSchema: [
    {
      key: 'label_ids',
      label: 'Label IDs',
      type: 'text',
      required: false,
      placeholder: 'INBOX,IMPORTANT (comma-separated, empty = all)',
    },
    {
      key: 'query',
      label: 'Search Query',
      type: 'text',
      required: false,
      placeholder: 'Gmail search query (e.g. from:user@example.com)',
    },
    {
      key: 'max_messages',
      label: 'Max Messages to Fetch',
      type: 'number',
      required: false,
      placeholder: '500',
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Build the search query
    //    const queryParts: string[] = []
    //
    //    if (ctx.job.config.query) {
    //      queryParts.push(ctx.job.config.query as string)
    //    }
    //
    //    // Incremental: only fetch messages after the last run
    //    if (ctx.lastRunAt) {
    //      const afterDate = ctx.lastRunAt.toISOString().split('T')[0].replace(/-/g, '/')
    //      queryParts.push(`after:${afterDate}`)
    //    }
    //
    //    const q = queryParts.join(' ')
    //
    // 2. Parse label IDs if provided
    //    const labelIds = ctx.job.config.label_ids
    //      ? (ctx.job.config.label_ids as string).split(',').map(s => s.trim())
    //      : undefined
    //
    // 3. Paginate through messages.list
    //    let pageToken: string | undefined
    //    let messageCount = 0
    //    const maxMessages = ctx.job.config.max_messages as number | undefined
    //
    //    do {
    //      const response = await ctx.client!.get<GmailMessagesListResponse>(
    //        '/gmail/v1/users/me/messages',
    //        {
    //          ...(q ? { q } : {}),
    //          ...(labelIds ? { labelIds: labelIds.join(',') } : {}),
    //          maxResults: '100',
    //          ...(pageToken ? { pageToken } : {}),
    //        }
    //      )
    //
    //      if (!response.data.messages) break
    //
    //      // 4. For each message reference, fetch the full message
    //      for (const msgRef of response.data.messages) {
    //        const msgResponse = await ctx.client!.get<GmailRawMessage>(
    //          `/gmail/v1/users/me/messages/${msgRef.id}`,
    //          { format: 'full' }
    //        )
    //
    //        yield toMessageDocument(msgResponse.data)
    //        messageCount++
    //
    //        if (maxMessages && messageCount >= maxMessages) break
    //      }
    //
    //      pageToken = response.data.nextPageToken
    //    } while (pageToken && (!maxMessages || messageCount < maxMessages))

    throw new Error('GmailIntegration messages job is not yet implemented')

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
