import type { JobTypeDefinition, JobRunContext, JobExecuteResult } from '@d8um/core'

export const memoryConsolidationJob: JobTypeDefinition = {
  type: 'memory_consolidation',
  label: 'Memory: Consolidation',
  description: 'Promote episodic memories into semantic facts and procedural knowledge',
  category: 'memory',
  requiresSource: false,
  available: true,
  schedule: '0 3 * * *', // suggested: daily at 3am

  configSchema: [
    {
      key: 'strategies',
      label: 'Consolidation Strategies',
      type: 'text',
      placeholder: 'episodic_to_semantic,procedural_promotion',
      required: false,
    },
    {
      key: 'minEpisodicAgeMs',
      label: 'Min Episode Age (ms)',
      type: 'number',
      placeholder: '3600000',
      required: false,
    },
  ],

  resultSchema: [
    { key: 'factsExtracted', label: 'Facts extracted', type: 'number' },
    { key: 'proceduresCreated', label: 'Procedures created', type: 'number' },
    { key: 'episodesConsolidated', label: 'Episodes consolidated', type: 'number' },
  ],

  async execute(_ctx: JobRunContext): Promise<JobExecuteResult> {
    return {
      status: 'completed',
      summary: 'Consolidation job requires D8umMemory context to execute',
    }
  },
}
