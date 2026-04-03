import type { JobTypeDefinition, JobRunContext, JobRunResult } from '@d8um-ai/core'

export const memoryCorrectionJob: JobTypeDefinition = {
  type: 'memory_correction',
  label: 'Memory: Correction',
  description: 'Apply natural language corrections to memory records',
  category: 'memory',
  requiresBucket: false,
  available: true,
  configSchema: [
    { key: 'correction', label: 'Correction Text', type: 'text', placeholder: 'e.g., "Actually, John works at Acme, not Beta Inc"', required: true },
  ],
  resultSchema: [
    { key: 'invalidated', label: 'Facts invalidated', type: 'number' },
    { key: 'created', label: 'New facts created', type: 'number' },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    return {
      jobId: ctx.job.id,
      bucketId: ctx.job.bucketId,
      status: 'completed',
      summary: 'Correction job requires d8umMemory context to run',
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      durationMs: 0,
    }
  },
}
