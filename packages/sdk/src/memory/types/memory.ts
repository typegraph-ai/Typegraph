import type { typegraphIdentity } from '../../types/identity.js'
import type { Visibility } from '../../types/typegraph-document.js'

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
  /** Access visibility. Default: 'user' (most restrictive). */
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
  /** Arbitrary typed properties */
  properties: Record<string, unknown>
  /** Embedding of the entity name for similarity matching */
  embedding?: number[] | undefined
  /** Embedding of the entity description for Phase 3.5 near-miss matching */
  descriptionEmbedding?: number[] | undefined
  scope: typegraphIdentity
  /** Access visibility. Default: 'tenant' (entities are typically shared within org). */
  visibility?: Visibility | undefined
  temporal: TemporalRecord
}

// ── Semantic Memory - Edges ──
// Relationships between entities - "how things relate"

export interface SemanticEdge {
  id: string
  sourceEntityId: string
  targetEntityId: string
  /** Relationship type in SCREAMING_SNAKE_CASE: 'WORKS_AT', 'PREFERS', 'KNOWS' */
  relation: string
  /** Confidence weight, 0-1 */
  weight: number
  /** Arbitrary typed properties */
  properties: Record<string, unknown>
  scope: typegraphIdentity
  /** Access visibility. Default: 'tenant' (edges are typically shared within org). */
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
