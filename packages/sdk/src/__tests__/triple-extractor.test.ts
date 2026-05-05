import { describe, it, expect, vi } from 'vitest'
import { TripleExtractor } from '../index-engine/triple-extractor.js'
import type { KnowledgeGraphBridge, LLMProvider } from '../types/index.js'

function mockLLM(output: unknown): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue(output),
  }
}

describe('TripleExtractor', () => {
  it('preserves complete person surface forms as aliases and entity mentions', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Cæsar Simon',
            type: 'person',
            description: 'The true name of the character referred to as Conway.',
            aliases: ['Conway', 'Cousin Cæsar'],
          },
          {
            name: 'Steve Sharp',
            type: 'person',
            description: 'Partner of Cole Conway.',
            aliases: ['Sharp'],
          },
        ],
        relationships: [
          {
            subject: 'Cæsar Simon',
            predicate: 'collaborated_with',
            object: 'Steve Sharp',
            confidence: 0.9,
            description: 'Cæsar Simon and Steve Sharp were companions in Paducah.',
            evidenceText: 'in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'At twenty years of age Cousin Cæsar was in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp.',
      'bucket-1',
      0,
      'doc-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chk-1',
    )

    expect(graph.addEntityMentions).toHaveBeenCalled()
    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions[0]).toEqual(expect.objectContaining({
      name: 'Cæsar Simon',
      aliases: expect.arrayContaining(['Cole Conway', 'Conway', 'Cousin Cæsar']),
    }))
    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Cæsar Simon',
      subjectAliases: expect.arrayContaining(['Cole Conway']),
      object: 'Steve Sharp',
      relationshipDescription: 'Cæsar Simon and Steve Sharp were companions in Paducah.',
      evidenceText: 'in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp',
      sourceChunkId: 'chk-1',
    }))
  })

  it('filters sentence-fragment person aliases and promotes full location spans', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Cousin Cæsar',
            type: 'person',
            description: 'A man who uses the pseudonym Cole Conway.',
            aliases: [
              'Cousin Caeser',
              'Cæsar',
              'Caeser',
              'Cole Conway',
              'Conway',
              'When Cousin Cæsar',
              'And Cousin Cæsar',
              'Iuka. Cousin Cæsar',
              'Chicago. Young Simon',
              'West Indies.--Young Simon',
              'Cæsar. Cæsar Simon',
            ],
          },
          {
            name: 'Paducah',
            type: 'location',
            description: 'City where Cousin Cæsar used the name Cole Conway.',
            aliases: [],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'When Cousin Cæsar reached Iuka. Cousin Cæsar later appeared in Paducah, Kentucky, calling himself Cole Conway. And Cousin Cæsar met Conway there.',
      'bucket-1',
      0,
      'doc-1',
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    const caesar = mentions.find(m => m.name === 'Cousin Cæsar')!
    expect(caesar.aliases).toEqual(expect.arrayContaining([
      'Cæsar',
      'Caeser',
      'Cole Conway',
      'Conway',
    ]))
    expect(caesar.aliases).not.toEqual(expect.arrayContaining([
      'When Cousin Cæsar',
      'And Cousin Cæsar',
      'Iuka. Cousin Cæsar',
      'Chicago. Young Simon',
      'West Indies.--Young Simon',
      'Cæsar. Cæsar Simon',
    ]))

    const paducah = mentions.find(m => m.name === 'Paducah, Kentucky')!
    expect(paducah.aliases).toContain('Paducah')
  })

  it('does not absorb different same-surname people or heading text as person aliases', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Elsie Inglis',
            type: 'person',
            description: 'Doctor and suffrage campaigner.',
            aliases: [
              'Inglis',
              'Elsie',
              'John Inglis',
              'David Inglis',
              'Miss Inglis',
              'CHAPTER II ELSIE MAUD INGLIS',
              'KATHERINE INGLIS',
              'E. M. I.',
            ],
          },
          {
            name: 'John Inglis',
            type: 'person',
            description: 'A different member of the Inglis family.',
            aliases: [],
          },
          {
            name: 'David Inglis',
            type: 'person',
            description: 'Another different member of the Inglis family.',
            aliases: [],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'CHAPTER II ELSIE MAUD INGLIS. Elsie Inglis wrote to John Inglis and later mentioned David Inglis while KATHERINE INGLIS remained elsewhere.',
      'bucket-1',
      0,
      'doc-1',
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    const elsie = mentions.find(m => m.name === 'Elsie Inglis')!
    expect(elsie.aliases).not.toEqual(expect.arrayContaining([
      'Inglis',
      'Elsie',
      'John Inglis',
      'David Inglis',
      'Miss Inglis',
      'CHAPTER II ELSIE MAUD INGLIS',
      'KATHERINE INGLIS',
      'E. M. I.',
    ]))
  })

  it('passes through structured profession relationships to concept entities', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Elsie Inglis',
            type: 'person',
            description: 'Doctor and organizer.',
            aliases: [],
          },
          {
            name: 'doctor',
            type: 'role',
            description: 'A profession practiced by Elsie Inglis.',
            aliases: [],
          },
        ],
        relationships: [
          { subject: 'Elsie Inglis', predicate: 'works_as', object: 'doctor', confidence: 0.92 },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Elsie Inglis was a doctor.',
      'bucket-1',
      0,
      'doc-1',
    )

    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Elsie Inglis',
      subjectType: 'person',
      predicate: 'WORKS_AS',
      object: 'doctor',
      objectType: 'role',
    }))
  })

  it('accepts B2B entity types from the centralized ontology', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Acme security review deck', type: 'artifact', description: 'A security review artifact.', aliases: ['deck'] },
          { name: 'SOC2 rollout', type: 'project', description: 'A compliance rollout project.', aliases: [] },
          { name: 'AUTH-123', type: 'issue', description: 'An authentication issue.', aliases: [] },
          { name: 'Acme demo', type: 'meeting', description: 'A sales demo meeting.', aliases: [] },
        ],
        relationships: [
          { subject: 'Acme security review deck', predicate: 'describes', object: 'SOC2 rollout', confidence: 0.9 },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'The Acme security review deck describes the SOC2 rollout after AUTH-123 came up in the Acme demo.',
      'bucket-1',
      0,
      'doc-1',
    )

    expect(graph.addEntityMentions).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'Acme security review deck', type: 'artifact' }),
      expect.objectContaining({ name: 'SOC2 rollout', type: 'project' }),
      expect.objectContaining({ name: 'AUTH-123', type: 'issue' }),
      expect.objectContaining({ name: 'Acme demo', type: 'meeting' }),
    ]))
    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      predicate: 'DESCRIBES',
      subjectType: 'artifact',
      objectType: 'project',
    }))
  })

  it('rejects greeting, imperative, possessive, and quantifier alias fragments', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Adarsh Tadimari',
            type: 'person',
            description: 'A technical team member involved in SDK integration support.',
            aliases: [
              'Adarsh',
              'Hi Adarsh',
              'Inform Adarsh Tadimari',
              "Plotline's Adarsh",
              "Adarsh's",
              'Both Adarsh',
            ],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Hi Adarsh Tadimari, please help with the Plotline SDK integration issue.',
      'bucket-1',
      0,
      'doc-1',
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions[0]!.aliases).toContain('Adarsh')
    expect(mentions[0]!.aliases).not.toEqual(expect.arrayContaining([
      'Hi Adarsh',
      'Inform Adarsh Tadimari',
      "Plotline's Adarsh",
      "Adarsh's",
      'Both Adarsh',
    ]))
  })

  it('propagates extraction errors to the index engine', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: {
        generateText: vi.fn().mockResolvedValue(''),
        generateJSON: vi.fn().mockRejectedValue(new Error('No output generated.')),
      },
      graph,
      twoPass: false,
    })

    await expect(extractor.extractFromChunk('Alice met Bob.', 'bucket-1', 0, 'doc-1'))
      .rejects.toThrow('No output generated.')
  })
})
