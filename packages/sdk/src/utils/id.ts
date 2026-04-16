import { randomUUID } from 'crypto'

/**
 * Generate a prefixed ID. Format: `{prefix}_{uuid}`
 *
 * Prefixes:
 * - `bkt_`  — Bucket
 * - `doc_`  — Document
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
