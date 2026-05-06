import type { typegraphIdentity } from '../../types/identity.js'
import type { Visibility } from '../../types/source.js'
import type {
  MemoryRecord,
  MemoryCategory,
  MemoryStatus,
  ExternalId,
  SemanticEntity,
  SemanticEntityMention,
  SemanticEdge,
  SemanticGraphEdge,
  SemanticEntityChunkEdge,
  SemanticChunkRecord,
  SemanticFactRecord,
} from './memory.js'
import type { ChunkRef } from '../../types/chunk.js'
import type {
  DeleteGraphEntityOpts,
  DeleteGraphEntityResult,
  MergeGraphEntitiesInput,
  MergeGraphEntitiesResult,
} from '../../types/graph-bridge.js'

// ── Memory Filtering ──

export interface MemoryFilter {
  /** Compatibility identity filter. Prefer explicit identity fields. */
  scope?: typegraphIdentity | undefined
  /** Explicit identity fields for filtering */
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
  visibility?: Visibility | Visibility[] | undefined
  ids?: string[] | undefined
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

export interface GraphBackfillPageOpts {
  scope?: typegraphIdentity | undefined
  bucketIds?: string[] | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export interface ChunkBackfillRecord {
  chunkId: string
  bucketId: string
  sourceId: string
  chunkIndex: number
  embeddingModel: string
  content: string
  metadata: Record<string, unknown>
  visibility?: Visibility | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
}

export interface ChunkMentionBackfillRow extends ChunkBackfillRecord {
  entityId: string
  mentionType: SemanticEntityMention['mentionType']
  surfaceText?: string | undefined
  normalizedSurfaceText?: string | undefined
  confidence?: number | undefined
}

// ── Memory Store Adapter ──
// Persistence layer for memory records. Follows the same adapter pattern
// as VectorStoreAdapter in @typegraph-ai/sdk.

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
  getEntity?(id: string, scope?: typegraphIdentity): Promise<SemanticEntity | null>
  getEntitiesBatch?(ids: string[], scope?: typegraphIdentity): Promise<SemanticEntity[]>
  findEntities?(query: string, scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]>
  upsertEntityExternalIds?(entityId: string, externalIds: ExternalId[], scope: typegraphIdentity): Promise<void>
  findEntityByExternalId?(externalId: ExternalId, scope?: typegraphIdentity): Promise<SemanticEntity | null>
  mergeEntityReferences?(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult>
  deleteEntityReferences?(entityId: string, opts?: DeleteGraphEntityOpts | null): Promise<DeleteGraphEntityResult>
  searchEntities?(embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]>
  searchEntitiesHybrid?(query: string, embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticEntity[]>

  // ── Chunk + Fact Graph Storage (optional - needed for heterogeneous graph retrieval) ──

  upsertGraphEdges?(edges: SemanticGraphEdge[]): Promise<void>

  upsertFactRecord?(fact: SemanticFactRecord): Promise<SemanticFactRecord>

  searchFacts?(embedding: number[], scope: typegraphIdentity, limit?: number): Promise<SemanticFactRecord[]>
  searchFactsHybrid?(query: string, embedding: number[] | undefined, scope: typegraphIdentity, limit?: number): Promise<SemanticFactRecord[]>

  getChunkEdgesForEntities?(
    entityIds: string[],
    opts?: {
      scope?: typegraphIdentity | undefined
      bucketIds?: string[] | undefined
      limit?: number | undefined
    }
  ): Promise<SemanticEntityChunkEdge[]>

  getChunksByRefs?(
    chunkRefs: ChunkRef[],
    opts: {
      chunksTable: string
      scope?: typegraphIdentity | undefined
      bucketIds?: string[] | undefined
    }
  ): Promise<SemanticChunkRecord[]>

  searchChunks?(
    embedding: number[],
    scope: typegraphIdentity,
    opts: {
      chunksTable: string
      bucketIds?: string[] | undefined
      limit?: number | undefined
      chunkRefs?: ChunkRef[] | undefined
    }
  ): Promise<SemanticChunkRecord[]>

  listChunkBackfillRecords?(
    opts: GraphBackfillPageOpts & { chunksTable: string }
  ): Promise<ChunkBackfillRecord[]>

  listChunkMentionBackfillRows?(
    opts: GraphBackfillPageOpts & { chunksTable: string }
  ): Promise<ChunkMentionBackfillRow[]>

  listSemanticEdgesForBackfill?(
    opts?: GraphBackfillPageOpts
  ): Promise<SemanticEdge[]>

  // ── Edge Storage (optional - needed for semantic memory graph) ──

  upsertEdge?(edge: SemanticEdge): Promise<SemanticEdge>
  getEdges?(entityId: string, direction?: 'in' | 'out' | 'both', scope?: typegraphIdentity): Promise<SemanticEdge[]>
  getEdgesBatch?(entityIds: string[], direction?: 'in' | 'out' | 'both', scope?: typegraphIdentity): Promise<SemanticEdge[]>
  findEdges?(sourceId: string, targetId: string, relation?: string): Promise<SemanticEdge[]>
  invalidateEdge?(id: string, invalidAt?: Date): Promise<void>
  invalidateGraphEdgesForNode?(nodeType: 'entity' | 'chunk' | 'memory', nodeId: string, invalidAt?: Date): Promise<void>
  getMemoryIdsForEntities?(entityIds: string[], scope?: typegraphIdentity): Promise<string[]>

  // ── Entity ↔ Chunk Mention Evidence ──
  // Records which chunks mentioned which entities during extraction. Used for
  // lexical entity lookup, provenance/debugging, and edge backfill.

  /** Record one or more (entity, chunk, bucket) mentions. Idempotent on
   *  (entityId, sourceId, chunkIndex, mentionType, normalizedSurfaceText). */
  upsertEntityChunkMentions?(
    mentions: SemanticEntityMention[]
  ): Promise<void>

  // ── Counts & Aggregates (optional - used for health checks and graph exploration) ──

  /** Count memory records matching an optional filter. */
  countMemories?(filter?: MemoryFilter): Promise<number>
  /** Count total semantic entities. */
  countEntities?(scope?: typegraphIdentity): Promise<number>
  /** Count total semantic edges. */
  countEdges?(scope?: typegraphIdentity): Promise<number>

  /** Get all relation types with their occurrence counts. */
  getRelationTypes?(scope?: typegraphIdentity): Promise<Array<{ relation: string; count: number }>>
  /** Get all entity types with their occurrence counts. */
  getEntityTypes?(scope?: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>>
  /** Get degree distribution (how many entities have N edges). */
  getDegreeDistribution?(scope?: typegraphIdentity): Promise<Array<{ degree: number; count: number }>>
}
