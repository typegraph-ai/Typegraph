import { generateId } from '../utils/id.js'

// ── Working Memory Item ──

export interface WorkingMemoryItem {
  id: string
  content: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Higher priority = evicted last */
  priority: number
  addedAt: Date
  /** Approximate token count */
  tokens?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

// ── Working Memory Config ──

export interface WorkingMemoryConfig {
  /** Maximum number of items in working memory. Default: 20 */
  maxItems?: number | undefined
  /** Maximum total tokens. If set, items are evicted when total exceeds this. */
  maxTokens?: number | undefined
  /** Custom tokenizer. Default: rough approximation of 1 token per 4 chars. */
  tokenizer?: ((text: string) => number) | undefined
}

// ── Default tokenizer ──

function defaultTokenizer(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Working Memory ──
// Bounded in-memory buffer inspired by cognitive science (~7±2 items).
// Items are evicted by lowest priority first, then oldest first.

export class WorkingMemory {
  private items = new Map<string, WorkingMemoryItem>()
  private readonly maxItems: number
  private readonly maxTokens: number | undefined
  private readonly tokenizer: (text: string) => number

  constructor(config?: WorkingMemoryConfig) {
    this.maxItems = config?.maxItems ?? 20
    this.maxTokens = config?.maxTokens
    this.tokenizer = config?.tokenizer ?? defaultTokenizer
  }

  /**
   * Add an item to working memory. Returns the created item.
   * If capacity is exceeded, the lowest-priority (then oldest) item is evicted.
   */
  add(
    content: string,
    role: WorkingMemoryItem['role'],
    priority: number = 0,
    metadata?: Record<string, unknown>,
  ): WorkingMemoryItem {
    const item: WorkingMemoryItem = {
      id: generateId('wmem'),
      content,
      role,
      priority,
      addedAt: new Date(),
      tokens: this.tokenizer(content),
      metadata,
    }

    this.items.set(item.id, item)
    this.enforceCapacity()
    return item
  }

  /**
   * Remove an item by ID.
   */
  remove(id: string): boolean {
    return this.items.delete(id)
  }

  /**
   * Get an item by ID.
   */
  get(id: string): WorkingMemoryItem | undefined {
    return this.items.get(id)
  }

  /**
   * List all items, ordered by priority (highest first), then by addedAt (newest first).
   */
  list(): WorkingMemoryItem[] {
    return [...this.items.values()].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      return b.addedAt.getTime() - a.addedAt.getTime()
    })
  }

  /**
   * Clear all items from working memory.
   */
  clear(): void {
    this.items.clear()
  }

  /**
   * Number of items currently in working memory.
   */
  get size(): number {
    return this.items.size
  }

  /**
   * Total approximate token count across all items.
   */
  get tokenCount(): number {
    let total = 0
    for (const item of this.items.values()) {
      total += item.tokens ?? this.tokenizer(item.content)
    }
    return total
  }

  /**
   * Serialize working memory contents into a string for LLM context injection.
   * Items are ordered by priority (highest first).
   */
  toContext(): string {
    const items = this.list()
    if (items.length === 0) return ''

    const lines = items.map(item => `[${item.role}] ${item.content}`)
    return lines.join('\n')
  }

  /**
   * Evict the lowest-priority, oldest item. Returns the evicted item or undefined.
   */
  evict(): WorkingMemoryItem | undefined {
    if (this.items.size === 0) return undefined

    // Find the item with lowest priority, then oldest addedAt
    let victim: WorkingMemoryItem | undefined
    for (const item of this.items.values()) {
      if (
        !victim ||
        item.priority < victim.priority ||
        (item.priority === victim.priority && item.addedAt < victim.addedAt)
      ) {
        victim = item
      }
    }

    if (victim) {
      this.items.delete(victim.id)
    }
    return victim
  }

  /**
   * Enforce capacity limits by evicting items until within bounds.
   */
  private enforceCapacity(): void {
    // Enforce item count limit
    while (this.items.size > this.maxItems) {
      this.evict()
    }

    // Enforce token limit if configured
    if (this.maxTokens !== undefined) {
      while (this.tokenCount > this.maxTokens && this.items.size > 0) {
        this.evict()
      }
    }
  }
}
