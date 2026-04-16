import { describe, it, expect } from 'vitest'
import { WorkingMemory } from '../working-memory.js'

describe('WorkingMemory', () => {
  it('adds and retrieves items', () => {
    const wm = new WorkingMemory()
    const item = wm.add('Hello world', 'user')
    expect(wm.get(item.id)).toBeDefined()
    expect(wm.get(item.id)!.content).toBe('Hello world')
    expect(wm.size).toBe(1)
  })

  it('removes items', () => {
    const wm = new WorkingMemory()
    const item = wm.add('Hello', 'user')
    expect(wm.remove(item.id)).toBe(true)
    expect(wm.size).toBe(0)
    expect(wm.get(item.id)).toBeUndefined()
  })

  it('clears all items', () => {
    const wm = new WorkingMemory()
    wm.add('One', 'user')
    wm.add('Two', 'assistant')
    wm.clear()
    expect(wm.size).toBe(0)
  })

  it('lists items sorted by priority (highest first)', () => {
    const wm = new WorkingMemory()
    wm.add('Low', 'user', 1)
    wm.add('High', 'user', 10)
    wm.add('Medium', 'user', 5)

    const items = wm.list()
    expect(items[0]!.content).toBe('High')
    expect(items[1]!.content).toBe('Medium')
    expect(items[2]!.content).toBe('Low')
  })

  it('evicts lowest priority item when maxItems exceeded', () => {
    const wm = new WorkingMemory({ maxItems: 3 })
    wm.add('Low', 'user', 1)
    wm.add('Medium', 'user', 5)
    wm.add('High', 'user', 10)
    wm.add('New', 'user', 3) // should evict 'Low'

    expect(wm.size).toBe(3)
    const items = wm.list()
    const contents = items.map(i => i.content)
    expect(contents).not.toContain('Low')
    expect(contents).toContain('New')
    expect(contents).toContain('High')
    expect(contents).toContain('Medium')
  })

  it('evicts oldest item when priorities are equal', () => {
    const wm = new WorkingMemory({ maxItems: 2 })
    const first = wm.add('First', 'user', 1)
    wm.add('Second', 'user', 1)
    wm.add('Third', 'user', 1) // should evict 'First' (oldest, same priority)

    expect(wm.size).toBe(2)
    expect(wm.get(first.id)).toBeUndefined()
  })

  it('evicts to stay within maxTokens', () => {
    const wm = new WorkingMemory({
      maxTokens: 10,
      tokenizer: (text) => text.length, // 1 char = 1 token for simplicity
    })
    wm.add('12345', 'user', 1)  // 5 tokens
    wm.add('67890', 'user', 2)  // 5 tokens - total 10, at limit
    wm.add('abcde', 'user', 3)  // 5 tokens - exceeds, evicts lowest priority

    expect(wm.size).toBe(2)
    const items = wm.list()
    const contents = items.map(i => i.content)
    expect(contents).not.toContain('12345') // evicted (priority 1)
    expect(contents).toContain('67890')
    expect(contents).toContain('abcde')
  })

  it('calculates tokenCount correctly', () => {
    const wm = new WorkingMemory({
      tokenizer: (text) => text.length,
    })
    wm.add('Hello', 'user')  // 5
    wm.add('World', 'assistant')  // 5
    expect(wm.tokenCount).toBe(10)
  })

  it('serializes to context string', () => {
    const wm = new WorkingMemory()
    wm.add('I am the system', 'system', 10)
    wm.add('User said hello', 'user', 1)

    const context = wm.toContext()
    expect(context).toContain('[system] I am the system')
    expect(context).toContain('[user] User said hello')
    // system should come first (higher priority)
    expect(context.indexOf('[system]')).toBeLessThan(context.indexOf('[user]'))
  })

  it('returns empty string for toContext when empty', () => {
    const wm = new WorkingMemory()
    expect(wm.toContext()).toBe('')
  })

  it('evict returns undefined on empty', () => {
    const wm = new WorkingMemory()
    expect(wm.evict()).toBeUndefined()
  })

  it('evict returns the evicted item', () => {
    const wm = new WorkingMemory()
    wm.add('Only item', 'user', 1)
    const evicted = wm.evict()
    expect(evicted).toBeDefined()
    expect(evicted!.content).toBe('Only item')
    expect(wm.size).toBe(0)
  })

  it('stores metadata on items', () => {
    const wm = new WorkingMemory()
    const item = wm.add('With meta', 'tool', 5, { source: 'api', toolName: 'search' })
    expect(item.metadata).toEqual({ source: 'api', toolName: 'search' })
  })
})
