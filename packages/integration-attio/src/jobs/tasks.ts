import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches tasks from an Attio workspace.
 *
 * High-level flow:
 * 1. GET /tasks with pagination token
 * 2. If incremental, filter tasks by created_at > ctx.lastRunAt
 * 3. Each page returns an array of task objects
 * 4. Transform each task into a RawDocument via toAttioTask mapper
 * 5. Yield each document
 * 6. Continue until no next_page_token is returned
 */
export const tasksJob: JobTypeDefinition = {
  type: 'attio_tasks',
  label: 'Attio: Tasks',
  description: 'Fetches tasks from Attio workspace',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'AttioTask',
  schedule: 'hourly',
  syncMode: 'incremental',
  scopes: ['tasks:read'],
  configSchema: [
    {
      key: 'include_completed',
      label: 'Include Completed Tasks',
      type: 'boolean',
      required: false,
    },
    {
      key: 'page_size',
      label: 'Page Size',
      type: 'number',
      required: false,
      placeholder: '100',
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Initialize pagination token
    // let pageToken: string | undefined
    //
    // 2. Loop through pages of tasks
    // do {
    //   const response = await ctx.client!.get<AttioListTasksResponse>(
    //     'tasks',
    //     {
    //       page_size: String(ctx.job.config.page_size ?? 100),
    //       ...(pageToken ? { page_token: pageToken } : {}),
    //     }
    //   )
    //
    //   for (const rawTask of response.data.data) {
    //     // Skip completed tasks if not included
    //     if (!ctx.job.config.include_completed && rawTask.is_completed) continue
    //
    //     // Incremental: skip tasks created before last run
    //     if (ctx.lastRunAt && new Date(rawTask.created_at) < ctx.lastRunAt) continue
    //
    //     const task = toAttioTask(rawTask)
    //     yield {
    //       id: `attio-task-${rawTask.id.task_id}`,
    //       content: [task.title, task.description].filter(Boolean).join('\n'),
    //       title: task.title,
    //       updatedAt: new Date(rawTask.created_at),
    //       metadata: task,
    //     }
    //   }
    //
    //   pageToken = response.data.next_page_token
    // } while (pageToken)

    throw new Error('AttioIntegration tasks job is not yet implemented')

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
