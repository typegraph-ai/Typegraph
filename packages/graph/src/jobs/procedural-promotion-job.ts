import type { JobTypeDefinition, JobRunContext, JobRunResult } from '@d8um-ai/core'

export const memoryProceduralPromotionJob: JobTypeDefinition = {
  type: 'memory_procedural_promotion',
  label: 'Memory: Procedural Promotion',
  description: 'Detect repeated action patterns and create procedural memories',
  category: 'memory',
  requiresBucket: false,
  available: true,
  configSchema: [
    { key: 'minPatternCount', label: 'Min Pattern Occurrences', type: 'number', placeholder: '3', required: false },
  ],
  resultSchema: [{ key: 'proceduresCreated', label: 'Procedures created', type: 'number' }],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    return {
      jobId: ctx.job.id,
      bucketId: ctx.job.bucketId,
      status: 'completed',
      summary: 'Procedural promotion job requires d8umMemory context to run',
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      durationMs: 0,
    }
  },
}
