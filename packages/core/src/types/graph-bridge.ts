import type { d8umIdentity } from './identity.js'

/**
 * Structural interface for the graph/memory bridge.
 * Core does NOT depend on @d8um/graph — this interface uses pure structural typing.
 * The graph package provides a factory that returns an object matching this shape.
 */
export interface GraphBridge {
  /** Store a memory. LLM extracts triples → entity graph + memory record. */
  remember(content: string, identity: d8umIdentity, category?: string): Promise<unknown>

  /** Invalidate a memory and its associated graph edges. */
  forget(id: string): Promise<void>

  /** Apply a natural language correction (e.g., "Actually, Alice works at Beta Inc now"). */
  correct(correction: string, identity: d8umIdentity): Promise<{ invalidated: number; created: number; summary: string }>

  /** Ingest a conversation turn with extraction. */
  addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: d8umIdentity,
    sessionId?: string
  ): Promise<unknown>

  /** Recall memories by semantic similarity. */
  recall(query: string, identity: d8umIdentity, opts?: { limit?: number; types?: string[] }): Promise<unknown[]>

  /** Store an extracted triple in the entity graph. Used during document indexing. */
  addTriple?(triple: { subject: string; predicate: string; object: string; content: string; bucketId: string; chunkIndex?: number }): Promise<void>

  /** Search entities by embedding similarity. Used during graph-augmented retrieval. */
  searchEntities?(query: string, identity: d8umIdentity, limit?: number): Promise<Array<{ id: string; name: string; entityType: string }>>

  /** Get adjacency list for PPR. */
  getAdjacencyList?(entityIds: string[]): Promise<Map<string, Array<{ target: string; weight: number }>>>

  /** Get chunk content associated with entities. */
  getChunksForEntities?(entityIds: string[], limit?: number, pprScores?: Map<string, number>): Promise<Array<{ content: string; bucketId: string; score: number }>>
}
