import { describe, expect, it } from 'vitest'
import { CoreferenceContextManager } from '../index-engine/coreference-context.js'
import { compileOntology } from '../index-engine/ontology.js'

describe('CoreferenceContextManager', () => {
  it('passes a small active context instead of dumping the whole cache', () => {
    const entities = Array.from({ length: 80 }, (_, index) => ({
      name: `Entity ${index}`,
      type: 'concept',
      aliases: [`E${index}`],
      description: `Entity ${index}`,
    }))
    const manager = new CoreferenceContextManager(entities, { promptTarget: 25, promptLimit: 40 })

    const active = manager.activeContextForChunk('Entity 70 and Entity 71 are important here.', 40)!

    expect(active.length).toBeLessThanOrEqual(40)
    expect(active.map(entity => entity.name)).toEqual(expect.arrayContaining(['Entity 70', 'Entity 71']))
  })

  it('allows new relevant entities to enter context after early chunks', () => {
    const manager = new CoreferenceContextManager([], { promptTarget: 5, promptLimit: 8 })
    for (let index = 0; index < 100; index++) {
      manager.update([{ name: `Early ${index}`, type: 'concept', aliases: [] }], index)
    }

    manager.update([{ name: 'Late Important Entity', type: 'concept', aliases: ['LIE'] }], 101)
    const active = manager.activeContextForChunk('The next chunk mentions Late Important Entity.', 102)!

    expect(active.map(entity => entity.name)).toContain('Late Important Entity')
    expect(active.length).toBeLessThanOrEqual(8)
  })

  it('removes bad aliases before cache save', () => {
    const ontology = compileOntology({ version: 'literary-test', profiles: ['literary'] })
    const manager = new CoreferenceContextManager([], { ontology })
    manager.update([
      { name: 'Mexico', type: 'place', aliases: ['Mexico, Guatemala', 'Guatemala', 'Egpptian[TN-3]'] },
      { name: 'Guatemala', type: 'place', aliases: ['Mexico'] },
      { name: 'Cairo, Egypt', type: 'place', aliases: ['Cairo'] },
    ], 0)

    const cached = manager.toCacheEntities()
    expect(cached.find(entity => entity.name === 'Mexico')?.aliases ?? []).toEqual([])
    expect(cached.find(entity => entity.name === 'Guatemala')?.aliases ?? []).toEqual([])
    expect(cached.find(entity => entity.name === 'Cairo, Egypt')?.aliases).toEqual(['Cairo'])
  })
})
