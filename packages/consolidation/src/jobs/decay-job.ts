import type { JobTypeDefinition, JobRunContext, JobExecuteResult } from '@d8um/core'

export const memoryDecayJob: JobTypeDefinition = {
  type: 'memory_decay',
  label: 'Memory: Decay & Forgetting',
  description: 'Apply decay scoring and forgetting policies to aged memories',
  category: 'memory',
  requiresSource: false,
  available: true,
  schedule: '0 * * * *', // suggested: hourly

  configSchema: [
    {
      key: 'halfLifeMs',
      label: 'Half-life (ms)',
      type: 'number',
      placeholder: '604800000',
      required: false,
    },
    {
      key: 'minScore',
      label: 'Min Score Threshold',
      type: 'number',
      placeholder: '0.1',
      required: false,
    },
    {
      key: 'forgettingPolicy',
      label: 'Forgetting Policy',
      type: 'select',
      required: false,
      options: [
        { value: 'archive', label: 'Archive (soft delete)' },
        { value: 'summarize', label: 'Summarize & archive' },
        { value: 'delete', label: 'Delete permanently' },
      ],
    },
  ],

  resultSchema: [
    { key: 'archived', label: 'Memories archived', type: 'number' },
    { key: 'summarized', label: 'Summaries created', type: 'number' },
    { key: 'deleted', label: 'Memories deleted', type: 'number' },
  ],

  async execute(_ctx: JobRunContext): Promise<JobExecuteResult> {
    return {
      status: 'completed',
      summary: 'Decay job requires D8umMemory context to execute',
    }
  },
}
