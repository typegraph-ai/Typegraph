import { describe, it, expect } from 'vitest'
import { buildScope, scopeKey, scopeMatches, scopeToFilter } from '../types/scope.js'

describe('buildScope', () => {
  it('creates a scope from partial parts', () => {
    const scope = buildScope({ userId: 'alice', conversationId: 's1' })
    expect(scope.userId).toBe('alice')
    expect(scope.conversationId).toBe('s1')
    expect(scope.tenantId).toBeUndefined()
  })

  it('throws when no identifiers are provided', () => {
    expect(() => buildScope({})).toThrow('at least one identifier')
  })

  it('accepts all fields', () => {
    const scope = buildScope({
      tenantId: 'org1',
      groupId: 'team-alpha',
      userId: 'alice',
      agentId: 'agent-1',
      conversationId: 's1',
    })
    expect(scope.tenantId).toBe('org1')
    expect(scope.groupId).toBe('team-alpha')
    expect(scope.userId).toBe('alice')
    expect(scope.agentId).toBe('agent-1')
    expect(scope.conversationId).toBe('s1')
  })
})

describe('scopeKey', () => {
  it('produces a deterministic key', () => {
    const scope = buildScope({ userId: 'alice', tenantId: 'org1' })
    const key1 = scopeKey(scope)
    const key2 = scopeKey(scope)
    expect(key1).toBe(key2)
  })

  it('includes all defined fields', () => {
    const scope = buildScope({ tenantId: 'org1', userId: 'alice', conversationId: 's1' })
    const key = scopeKey(scope)
    expect(key).toContain('t:org1')
    expect(key).toContain('u:alice')
    expect(key).toContain('s:s1')
  })

  it('produces different keys for different scopes', () => {
    const a = scopeKey(buildScope({ userId: 'alice' }))
    const b = scopeKey(buildScope({ userId: 'bob' }))
    expect(a).not.toBe(b)
  })

  it('includes groupId', () => {
    const scope = buildScope({ groupId: 'team-alpha' })
    expect(scopeKey(scope)).toContain('g:team-alpha')
  })
})

describe('scopeMatches', () => {
  it('matches when query is a subset of record', () => {
    const record = buildScope({ tenantId: 'org1', userId: 'alice', conversationId: 's1' })
    const query = buildScope({ userId: 'alice' })
    expect(scopeMatches(record, query)).toBe(true)
  })

  it('does not match when query has a mismatched field', () => {
    const record = buildScope({ userId: 'alice' })
    const query = buildScope({ userId: 'bob' })
    expect(scopeMatches(record, query)).toBe(false)
  })

  it('matches group-level queries across users', () => {
    const record = buildScope({ groupId: 'team-alpha', userId: 'alice' })
    const query = buildScope({ groupId: 'team-alpha' })
    expect(scopeMatches(record, query)).toBe(true)
  })

  it('does not match when query requires a field not present in record', () => {
    const record = buildScope({ userId: 'alice' })
    const query = buildScope({ userId: 'alice', conversationId: 's1' })
    // record has no conversationId, query requires conversationId='s1'
    // record.conversationId is undefined !== 's1'
    expect(scopeMatches(record, query)).toBe(false)
  })

  it('matches when both have the same multi-field scope', () => {
    const scope = buildScope({ tenantId: 'org1', groupId: 'g1', userId: 'alice' })
    expect(scopeMatches(scope, scope)).toBe(true)
  })
})

describe('scopeToFilter', () => {
  it('converts scope to flat record', () => {
    const scope = buildScope({ tenantId: 'org1', userId: 'alice' })
    const filter = scopeToFilter(scope)
    expect(filter).toEqual({ tenantId: 'org1', userId: 'alice' })
  })

  it('omits undefined fields', () => {
    const scope = buildScope({ userId: 'alice' })
    const filter = scopeToFilter(scope)
    expect(Object.keys(filter)).toEqual(['userId'])
  })
})
