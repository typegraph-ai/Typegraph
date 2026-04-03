import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches issues from a Linear workspace using the GraphQL API.
 *
 * High-level flow:
 * 1. Build a GraphQL query for issues with cursor-based pagination
 * 2. If incremental, add an updatedAt filter using ctx.lastRunAt
 * 3. Execute the query against /graphql endpoint
 * 4. Iterate through nodes in the response connection
 * 5. Transform each issue into a RawDocument via toIssueDocument mapper
 * 6. Yield each document
 * 7. Continue fetching while pageInfo.hasNextPage is true using endCursor
 */
export const issuesJob: JobTypeDefinition = {
  type: 'linear_issues',
  label: 'Linear: Issues',
  description: 'Fetches issues from Linear workspace',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'LinearIssue',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['read', 'issues:read'],
  configSchema: [
    {
      key: 'team_id',
      label: 'Team ID',
      type: 'text',
      required: false,
      placeholder: 'Filter to a specific team (empty = all)',
    },
    {
      key: 'include_archived',
      label: 'Include Archived Issues',
      type: 'boolean',
      required: false,
    },
    {
      key: 'max_issues',
      label: 'Max Issues',
      type: 'number',
      required: false,
      placeholder: '5000',
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Build the filter object for the GraphQL query
    // const filter: Record<string, unknown> = {}
    // if (ctx.job.config.team_id) {
    //   filter.team = { id: { eq: ctx.job.config.team_id } }
    // }
    // if (ctx.lastRunAt) {
    //   filter.updatedAt = { gte: ctx.lastRunAt.toISOString() }
    // }
    // if (!ctx.job.config.include_archived) {
    //   filter.archivedAt = { null: true }
    // }
    //
    // 2. Paginate through issues
    // let hasNextPage = true
    // let endCursor: string | undefined
    // let issueCount = 0
    // const maxIssues = ctx.job.config.max_issues as number | undefined
    //
    // while (hasNextPage) {
    //   const query = `
    //     query Issues($filter: IssueFilter, $after: String) {
    //       issues(filter: $filter, first: 100, after: $after) {
    //         nodes {
    //           id identifier title description priority priorityLabel
    //           state { id name type color }
    //           assignee { id name email displayName }
    //           labels { nodes { id name color } }
    //           team { id name key }
    //           project { id name }
    //           createdAt updatedAt dueDate estimate url number branchName
    //         }
    //         pageInfo { hasNextPage endCursor }
    //       }
    //     }
    //   `
    //
    //   const response = await ctx.client!.post<LinearIssuesResponse>(
    //     '/graphql',
    //     { query, variables: { filter, after: endCursor } }
    //   )
    //
    //   for (const issue of response.data.data.issues.nodes) {
    //     yield toIssueDocument(issue)
    //     issueCount++
    //     if (maxIssues && issueCount >= maxIssues) return
    //   }
    //
    //   hasNextPage = response.data.data.issues.pageInfo.hasNextPage
    //   endCursor = response.data.data.issues.pageInfo.endCursor
    // }

    throw new Error('LinearIntegration issues job is not yet implemented')

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
