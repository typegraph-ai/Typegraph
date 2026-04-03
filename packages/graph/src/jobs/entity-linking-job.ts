import type { JobTypeDefinition, JobRunContext, JobRunResult } from '@d8um-ai/core'

export const entityLinkingJob: JobTypeDefinition = {
  type: 'entity_linking',
  label: 'Entity Linking',
  description: 'Detect and link equivalent entities across buckets using embedding similarity. Creates SYNONYM edges for cross-bucket associative retrieval.',
  category: 'maintenance',
  requiresBucket: false,
  available: true,
  configSchema: [
    {
      key: 'similarityThreshold',
      type: 'text',
      label: 'Similarity Threshold',
      required: false,
      placeholder: '0.85',
    },
  ],
}
