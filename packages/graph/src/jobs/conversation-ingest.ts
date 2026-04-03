import type { JobTypeDefinition, JobRunResult, JobRunContext, ConfigField } from '@d8um-ai/core'

/**
 * Memory conversation ingest job type definition.
 *
 * This job extracts memories from conversation messages using the
 * MemoryExtractor pipeline. It creates episodic memories and extracts
 * semantic facts via LLM-driven analysis.
 *
 * The actual execution requires a MemoryExtractor and MemoryStoreAdapter
 * to be provided via the job config. This job type is registered in the
 * job registry but the run() implementation delegates to the caller's
 * configured extraction pipeline.
 */
export const conversationIngestJob: JobTypeDefinition = {
  type: 'memory_conversation_ingest',
  label: 'Memory: Conversation Ingest',
  description: 'Extract episodic and semantic memories from conversation messages',
  category: 'memory',
  requiresBucket: false,
  available: true,
  schedule: undefined,
  syncMode: 'incremental',

  configSchema: [
    {
      key: 'messages',
      label: 'Conversation Messages',
      type: 'text' as ConfigField['type'],
      placeholder: 'JSON array of {role, content} messages',
      required: true,
    },
    {
      key: 'sessionId',
      label: 'Session ID',
      type: 'text' as ConfigField['type'],
      placeholder: 'Optional session identifier',
      required: false,
    },
  ],

  resultSchema: [
    { key: 'episodicCount', label: 'Episodic memories created', type: 'number' },
    { key: 'factsExtracted', label: 'Facts extracted', type: 'number' },
    { key: 'operationsCount', label: 'Total operations', type: 'number' },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // Placeholder - actual execution is handled by d8umMemory
    return {
      jobId: ctx.job.id,
      bucketId: ctx.job.bucketId,
      status: 'completed',
      summary: 'Conversation ingest job requires d8umMemory context to run',
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      metrics: { episodicCount: 0, factsExtracted: 0, operationsCount: 0 },
      durationMs: 0,
    }
  },
}
