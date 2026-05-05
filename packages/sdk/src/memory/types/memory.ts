import type { typegraphIdentity } from '../../types/identity.js'
import type { Visibility } from '../../types/source.js'
import type { ChunkRef } from '../../types/chunk.js'

// ── Memory Categories ──

export type MemoryCategory = 'episodic' | 'semantic' | 'procedural'

// ── Memory Lifecycle Status ──
// Explicit state machine for memory records.
// Transitions: pending→active, active→consolidated|invalidated|archived,
//              consolidated→archived|expired, invalidated→expired, archived→active|expired

export type MemoryStatus =
  | 'pending'       // created, not yet embedded/processed
  | 'active'        // processed, available for retrieval
  | 'consolidated'  // episodic promoted to semantic (still queryable, lower priority)
  | 'invalidated'   // contradicted by newer fact (preserved for history)
  | 'archived'      // decayed below threshold (queryable with includeArchived flag)
  | 'expired'       // end of lifecycle (audit trail only)

// ── Bi-temporal Timestamps ──
// Two timelines: world time (validAt/invalidAt) and system time (createdAt/expiredAt)
// Inspired by Graphiti's bi-temporal model and Snodgrass (1999)

export interface TemporalRecord {
  /** When the fact became true in the real world */
  validAt: Date
  /** When the fact stopped being true in the real world (undefined = still valid) */
  invalidAt?: Date | undefined
  /** When this record was ingested into the system */
  createdAt: Date
  /** When this record was superseded by a newer version in the system */
  expiredAt?: Date | undefined
}

// ── Deterministic External Identity ──

export type ExternalIdIdentityType =
  | 'tenant'
  | 'group'
  | 'user'
  | 'agent'
  | 'conversation'
  | 'entity'

export type ExternalIdEncoding = 'none' | 'sha256'

export interface ExternalId {
  /** External system identifier value, e.g. email, Slack user ID, GitHub handle. */
  id: string
  /** Identifier namespace/type, e.g. email, slack_user_id, github_handle. */
  type: string
  /** Identity level this identifier applies to. */
  identityType: ExternalIdIdentityType
  /** Encoding of `id`. Defaults to `none`. */
  encoding?: ExternalIdEncoding | undefined
  /** Optional system/source metadata for debugging and future conflict policy. */
  metadata?: Record<string, unknown> | undefined
}

// ── Base Memory Record ──

export interface MemoryRecord extends TemporalRecord {
  id: string
  category: MemoryCategory
  /** Lifecycle status - drives query filtering and allowed operations */
  status: MemoryStatus
  /** Human-readable content */
  content: string
  /** Vector embedding for semantic search */
  embedding?: number[] | undefined
  /** LLM-judged importance, 0-1 */
  importance: number
  /** Number of times this memory has been retrieved */
  accessCount: number
  /** When this memory was last retrieved */
  lastAccessedAt: Date
  /** Arbitrary metadata */
  metadata: Record<string, unknown>
  /** Who this memory belongs to */
  scope: typegraphIdentity
  /**
   * Access visibility. `undefined` / NULL means public — any recall can match.
   * Set to `'user'` / `'tenant'` / etc. to restrict access to callers that
   * supply a matching identity at that level.
   */
  visibility?: Visibility | undefined
}

// ── Episodic Memory ──
// Timestamped events with full context - "what happened"

export interface EpisodicMemory extends MemoryRecord {
  category: 'episodic'
  /** Type of event: conversation turn, observation, action, tool trace */
  eventType: string
  /** Participants involved in this episode */
  participants?: string[] | undefined
  /** Session this episode belongs to */
  conversationId?: string | undefined
  /** Ordering within a session */
  sequence?: number | undefined
  /** Whether this episode has been consolidated into semantic/procedural memory */
  consolidatedAt?: Date | undefined
}

// ── Semantic Memory - Entities ──
// Extracted knowledge entities - "who/what exists"

export interface SemanticEntity {
  id: string
  /** Canonical name */
  name: string
  /** Type classification: 'person', 'organization', 'concept', 'tool', etc. */
  entityType: string
  /** Alternative names / spellings */
  aliases: string[]
  /** Deterministic external identifiers used before fuzzy/probabilistic matching. */
  externalIds?: ExternalId[] | undefined
  /** Arbitrary typed properties */
  properties: Record<string, unknown>
  /** Entity lifecycle status. Missing/undefined is treated as active for older rows. */
  status?: 'active' | 'merged' | 'invalidated' | undefined
  /** Set when this entity was merged into another canonical entity. */
  mergedIntoEntityId?: string | undefined
  /** Set when the entity was invalidated or purged by an entity maintenance operation. */
  deletedAt?: Date | undefined
  /** Embedding of the entity name for similarity matching */
  embedding?: number[] | undefined
  /** Embedding of the entity description for Phase 3.5 near-miss matching */
  descriptionEmbedding?: number[] | undefined
  scope: typegraphIdentity
  /**
   * Access visibility. `undefined` / NULL means public. Set to a named level
   * to require the corresponding identity at recall time.
   */
  visibility?: Visibility | undefined
  temporal: TemporalRecord
}

