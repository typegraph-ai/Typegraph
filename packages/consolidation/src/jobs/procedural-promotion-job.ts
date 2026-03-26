import type { JobTypeDefinition, JobRunContext, JobExecuteResult } from '@d8um/core'

export const memoryProceduralPromotionJob: JobTypeDefinition = {
  type: 'memory_procedural_promotion',
  label: 'Memory: Procedural Promotion',
  description: 'Detect repeated action patterns and create procedural memories',
  category: 'memory',
  requiresSource: false,
  available: true,

  configSchema: [
    {
      key: 'minPatternCount',
      label: 'Min Pattern Occurrences',
      type: 'number',
      placeholder: '3',
      required: false,
    },
  ],

  resultSchema: [
    { key: 'proceduresCreated', label: 'Procedures created', type: 'number' },
  ],

  async execute(_ctx: JobRunContext): Promise<JobExecuteResult> {
    return {
      status: 'completed',
      summary: 'Procedural promotion job requires D8umMemory context to execute',
    }
  },
}
