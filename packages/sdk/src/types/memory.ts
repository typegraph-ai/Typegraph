/** Result of ingesting a thread turn. */
export interface ThreadTurnResult {
  memoriesCreated: number
  entitiesCreated: number
  edgesCreated: number
}

/** Memory system health statistics. */
export interface MemoryHealthReport {
  totalMemories: number
  activeMemories: number
  invalidatedMemories: number
  consolidatedMemories: number
  /** Fraction of active memories (active / (active + invalidated)), 0-1. */
  memoryPrecision: number
  totalEntities: number
  totalEdges: number
  edgesPerEntity: number
  /** Fraction of active memories below decay threshold. */
  stalenessIndex: number
}
