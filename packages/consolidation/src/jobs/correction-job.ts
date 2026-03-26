import type { JobTypeDefinition, JobRunContext, JobExecuteResult } from '@d8um/core'

export const memoryCorrectionJob: JobTypeDefinition = {
  type: 'memory_correction',
  label: 'Memory: Correction',
  description: 'Apply natural language corrections to memory records',
  category: 'memory',
  requiresSource: false,
  available: true,

  configSchema: [
    {
      key: 'correction',
      label: 'Correction Text',
      type: 'text',
      placeholder: 'e.g., "Actually, John works at Acme, not Beta Inc"',
      required: true,
    },
  ],

  resultSchema: [
    { key: 'invalidated', label: 'Facts invalidated', type: 'number' },
    { key: 'created', label: 'New facts created', type: 'number' },
  ],

  async execute(_ctx: JobRunContext): Promise<JobExecuteResult> {
    return {
      status: 'completed',
      summary: 'Correction job requires D8umMemory context to execute',
    }
  },
}
