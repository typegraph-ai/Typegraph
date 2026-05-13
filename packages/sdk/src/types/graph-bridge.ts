import type { AccessScope, TypeGraphOptions, typegraphIdentity } from './identity.js'
import type { MemoryHealthReport } from './memory.js'
import type { ExternalId } from '../memory/types/memory.js'
import type { ChunkRef } from './chunk.js'
import type { QueryEntityScope, RetrievalSwitches } from './query.js'
import type { PaginationOpts } from './pagination.js'
import type { TelemetryOpts } from './events.js'
import type { PredicateTemporalStatus } from '../index-engine/ontology.js'
import type { TypeCandidate } from '../index-engine/ontology.js'

export interface RememberOpts extends TypeGraphOptions {
  category?: string | undefined
  importance?: number | undefined
  metadata?: Record<string, unknown> | undefined
  subject?: MemorySubject | undefined
  relatedEntities?: MemorySubject[] | undefined
  graphExtraction?: boolean | undefined
}

export interface ForgetOpts extends TypeGraphOptions {}

export interface CorrectOpts extends TypeGraphOptions {
  subject?: MemorySubject | undefined
  relatedEntities?: MemorySubject[] | undefined
  graphExtraction?: boolean | undefined
}

export interface RecallOpts extends TypeGraphOptions {
  limit?: number | undefined
  types?: string[] | undefined
  /** Only return memories valid at this timestamp. */
  temporalAt?: Date | undefined
  /** Include invalidated/expired memories. Default: false. */
  includeInvalidated?: boolean | undefined
  entityScope?: QueryEntityScope | undefined
  /** Format results as a string instead of an array. When set, `recall` returns `Promise<string>`. */
  format?: 'xml' | 'markdown' | 'plain' | undefined
}

export interface HealthCheckOpts extends TypeGraphOptions {}

