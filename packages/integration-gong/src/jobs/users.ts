import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches users from a Gong workspace.
 *
 * High-level flow:
 * 1. Call GET /v2/users with cursor-based pagination
 * 2. Transform each user into a RawDocument via toGongUser mapper
 * 3. Yield each document
 * 4. Follow records.cursor for next page until no more pages
 */
export const usersJob: JobTypeDefinition = {
  type: 'gong_users',
  label: 'Gong: Users',
  description: 'Fetches users from Gong workspace',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'GongUser',
  schedule: 'daily',
  syncMode: 'full',
  scopes: ['api:users:read'],
  configSchema: [
    {
      key: 'include_inactive',
      label: 'Include Inactive Users',
      type: 'boolean',
      required: false,
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Initialize cursor for pagination
    // let cursor: string | undefined
    //
    // 2. Loop through pages
    // do {
    //   const response = await ctx.client!.get<GongUsersListResponse>(
    //     '/v2/users',
    //     {
    //       ...(cursor ? { cursor } : {}),
    //     }
    //   )
    //
    //   for (const user of response.data.users) {
    //     const mapped = toGongUser(user)
    //     yield {
    //       id: `gong-user-${user.id}`,
    //       content: [mapped.firstName, mapped.lastName, mapped.emailAddress, mapped.title].filter(Boolean).join(' '),
    //       title: [mapped.firstName, mapped.lastName].filter(Boolean).join(' ') || mapped.emailAddress || user.id,
    //       updatedAt: new Date(user.created),
    //       metadata: mapped,
    //     }
    //   }
    //
    //   cursor = response.data.records.cursor
    // } while (cursor)

    throw new Error('GongIntegration users job is not yet implemented')

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