export type EntityMentionType = 'subject' | 'object' | 'co_occurrence' | 'entity' | 'alias' | 'source_subject'

export interface SemanticEntityMention {
  entityId: string
  sourceId: string
  chunkIndex: number
  bucketId: string
  mentionType: EntityMentionType
  /** Exact text form observed in the source chunk. */
  surfaceText?: string | undefined
  /** Normalized lookup key for exact alias/mention search. */
  normalizedSurfaceText?: string | undefined
  confidence?: number | undefined
}

export type SemanticGraphNodeType = 'entity' | 'chunk' | 'memory'

export interface SemanticGraphEdge {
  id: string
  sourceType: SemanticGraphNodeType
  sourceId: string
  targetType: SemanticGraphNodeType
  targetId: string
  relation: string
  weight: number
  properties: Record<string, unknown>
  scope: typegraphIdentity
  visibility?: Visibility | undefined
  temporal: TemporalRecord
  evidence: string[]
  sourceChunkRef?: ChunkRef | undefined
  targetChunkRef?: ChunkRef | undefined
}

export interface SemanticEntityChunkEdge {
  id: string
  entityId: string
  chunkRef: ChunkRef
  weight: number
  mentionCount: number
  confidence?: number | undefined
  surfaceTexts: string[]
  mentionTypes: EntityMentionType[]
  scope?: typegraphIdentity | undefined
  visibility?: Visibility | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
}

export interface SemanticChunkRecord extends ChunkRef {
  content: string
  totalChunks: number
  metadata: Record<string, unknown>
  similarity?: number | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  conversationId?: string | undefined
}

export interface SemanticFactRecord {
  id: string
  edgeId: string
  sourceEntityId: string
  targetEntityId: string
  relation: string
  factText: string
  description?: string | undefined
  evidenceText?: string | undefined
  factSearchText?: string | undefined
  sourceChunkId?: string | undefined
  weight: number
  evidenceCount: number
  embedding?: number[] | undefined
  scope: typegraphIdentity
  visibility?: Visibility | undefined
  createdAt: Date
  updatedAt: Date
  invalidAt?: Date | undefined
  similarity?: number | undefined
}

// ── Semantic Memory - Edges ──
// Relationships between entities - "how things relate"

export interface SemanticEdge {
  id: string
  sourceType?: 'entity' | undefined
  sourceId?: string | undefined
  targetType?: 'entity' | undefined
  targetId?: string | undefined
  sourceEntityId: string
  targetEntityId: string
  /** Relationship type in SCREAMING_SNAKE_CASE: 'WORKS_AT', 'PREFERS', 'KNOWS' */
  relation: string
  /** Confidence weight, 0-1 */
  weight: number
  /** Arbitrary typed properties */
  properties: Record<string, unknown>
  scope: typegraphIdentity
  /**
   * Access visibility. `undefined` / NULL means public. Set to a named level
   * to require the corresponding identity at recall time.
   */
  visibility?: Visibility | undefined
  temporal: TemporalRecord
  /** Memory IDs that provide evidence for this edge */
  evidence: string[]
}

// ── Semantic Memory - Facts ──
// Extracted knowledge as subject-predicate-object triples - "what is known"

export interface SemanticFact extends MemoryRecord {
  category: 'semantic'
  /** Entity name or ID */
  subject: string
  /** Relationship type */
  predicate: string
  /** Entity name, value, or ID */
  object: string
  /** LLM-judged confidence, 0-1 */
  confidence: number
  /** Episodic memory IDs this fact was extracted from */
  sourceMemoryIds: string[]
}

// ── Procedural Memory ──
// Learned procedures from repeated patterns - "how to do things"

export interface ProceduralMemory extends MemoryRecord {
  category: 'procedural'
  /** Condition that activates this procedure */
  trigger: string
  /** Ordered steps to execute */
  steps: string[]
  /** How many times this procedure was executed successfully */
  successCount: number
  /** How many times this procedure failed */
  failureCount: number
  /** Outcome of the last execution */
  lastOutcome?: 'success' | 'failure' | undefined
}