export interface MemorySubject {
  entityId?: string | undefined
  externalIds?: ExternalId[] | undefined
  name?: string | undefined
  entityType?: string | undefined
  typeCandidates?: TypeCandidate[] | undefined
  aliases?: string[] | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface GraphEntityRef {
  /** Existing TypeGraph entity ID. */
  id?: string | undefined
  /** Deterministic identifier lookup. Takes priority over name/fuzzy matching. */
  externalId?: ExternalId | undefined
  /** Deterministic identifiers to attach or use for lookup. */
  externalIds?: ExternalId[] | undefined
  /** Entity name. Required when the reference must create a new entity. */
  name?: string | undefined
  entityType?: string | undefined
  typeCandidates?: TypeCandidate[] | undefined
  aliases?: string[] | undefined
  description?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface UpsertGraphEntityInput {
  id?: string | undefined
  name: string
  entityType?: string | undefined
  typeCandidates?: TypeCandidate[] | undefined
  aliases?: string[] | undefined
  description?: string | undefined
  metadata?: Record<string, unknown> | undefined
  externalIds?: ExternalId[] | undefined
}

export interface UpsertGraphEdgeInput {
  /** Entity ref. A bare string reuses an existing entity ID when found, otherwise seeds by name. */
  source: GraphEntityRef | string
  /** Entity ref. A bare string reuses an existing entity ID when found, otherwise seeds by name. */
  target: GraphEntityRef | string
  relation: string
  weight?: number | undefined
  metadata?: Record<string, unknown> | undefined
  description?: string | undefined
  evidenceText?: string | undefined
  temporalStatus?: PredicateTemporalStatus | undefined
  validFrom?: string | undefined
  validTo?: string | undefined
  chunkId?: string | undefined
}

export interface UpsertGraphFactInput {
  /** Entity ref. A bare string reuses an existing entity ID when found, otherwise seeds by name. */
  source: GraphEntityRef | string
  /** Entity ref. A bare string reuses an existing entity ID when found, otherwise seeds by name. */
  target: GraphEntityRef | string
  relation: string
  description?: string | undefined
  evidenceText?: string | undefined
  temporalStatus?: PredicateTemporalStatus | undefined
  validFrom?: string | undefined
  validTo?: string | undefined
  chunkId?: string | undefined
  confidence?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface MergeGraphEntitiesInput {
  sourceEntityId: string
  targetEntityId: string
  metadata?: Record<string, unknown> | undefined
}

export interface MergeGraphEntitiesResult {
  target: EntityDetail
  sourceEntityId: string
  targetEntityId: string
  redirectedEdges: number
  redirectedFacts: number
  redirectedGraphEdges: number
  movedMentions: number
  movedExternalIds: number
  removedSelfEdges: number
}

export interface DeleteGraphEntityOpts {
  mode?: 'invalidate' | 'purge' | undefined
}

export interface DeleteGraphEntityResult {
  entityId: string
  mode: 'invalidate' | 'purge'
  deletedEdges: number
  deletedFacts: number
  deletedGraphEdges: number
  deletedMentions: number
  deletedExternalIds: number
}

/**
 * Internal graph storage service — entity-relationship graph for document retrieval.
 * Stores entities and edges extracted during indexing, provides PPR-based retrieval.
 * Independent of explicit memory storage.
 */
export interface KnowledgeGraphBridge {
  /** Deploy graph tables (entities, edges). Called by typegraph.deploy() when graph is configured. */
  deploy?(): Promise<void>

  /** Store an extracted triple in the entity graph. Used during document indexing. */
  addTriple?(triple: {
    subject: string
    subjectType?: string
    subjectTypeCandidates?: TypeCandidate[] | undefined
    subjectAliases?: string[]
    subjectDescription?: string | undefined
    predicate: string
    object: string
    objectType?: string
    objectTypeCandidates?: TypeCandidate[] | undefined
    objectAliases?: string[]
    objectDescription?: string | undefined
    relationshipDescription?: string | undefined
    evidenceText?: string | undefined
    temporalStatus?: PredicateTemporalStatus | undefined
    validFrom?: string | undefined
    validTo?: string | undefined
    chunkId?: string | undefined
    confidence?: number | undefined
    content: string
    bucketId: string
    chunkIndex?: number
    documentId?: string
    tenantId?: string | undefined
    organizationId?: string | undefined
    graphId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    threadId?: string | undefined
    accessScope?: AccessScope | undefined
    metadata?: Record<string, unknown>
  }): Promise<void>

  /** Create or update a deterministic developer-seeded entity. */
  upsertEntity?(input: UpsertGraphEntityInput): Promise<EntityDetail>

  /** Create or update many deterministic developer-seeded entities. */
  upsertEntities?(inputs: UpsertGraphEntityInput[]): Promise<EntityDetail[]>

  /** Resolve an entity by TypeGraph ID, external ID, or scoped name lookup. */
  resolveEntity?(ref: GraphEntityRef | string, identity?: typegraphIdentity): Promise<EntityDetail | null>

  /** Attach deterministic external IDs to an existing entity. */
  linkExternalIds?(entityId: string, externalIds: ExternalId[], identity?: typegraphIdentity): Promise<EntityDetail>

  /** Merge a duplicate source entity into a surviving target entity and rewrite graph references. */
  mergeEntities?(input: MergeGraphEntitiesInput): Promise<MergeGraphEntitiesResult>

  /** Invalidate or purge an entity and its graph references without deleting chunks/documents/memories. */
  deleteEntity?(entityId: string, opts?: DeleteGraphEntityOpts | null): Promise<DeleteGraphEntityResult>

  /** Create or update a deterministic developer-seeded edge. */
  upsertEdge?(input: UpsertGraphEdgeInput): Promise<EdgeResult>

  /** Create or update many deterministic developer-seeded edges. */
  upsertEdges?(inputs: UpsertGraphEdgeInput[]): Promise<EdgeResult[]>

  /** Create or update a developer-seeded fact and its backing edge/fact record. */
  upsertFact?(input: UpsertGraphFactInput): Promise<FactResult>

  /** Create or update many developer-seeded facts. */
  upsertFacts?(inputs: UpsertGraphFactInput[]): Promise<FactResult[]>

  /** Store extracted entities and their source mentions even when no relationship was found. */
  addEntityMentions?(mentions: Array<{
    name: string
    type?: string | undefined
    typeCandidates?: TypeCandidate[] | undefined
    aliases?: string[] | undefined
    description?: string | undefined
    content: string
    bucketId: string
    chunkIndex?: number | undefined
    documentId?: string | undefined
    tenantId?: string | undefined
    organizationId?: string | undefined
    graphId?: string | undefined
    groupId?: string | undefined
    userId?: string | undefined
    agentId?: string | undefined
    threadId?: string | undefined
    accessScope?: AccessScope | undefined
    metadata?: Record<string, unknown> | undefined
    confidence?: number | undefined
  }>): Promise<void>

  /** Search entities for query seeding and graph exploration. */
  searchEntities?(query: string, identity: typegraphIdentity, limit?: number): Promise<EntityResult[]>

  /** Search persisted facts by semantic similarity. */
  searchFacts?(query: string, opts?: InternalFactSearchOpts | null): Promise<FactResult[]>

  /** Explore a semantic subgraph using anchor resolution and predicate-first intent parsing. */
  explore?(query: string, opts?: InternalGraphExploreOpts | null): Promise<GraphExploreResult>

  /** Resolve entity/external-ID scope to concrete graph and chunk anchors. */
  resolveEntityScope?(scope: QueryEntityScope, identity: typegraphIdentity, opts?: {
    bucketIds?: string[] | undefined
    limit?: number | undefined
  } | null): Promise<EntityScopeResolution>

  /** Search direct facts/entities without graph traversal. */
  searchKnowledge?(query: string, identity: typegraphIdentity, opts?: KnowledgeSearchOpts | null): Promise<KnowledgeSearchResult>

  /** Retrieve chunks directly connected to an entity. */
  getChunksForEntity?(entityId: string, opts?: ({
    bucketIds?: string[] | undefined
    limit?: number | undefined
  } & typegraphIdentity) | null): Promise<ChunkResult[]>

  /** Run heterogeneous graph traversal and return ranked chunks. */
  searchGraphChunks?(query: string, identity: typegraphIdentity, opts?: GraphSearchOpts | null): Promise<GraphSearchResult>

  /** Explain a heterogeneous graph query without changing retrieval behavior. */
  explainQuery?(query: string, opts?: InternalGraphExplainOpts | null): Promise<GraphSearchTrace>

  /** Backfill entity-chunk graph edges and fact records from existing indexed graph data. */
  backfill?(identity: typegraphIdentity, opts?: GraphBackfillOpts | null): Promise<GraphBackfillResult>

  // ── Graph exploration methods ──

  /** Get a single entity by ID. */
  getEntity?(id: string, opts?: typegraphIdentity | null): Promise<EntityDetail | null>

  /** Get edges for an entity. */
  getEdges?(entityId: string, opts?: ({
    direction?: 'in' | 'out' | 'both'
    relation?: string
    limit?: number
  } & typegraphIdentity) | null): Promise<EdgeResult[]>

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
  externalIds?: ExternalId[] | undefined
  /** Present when searched by query. */
  similarity?: number | undefined
  /** Number of edges (degree centrality). */
  edgeCount: number
  metadata?: Record<string, unknown> | undefined
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
  metadata?: Record<string, unknown> | undefined
}

export interface FactResult {
  id: string
  edgeId: string
  sourceEntityId: string
  sourceEntityName?: string | undefined
  targetEntityId: string
  targetEntityName?: string | undefined
  relation: string
  description?: string | undefined
  evidenceText?: string | undefined
  chunkId?: string | undefined
  weight: number
  similarity?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

export type FactRelevanceFilter = (query: string, facts: FactResult[]) => Promise<string[]>

export interface FactSearchOpts extends TypeGraphOptions {
  limit?: number | undefined
}

export type InternalFactSearchOpts = {
  limit?: number | undefined
} & typegraphIdentity & TelemetryOpts

export interface EntityScopeResolution {
  entityIds: string[]
  chunkRefs: ChunkRef[]
  warnings?: string[] | undefined
}

export interface KnowledgeSearchOpts {
  count?: number | undefined
  retrieval?: Pick<RetrievalSwitches, 'semantic' | 'keyword'> | undefined
  entityScope?: QueryEntityScope | undefined
  resolvedEntityIds?: string[] | undefined
}

export interface KnowledgeSearchResult {
  facts: FactResult[]
  entities: EntityResult[]
}

export interface GraphExploreOptions {
  intentParser?: GraphIntentParserMode | undefined
  include?: {
    entities?: boolean | undefined
    facts?: boolean | undefined
    chunks?: boolean | undefined
  } | undefined
  bucketIds?: string[] | undefined
  anchorLimit?: number | undefined
  entityLimit?: number | undefined
  factLimit?: number | undefined
  chunkLimit?: number | undefined
  depth?: 1 | 2 | undefined
  explain?: boolean | undefined
}

export type GraphExploreOpts = GraphExploreOptions & TypeGraphOptions

export type InternalGraphExploreOpts = GraphExploreOptions & typegraphIdentity & TelemetryOpts

export type GraphIntentParserMode = 'deterministic' | 'llm' | 'none'

export interface GraphQueryIntentPredicate {
  name: string
  confidence: number
  symmetric?: boolean | undefined
}

export interface GraphQueryIntent {
  rawQuery: string
  sourceEntityQueries: string[]
  targetEntityQueries: string[]
  predicates: GraphQueryIntentPredicate[]
  subqueries: string[]
  mode: 'fact' | 'relationship' | 'summary' | 'creative'
  strictness: 'strict' | 'soft' | 'none'
}

export type GraphExploreIntentPredicate = GraphQueryIntentPredicate
export type GraphExploreIntent = GraphQueryIntent

export interface ParsedGraphQueryIntent {
  parser: 'deterministic' | 'llm' | 'none'
  intent: GraphQueryIntent
  matchedPatterns?: string[] | undefined
  rejectedPredicates?: string[] | undefined
  parseMs?: number | undefined
}

export interface GraphExploreTrace {
  parser: 'deterministic' | 'llm' | 'none'
  mode: GraphQueryIntent['mode']
  strictness: GraphQueryIntent['strictness']
  selectedPredicates: string[]
  sourceEntityQueries: string[]
  targetEntityQueries: string[]
  subqueries: string[]
  intentParseMs?: number | undefined
  intentMatchedPatterns?: string[] | undefined
  rejectedPredicates?: string[] | undefined
  anchorCandidates: EntityResult[]
  selectedAnchorIds: string[]
  matchedEdgeIds: string[]
  matchedRelations: string[]
  droppedByPredicate: number
  droppedByDirection: number
  droppedByType: number
}

export interface GraphExploreResult {
  intent: GraphExploreIntent
  anchors: EntityResult[]
  entities: EntityResult[]
  facts: FactResult[]
  chunks?: ChunkResult[] | undefined
  trace?: GraphExploreTrace | undefined
}

export interface ChunkResult extends ChunkRef {
  content: string
  totalChunks?: number | undefined
  score: number
  metadata?: Record<string, unknown> | undefined
  tenantId?: string | undefined
  groupId?: string | undefined
  userId?: string | undefined
  agentId?: string | undefined
  threadId?: string | undefined
}

export type GraphSearchProfile = 'fact-filtered-narrow'

export interface GraphSearchOpts {
  intentParser?: GraphIntentParserMode | undefined
  profile?: GraphSearchProfile | undefined
  count?: number | undefined
  bucketIds?: string[] | undefined
  entityScope?: QueryEntityScope | undefined
  resolvedEntityIds?: string[] | undefined
  restartProbability?: number | undefined
  chunkSeedWeight?: number | undefined
  entitySeedWeight?: number | undefined
  factCandidateLimit?: number | undefined
  factFilterInputLimit?: number | undefined
  factSeedLimit?: number | undefined
  chunkSeedLimit?: number | undefined
  maxExpansionEdgesPerEntity?: number | undefined
  maxPprIterations?: number | undefined
  minPprScore?: number | undefined
  factFilter?: boolean | undefined
  factChainLimit?: number | undefined
}

export interface FactChainResult {
  facts: FactResult[]
  content: string
  score: number
  entityIds: string[]
}

export type GraphExplainOpts = GraphSearchOpts & TypeGraphOptions

export type InternalGraphExplainOpts = GraphSearchOpts & typegraphIdentity & TelemetryOpts

export interface GraphSearchTrace {
  intent?: GraphQueryIntent | undefined
  parser?: 'deterministic' | 'llm' | 'none' | undefined
  intentParseMs?: number | undefined
  intentMatchedPatterns?: string[] | undefined
  rejectedPredicates?: string[] | undefined
  entitySeedCount: number
  factSeedCount: number
  chunkSeedCount: number
  graphNodeCount: number
  graphEdgeCount: number
  pprNonzeroCount: number
  candidatesBeforeMerge: number
  candidatesAfterMerge: number
  topGraphScores: number[]
  selectedFactIds: string[]
  selectedEntityIds: string[]
  selectedChunkIds: string[]
  finalChunkIds?: string[] | undefined
  selectedFactTexts?: Array<{ id: string; content: string }> | undefined
  selectedEntityNames?: Array<{ id: string; content: string }> | undefined
  selectedFactChains?: Array<{ content: string; score: number; factIds: string[] }> | undefined
}

export interface GraphSearchResult {
  results: ChunkResult[]
  facts: FactResult[]
  entities: EntityResult[]
  factChains?: FactChainResult[] | undefined
  trace: GraphSearchTrace
}

export interface GraphBackfillOpts {
  bucketIds?: string[] | undefined
  batchSize?: number | undefined
  entityChunkEdges?: boolean | undefined
  facts?: boolean | undefined
  entityProfiles?: boolean | undefined
}

export interface GraphBackfillResult {
  entityChunkEdgesUpserted: number
  factRecordsUpserted: number
  entityProfilesUpdated: number
  batches: number
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
  /** OpenTelemetry trace ID for distributed tracing correlation. */
  traceId?: string | undefined
  /** OpenTelemetry span ID for distributed tracing correlation. */
  spanId?: string | undefined
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
