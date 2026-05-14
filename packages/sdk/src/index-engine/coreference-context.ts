import type { CompiledOntology } from '../types/ontology.js'
import type { EntityContext } from './triple-extractor.js'
import { normalizeEntityText, sanitizeEntityBatch } from './entity-canonicalization.js'

const DEFAULT_CACHE_LIMIT = 240
const DEFAULT_PROMPT_TARGET = 25
const DEFAULT_PROMPT_LIMIT = 40

type StoredContext = EntityContext & {
  firstSeenChunk: number
  lastSeenChunk: number
  mentionHits: number
  order: number
}

export interface CoreferenceContextManagerOptions {
  ontology?: CompiledOntology | undefined
  cacheLimit?: number | undefined
  promptTarget?: number | undefined
  promptLimit?: number | undefined
}

function keyFor(entity: Pick<EntityContext, 'name' | 'type'>): string {
  return `${entity.type}:${normalizeEntityText(entity.name)}`
}

function mergeAliases(existing: string[] = [], incoming: string[] = []): string[] {
  const byKey = new Map<string, string>()
  for (const alias of [...existing, ...incoming]) {
    const key = normalizeEntityText(alias)
    if (key && !byKey.has(key)) byKey.set(key, alias)
  }
  return [...byKey.values()]
}

function chunkMentionsEntity(contentKey: string, entity: EntityContext): boolean {
  const names = [entity.name, ...(entity.aliases ?? [])]
  return names.some(name => {
    const key = normalizeEntityText(name)
    return key.length >= 3 && contentKey.includes(key)
  })
}

export class CoreferenceContextManager {
  private readonly ontology?: CompiledOntology | undefined
  private readonly cacheLimit: number
  private readonly promptTarget: number
  private readonly promptLimit: number
  private readonly entities = new Map<string, StoredContext>()
  private order = 0

  constructor(initial: EntityContext[] = [], options: CoreferenceContextManagerOptions = {}) {
    this.ontology = options.ontology
    this.cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT
    this.promptTarget = options.promptTarget ?? DEFAULT_PROMPT_TARGET
    this.promptLimit = options.promptLimit ?? DEFAULT_PROMPT_LIMIT
    this.update(initial, -1)
  }

  activeContextForChunk(content: string, chunkIndex: number): EntityContext[] | undefined {
    const contentKey = normalizeEntityText(content)
    const scored = [...this.entities.values()].map(entity => {
      const mentioned = chunkMentionsEntity(contentKey, entity)
      const recentDistance = chunkIndex >= 0 && entity.lastSeenChunk >= 0
        ? Math.max(0, chunkIndex - entity.lastSeenChunk)
        : Number.POSITIVE_INFINITY
      let score = 0
      if (mentioned) score += 1000
      if (recentDistance <= 1) score += 120
      else if (recentDistance === 2) score += 80
      score += Math.min(entity.mentionHits, 10) * 5
      if (Number.isFinite(recentDistance)) score -= Math.max(0, recentDistance - 2) * 2
      return { entity, score }
    })

    const selected = scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entity.lastSeenChunk - a.entity.lastSeenChunk || a.entity.order - b.entity.order)
      .slice(0, this.promptLimit)

    if (selected.length < this.promptTarget) {
      const selectedKeys = new Set(selected.map(item => keyFor(item.entity)))
      for (const item of scored
        .filter(candidate => !selectedKeys.has(keyFor(candidate.entity)))
        .sort((a, b) => b.entity.lastSeenChunk - a.entity.lastSeenChunk || a.entity.order - b.entity.order)) {
        selected.push(item)
        selectedKeys.add(keyFor(item.entity))
        if (selected.length >= this.promptTarget) break
      }
    }

    if (selected.length === 0) return undefined
    return selected
      .sort((a, b) => a.entity.order - b.entity.order)
      .map(({ entity }) => this.toPublicContext(entity))
  }

  update(entities: EntityContext[], chunkIndex: number): void {
    const cleaned = sanitizeEntityBatch(entities, this.ontology)
    for (const entity of cleaned) {
      const key = keyFor(entity)
      if (!key) continue
      const existing = this.entities.get(key)
      if (existing) {
        existing.description = existing.description ?? entity.description
        existing.typeCandidates = entity.typeCandidates ?? existing.typeCandidates
        existing.aliases = sanitizeEntityBatch([{ ...existing, aliases: mergeAliases(existing.aliases, entity.aliases) }], this.ontology)[0]?.aliases ?? []
        existing.lastSeenChunk = Math.max(existing.lastSeenChunk, chunkIndex)
        existing.mentionHits += 1
      } else {
        this.entities.set(key, {
          ...entity,
          aliases: entity.aliases ?? [],
          firstSeenChunk: chunkIndex,
          lastSeenChunk: chunkIndex,
          mentionHits: 1,
          order: this.order++,
        })
      }
    }
    this.compact()
  }

  toCacheEntities(): EntityContext[] {
    return [...this.entities.values()]
      .sort((a, b) => a.order - b.order)
      .map(entity => this.toPublicContext(entity))
  }

  get size(): number {
    return this.entities.size
  }

  private compact(): void {
    if (this.entities.size <= this.cacheLimit) return
    const keep = [...this.entities.values()]
      .sort((a, b) => b.lastSeenChunk - a.lastSeenChunk || b.mentionHits - a.mentionHits || a.order - b.order)
      .slice(0, this.cacheLimit)
    this.entities.clear()
    for (const entity of keep.sort((a, b) => a.order - b.order)) {
      this.entities.set(keyFor(entity), entity)
    }
  }

  private toPublicContext(entity: StoredContext): EntityContext {
    const context: EntityContext = {
      name: entity.name,
      type: entity.type,
    }
    if (entity.typeCandidates) context.typeCandidates = entity.typeCandidates
    if (entity.description) context.description = entity.description
    if ((entity.aliases?.length ?? 0) > 0) context.aliases = entity.aliases
    return context
  }
}
