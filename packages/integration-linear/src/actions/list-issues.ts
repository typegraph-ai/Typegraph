import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'
import { LinearIssueSchema } from '../models.js'

export const ListIssuesInput = z.object({
  teamId: z.string().optional().describe('Filter by team ID'),
  status: z.string().optional().describe('Filter by state type (e.g. "started", "completed")'),
  limit: z.number().optional().describe('Max issues to return'),
})

export const ListIssuesOutput = z.object({
  issues: z.array(LinearIssueSchema),
  total: z.number(),
})

export async function listIssues(
  client: ApiClient,
  input: z.infer<typeof ListIssuesInput>,
): Promise<z.infer<typeof ListIssuesOutput>> {
  // const filter: Record<string, unknown> = {}
  //
  // if (input.teamId) {
  //   filter.team = { id: { eq: input.teamId } }
  // }
  // if (input.status) {
  //   filter.state = { type: { eq: input.status } }
  // }
  //
  // const query = `
  //   query Issues($filter: IssueFilter) {
  //     issues(filter: $filter, first: ${input.limit ?? 50}) {
  //       nodes {
  //         id identifier title description priority priorityLabel
  //         state { id name type color }
  //         assignee { id name email displayName }
  //         labels { nodes { id name color } }
  //         createdAt updatedAt dueDate estimate url number
  //       }
  //     }
  //   }
  // `
  //
  // const response = await client.post<LinearIssuesResponse>(
  //   '/graphql',
  //   { query, variables: { filter } }
  // )
  //
  // const issues = response.data.data.issues.nodes.map(toLinearIssue)
  // return { issues, total: issues.length }

  throw new Error('LinearIntegration listIssues is not yet implemented')
}
