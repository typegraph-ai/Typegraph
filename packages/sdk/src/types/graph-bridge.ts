import type { typegraphIdentity } from './identity.js'
import type { ConversationTurnResult, MemoryHealthReport } from './memory.js'
import type { MemoryRecord } from '../memory/types/memory.js'
import type { PaginationOpts } from './pagination.js'

/**
 * Memory bridge — conversational memory operations (remember, recall, forget, correct).
 * Independent of the knowledge graph. Use this when you only need memory without entity graphs.
 */
export interface MemoryBridge {
  /** Deploy memory tables. Called by typegraph.deploy() when memory is configured. */
  deploy?(): Promise<void>

  /** Store a memory. LLM extracts triples → memory record. */
  remember(content: string, identity: typegraphIdentity, category?: string, opts?: {
    importance?: number
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord>

  /** Invalidate a memory. Caller must prove ownership via identity. */
  forget(id: string, identity: typegraphIdentity): Promise<void>

  /** Apply a natural language correction (e.g., "Actually, Alice works at Beta Inc now"). */
  correct(correction: string, identity: typegraphIdentity): Promise<{ invalidated: number; created: number; summary: string }>

  /** Ingest a conversation turn with extraction. */
  addConversationTurn(
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
    identity: typegraphIdentity,
    conversationId?: string
  ): Promise<ConversationTurnResult>

  /** Recall memories by semantic similarity. */
  recall(query: string, identity: typegraphIdentity, opts?: {
    limit?: number
    types?: string[]
    /** Only return memories valid at this timestamp. */
    temporalAt?: Date
    /** Include invalidated/expired memories. Default: false. */
    includeInvalidated?: boolean
  }): Promise<MemoryRecord[]>

  /** Recall memories using hybrid search (vector + BM25 keyword).
   *  When the memory store supports it, uses RRF to fuse vector and keyword results.
   *  Falls back to vector-only recall if not implemented. */
  recallHybrid?(query: string, identity: typegraphIdentity, opts?: {
    limit?: number
    types?: string[]
    temporalAt?: Date
    includeInvalidated?: boolean
  }): Promise<MemoryRecord[]>

  /** Build an LLM-ready context string from memories. */
  buildMemoryContext?(query: string, identity: typegraphIdentity, opts?: {
    includeWorking?: boolean
    includeFacts?: boolean
    includeEpisodes?: boolean
    includeProcedures?: boolean
    maxMemoryTokens?: number
    format?: 'xml' | 'markdown' | 'plain'
  }): Promise<string>

  /** Get memory system health statistics. */
  healthCheck?(identity: typegraphIdentity): Promise<MemoryHealthReport>

  /** Check if the memory store has any active memories. Used to skip memory runner when empty. */
  hasMemories?(): Promise<boolean>
}

/**
 * Knowledge graph bridge — entity-relationship graph for document retrieval.
 * Stores entities and edges extracted during indexing, provides PPR-based retrieval.
 * Independent of conversational memory.
 */
export interface KnowledgeGraphBridge {
  /** Deploy graph tables (entities, edges). Called by typegraph.deploy() when graph is configured. */
  deploy?(): Promise<void>

  /** Store an extracted triple in the entity graph. Used during document indexing. */
  addTriple?(triple: {
    subject: string
    subjectType?: string
    subjectAliases?: string[]
    subjectDescription?: string
    predicate: string
    object: string
    objectType?: string
    objectAliases?: string[]
    objectDescription?: string
    confidence?: number
    content: string
    bucketId: string
    chunkIndex?: number
    documentId?: string
    metadata?: Record<string, unknown>
  }): Promise<void>

  /** Search entities by embedding similarity. Used during graph-augmented retrieval. */
  searchEntities?(query: string, identity: typegraphIdentity, limit?: number): Promise<Array<{ id: string; name: string; entityType: string; similarity?: number }>>

  /** Get adjacency list for PPR. */
  getAdjacencyList?(entityIds: string[]): Promise<Map<string, Array<{ target: string; weight: number }>>>

  /** Get chunk content associated with entities. */
  getChunksForEntities?(entityIds: string[], limit?: number, pprScores?: Map<string, number>): Promise<Array<{ content: string; bucketId: string; score: number; documentId?: string; chunkIndex?: number; metadata?: Record<string, unknown> }>>

  // ── Graph exploration methods ──

  /** Get a single entity by ID. */
  getEntity?(id: string): Promise<EntityDetail | null>

  /** Get edges for an entity. */
  getEdges?(entityId: string, opts?: {
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  }): Promise<EdgeResult[]>

  /** Extract a subgraph around seed entities or a query. */
  getSubgraph?(opts: SubgraphOpts): Promise<SubgraphResult>

  /** Get graph-level statistics. */
  getGraphStats?(identity: typegraphIdentity): Promise<GraphStats>

  /** Get all relation types in the graph with counts. */
  getRelationTypes?(identity: typegraphIdentity): Promise<Array<{ relation: string; count: number }>>

  /** Get all entity types in the graph with counts. */
  getEntityTypes?(identity: typegraphIdentity): Promise<Array<{ entityType: string; count: number }>>
}

// ── Graph exploration types ──

export interface EntityResult {
  id: string
  name: string
  entityType: string
  aliases: string[]
  /** Present when searched by query. */
  similarity?: number | undefined
  /** Number of edges (degree centrality). */
  edgeCount: number
  properties?: Record<string, unknown> | undefined
}

export interface EntityDetail extends EntityResult {
  description?: string | undefined
  createdAt: Date
  validAt?: Date | undefined
  invalidAt?: Date | undefined
  /** Top edges by weight. */
  topEdges: EdgeResult[]
}

export interface EdgeResult {
  id: string
  sourceEntityId: string
  sourceEntityName: string
  targetEntityId: string
  targetEntityName: string
  relation: string
  weight: number
  bucketId?: string | undefined
  documentId?: string | undefined
  properties?: Record<string, unknown> | undefined
}

export interface SubgraphOpts {
  /** Seed entities to expand from. */
  entityIds?: string[] | undefined
  /** Or search by text to find seed entities. */
  query?: string | undefined
  identity: typegraphIdentity
  /** Expansion hops from seeds. Default: 1, max: 3. */
  depth?: number | undefined
  /** Max total entities. Default: 100. */
  limit?: number | undefined
  /** Filter weak edges. Default: 0. */
  minWeight?: number | undefined
  /** Filter by entity type. */
  entityTypes?: string[] | undefined
  /** Filter by relation type. */
  relations?: string[] | undefined
}

export interface SubgraphResult {
  entities: Array<EntityResult & {
    /** Visual size based on degree centrality. */
    size: number
  }>
  edges: Array<EdgeResult & {
    /** Visual thickness based on weight. */
    thickness: number
  }>
  stats: {
    entityCount: number
    edgeCount: number
    avgDegree: number
    /** Number of connected components. */
    components: number
  }
}

export interface GraphStats {
  totalEntities: number
  totalEdges: number
  avgEdgesPerEntity: number
  topEntityTypes: Array<{ entityType: string; count: number }>
  topRelations: Array<{ relation: string; count: number }>
  degreeDistribution: Array<{ degree: number; count: number }>
}
