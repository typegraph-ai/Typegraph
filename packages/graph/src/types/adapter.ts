import type { typegraphIdentity, Visibility } from '@typegraph-ai/core'
import type {
  MemoryRecord,
  MemoryCategory,
  MemoryStatus,
  SemanticEntity,
  SemanticEdge,
} from './memory.js'

// ── Memory Filtering ──

export interface MemoryFilter {
  /** Legacy JSONB scope filter (deprecated — use explicit identity fields) */
  scope?: typegraphIdentity | undefined
  /** Explicit identity fields for filtering */
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  visibility?: Visibility | Visibility[] | undefined
  category?: MemoryCategory | MemoryCategory[] | undefined
  /** Filter by lifecycle status */
  status?: MemoryStatus | MemoryStatus[] | undefined
  /** Only return records that are valid (not invalidated) at this time */
  activeAt?: Date | undefined
  /** Minimum importance threshold (0-1) */
  minImportance?: number | undefined
  /** Metadata key-value filters */
  metadata?: Record<string, unknown> | undefined
}

// ── Memory Search Options ──

export interface MemorySearchOpts {
  count: number
  filter?: MemoryFilter | undefined
  /** Include records that have been invalidated or expired. Default: false */
  includeExpired?: boolean | undefined
  /** Point-in-time query: only return records valid at this timestamp */
  temporalAt?: Date | undefined
}

// ── Memory Store Adapter ──
// Persistence layer for memory records. Follows the same adapter pattern
// as VectorStoreAdapter in @typegraph-ai/core.

export interface MemoryStoreAdapter {
  initialize(): Promise<void>
  destroy?(): Promise<void>

  // ── CRUD ──

  upsert(record: MemoryRecord): Promise<MemoryRecord>
  get(id: string): Promise<MemoryRecord | null>
  list(filter: MemoryFilter, limit?: number): Promise<MemoryRecord[]>
  delete(id: string): Promise<void>

  // ── Temporal Operations ──

  /** Mark a record as invalid at a given time (preserves the record) */
  invalidate(id: string, invalidAt?: Date): Promise<void>
  /** Mark a record as expired (superseded by a newer version) */
  expire(id: string): Promise<void>
  /** Get all versions of a record (current + invalidated/expired) */
  getHistory(id: string): Promise<MemoryRecord[]>

  // ── Search ──

  /** Semantic search over memory records using vector similarity */
  search(embedding: number[], opts: MemorySearchOpts): Promise<MemoryRecord[]>

  /** Hybrid search combining vector similarity and BM25 keyword matching.
   *  When available, uses RRF to fuse vector and keyword ranked lists.
   *  Falls back to vector-only search if not implemented. */
  hybridSearch?(embedding: number[], query: string, opts: MemorySearchOpts): Promise<MemoryRecord[]>

  // ── Access Tracking ──

  /** Increment access count and update lastAccessedAt for a record */
  recordAccess?(id: string): Promise<void>

  // ── Entity Storage (optional - needed for semantic memory graph) ──

  upsertEntity?(entity: SemanticEntity): Promise<SemanticEntity>
  getEntity?(id: string): Promise<SemanticEntity | null>
  getEntitiesBatch?(ids: string[]): Promise<SemanticEntity[]>
  findEntities?(query: string, scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]>
  searchEntities?(embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]>

  // ── Edge Storage (optional - needed for semantic memory graph) ──

  upsertEdge?(edge: SemanticEdge): Promise<SemanticEdge>
  getEdges?(entityId: string, direction?: 'in' | 'out' | 'both'): Promise<SemanticEdge[]>
  getEdgesBatch?(entityIds: string[], direction?: 'in' | 'out' | 'both'): Promise<SemanticEdge[]>
  findEdges?(sourceId: string, targetId: string, relation?: string): Promise<SemanticEdge[]>
  invalidateEdge?(id: string, invalidAt?: Date): Promise<void>

  // ── Counts & Aggregates (optional - used for health checks and graph exploration) ──

  /** Count memory records matching an optional filter. */
  countMemories?(filter?: MemoryFilter): Promise<number>
  /** Count total semantic entities. */
  countEntities?(): Promise<number>
  /** Count total semantic edges. */
  countEdges?(): Promise<number>

  /** Get all relation types with their occurrence counts. */
  getRelationTypes?(): Promise<Array<{ relation: string; count: number }>>
  /** Get all entity types with their occurrence counts. */
  getEntityTypes?(): Promise<Array<{ entityType: string; count: number }>>
  /** Get degree distribution (how many entities have N edges). */
  getDegreeDistribution?(): Promise<Array<{ degree: number; count: number }>>
}
