import { createHash, randomUUID } from 'crypto'

/**
 * Generate a prefixed ID. Format: `{prefix}_{uuid}`
 *
 * Prefixes:
 * - `bkt_`  — Bucket
 * - `src_`  — Source
 * - `chk_`  — Chunk
 * - `mem_`  — Memory record (episodic)
 * - `fact_` — Semantic fact
 * - `ent_`  — Semantic entity
 * - `edge_` — Semantic edge
 * - `wmem_` — Working memory item
 * - `pmem_` — Procedural memory
 * - `job_`  — Job run
 */
export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

export interface ChunkIdInput {
  embeddingModel: string
  bucketId: string
  idempotencyKey: string
  chunkIndex: number
}

/**
 * Generate the stable chunk id used by vector rows and graph chunk endpoints.
 *
 * This keeps chunk identity in the SDK instead of letting each adapter invent
 * storage-local ids that graph code cannot know about.
 */
export function chunkIdFor(input: ChunkIdInput): string {
  const hash = createHash('sha256')
    .update([
      input.embeddingModel,
      input.bucketId,
      input.idempotencyKey,
      String(input.chunkIndex),
    ].join('\u001f'))
    .digest('hex')
    .slice(0, 32)
  return `chk_${hash}`
}
