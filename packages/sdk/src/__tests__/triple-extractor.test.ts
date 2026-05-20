import { describe, it, expect, vi } from 'vitest'
import { TripleExtractor } from '../index-engine/triple-extractor.js'
import { compileOntology } from '../index-engine/ontology.js'
import type { KnowledgeGraphBridge, LLMProvider } from '../types/index.js'

function mockLLM(output: unknown): LLMProvider {
  return {
    generateText: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue(output),
  }
}

describe('TripleExtractor', () => {
  it('does not include document names in extraction prompts', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const llm: LLMProvider = {
      generateText: vi.fn().mockResolvedValue(''),
      generateJSON: vi.fn().mockResolvedValue([
        { name: 'Alice', type: 'person', description: 'A named person in the text.', aliases: [] },
      ]),
    }
    const extractor = new TripleExtractor({ llm, graph })

    await extractor.extractFromChunk(
      'Alice walked through the garden.',
      'bucket-1',
      0,
      'document-1',
      undefined,
      undefined,
      'Novel-41603 [14/64]',
    )

    const prompts = vi.mocked(llm.generateJSON).mock.calls.map(call => String(call[0])).join('\n')
    expect(prompts).not.toContain('Novel-41603')
    expect(prompts).not.toContain('document named')
  })

  it('splits peer coordinate place lists but preserves qualified places', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Mexico, Guatemala', type: 'place', description: 'Two Central American places.', aliases: [] },
          { name: 'Cairo, Egypt', type: 'place', description: 'A city in Egypt.', aliases: ['Cairo'] },
          { name: 'Uxmal, Mayapan, and Chichen-Itza', type: 'place', description: 'Three Mayan sites.', aliases: [] },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'The account compares Mexico, Guatemala, Cairo, Egypt, Uxmal, Mayapan, and Chichen-Itza.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions.map(m => m.name)).toEqual(expect.arrayContaining([
      'Mexico',
      'Guatemala',
      'Cairo, Egypt',
      'Uxmal',
      'Mayapan',
      'Chichen-Itza',
    ]))
    expect(mentions.map(m => m.name)).not.toContain('Mexico, Guatemala')
  })

  it('uses literary ontology predicate aliases for conflict facts', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Mexico', type: 'place', description: 'A country.', aliases: [] },
          { name: 'Guatemala', type: 'place', description: 'A country.', aliases: [] },
        ],
        relationships: [
          { subject: 'Mexico', predicate: 'AT_WAR_WITH', object: 'Guatemala', confidence: 0.9 },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Mexico was at war with Guatemala.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      predicate: 'CONFLICT_WITH',
      subject: 'Mexico',
      object: 'Guatemala',
    }))
  })

  it('removes coordinate-list, cross-entity, OCR, and phrase-prefix aliases before graph writes', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Mexico, Guatemala',
            type: 'place',
            description: 'Two countries discussed together.',
            aliases: ['Mexico', 'Guatemala', 'Mexico, Guatemala', 'Egpptian[TN-3]'],
          },
          {
            name: 'according to Landa',
            type: 'person',
            description: 'A cited source.',
            aliases: ['as described by Landa', '[TN-3] Landa'],
          },
          {
            name: 'Cairo, Egypt',
            type: 'place',
            description: 'A city in Egypt.',
            aliases: ['Cairo'],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'According to Landa, Mexico, Guatemala, and Cairo, Egypt are discussed. Egpptian[TN-3] is an OCR note.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    const mexico = mentions.find(m => m.name === 'Mexico')!
    const guatemala = mentions.find(m => m.name === 'Guatemala')!
    const landa = mentions.find(m => m.name === 'Landa')!
    const cairo = mentions.find(m => m.name === 'Cairo, Egypt')!
    expect(mexico.aliases).not.toEqual(expect.arrayContaining(['Guatemala', 'Mexico, Guatemala', 'Egpptian[TN-3]']))
    expect(guatemala.aliases).not.toEqual(expect.arrayContaining(['Mexico', 'Mexico, Guatemala']))
    expect(landa.aliases).toEqual([])
    expect(cairo.aliases).toContain('Cairo')
  })

  it('classifies periodicals as publications and preserves standalone creative works', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'London Magazine',
            type: 'creative_work',
            description: 'An 18th-century British literary magazine.',
            aliases: [],
          },
          {
            name: 'Berlinische Monatsschrift',
            type: 'creative_work',
            description: 'A German journal that published literary articles.',
            aliases: [],
          },
          {
            name: 'Don Quixote',
            type: 'creative_work',
            description: 'A novel by Miguel de Cervantes.',
            aliases: [],
          },
          {
            name: 'Hamlet',
            type: 'creative_work',
            description: 'A play by William Shakespeare.',
            aliases: [],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'London Magazine and Berlinische Monatsschrift discussed Don Quixote and Hamlet.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'London Magazine', type: 'publication' }),
      expect.objectContaining({ name: 'Berlinische Monatsschrift', type: 'publication' }),
      expect.objectContaining({ name: 'Don Quixote', type: 'creative_work' }),
      expect.objectContaining({ name: 'Hamlet', type: 'creative_work' }),
    ]))
  })

  it('rejects generated source labels and source excerpt works', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Novel-10321 [4/75]',
            type: 'creative_work',
            description: 'The creative work from which this passage originates.',
            aliases: ['Novel-10321'],
          },
          {
            name: 'Novel-41603',
            type: 'document',
            description: 'The source document containing this excerpt.',
            aliases: ['Novel-41603 [14/64]'],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    const result = await extractor.extractFromChunk(
      'The passage describes Rudolph Hackh and a princess.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    expect(result?.entities).toEqual([])
    expect(graph.addEntityMentions).not.toHaveBeenCalled()
  })

  it('rejects untitled structural headings by default', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Chapter XII',
            type: 'creative_work',
            description: 'The twelfth chapter of the educational text.',
            aliases: ['Chapter XIII'],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    const result = await extractor.extractFromChunk(
      'CHAPTER XII. Food and health are discussed.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    expect(result?.entities).toEqual([])
    expect(graph.addEntityMentions).not.toHaveBeenCalled()
  })

  it('does not merge numbered or sibling works as aliases', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Elegy XIV',
            type: 'creative_work',
            description: 'A specific poem in a larger work.',
            aliases: ['Elegy XV', 'Elegy VII', 'The beauties of Corinna'],
          },
          {
            name: 'Old Testament',
            type: 'creative_work',
            description: 'The first part of the Christian Bible.',
            aliases: ['New Testament'],
          },
          {
            name: 'Minna von Barnhelm',
            type: 'creative_work',
            description: 'A play written by Gotthold Ephraim Lessing.',
            aliases: ['Götz von Berlichingen'],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Elegy XIV, Old Testament, and Minna von Barnhelm are discussed alongside other works.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions.find(m => m.name === 'Elegy XIV')?.aliases).not.toEqual(expect.arrayContaining(['Elegy XV', 'Elegy VII']))
    expect(mentions.find(m => m.name === 'Old Testament')?.aliases).not.toContain('New Testament')
    expect(mentions.find(m => m.name === 'Minna von Barnhelm')?.aliases).not.toContain('Götz von Berlichingen')
  })

  it('rewrites work-to-publication APPEARS_IN facts to PUBLISHED_IN', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Empfindsamkeiten am Rheinfalle',
            type: 'creative_work',
            description: 'A poem.',
            aliases: [],
          },
          {
            name: 'Morgenblatt',
            type: 'creative_work',
            description: 'A German journal that published poems.',
            aliases: [],
          },
        ],
        relationships: [
          {
            subject: 'Empfindsamkeiten am Rheinfalle',
            predicate: 'APPEARS_IN',
            object: 'Morgenblatt',
            confidence: 0.9,
            description: 'Empfindsamkeiten am Rheinfalle appeared in Morgenblatt.',
            evidenceText: 'published in the Morgenblatt',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'The poem Empfindsamkeiten am Rheinfalle was published in the Morgenblatt.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Empfindsamkeiten am Rheinfalle',
      predicate: 'PUBLISHED_IN',
      object: 'Morgenblatt',
      objectType: 'publication',
    }))
  })

  it('drops weak RELATED_TO facts and generic document APPEARS_IN facts', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Mexico', type: 'place', description: 'A country.', aliases: [] },
          { name: 'Guatemala', type: 'place', description: 'A country.', aliases: [] },
          { name: 'Novel-30752', type: 'document', description: 'The source document.', aliases: [] },
        ],
        relationships: [
          {
            subject: 'Mexico',
            predicate: 'RELATED_TO',
            object: 'Guatemala',
            confidence: 0.9,
            description: 'Mexico is related to Guatemala.',
            evidenceText: 'Mexico, Guatemala',
          },
          {
            subject: 'Mexico',
            predicate: 'APPEARS_IN',
            object: 'Novel-30752',
            confidence: 0.9,
            description: 'Mexico appears in the source document.',
            evidenceText: 'Mexico appears in the passage',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Mexico and Guatemala are mentioned in the passage.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    expect(graph.addTriple).not.toHaveBeenCalled()
  })

  it('keeps APPEARS_IN only for character membership in named works', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Elizabeth Bennet', type: 'character', description: 'A fictional character.', aliases: [] },
          { name: 'Jane Austen', type: 'person', description: 'A real author.', aliases: [] },
          { name: 'Pemberley', type: 'place', description: 'A named estate.', aliases: [] },
          { name: 'Pride and Prejudice', type: 'creative_work', description: 'A novel.', aliases: [] },
        ],
        relationships: [
          {
            subject: 'Elizabeth Bennet',
            predicate: 'APPEARS_IN',
            object: 'Pride and Prejudice',
            confidence: 0.9,
            description: 'Elizabeth Bennet appears in Pride and Prejudice.',
            evidenceText: 'Elizabeth Bennet appears in Pride and Prejudice',
          },
          {
            subject: 'Jane Austen',
            predicate: 'APPEARS_IN',
            object: 'Pride and Prejudice',
            confidence: 0.9,
            description: 'Jane Austen is mentioned in Pride and Prejudice.',
            evidenceText: 'Jane Austen is mentioned in the work',
          },
          {
            subject: 'Pemberley',
            predicate: 'APPEARS_IN',
            object: 'Pride and Prejudice',
            confidence: 0.9,
            description: 'Pemberley is mentioned in Pride and Prejudice.',
            evidenceText: 'Pemberley is mentioned in the work',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Elizabeth Bennet appears in Pride and Prejudice. Jane Austen and Pemberley are also discussed.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({ version: 'literary-test', profiles: ['literary'] }),
    )

    expect(graph.addTriple).toHaveBeenCalledTimes(1)
    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Elizabeth Bennet',
      predicate: 'APPEARS_IN',
      object: 'Pride and Prejudice',
    }))
  })

  it('drops low-confidence relationships before graph writes', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Augustus Le Plongeon', type: 'person', description: 'An author.', aliases: [] },
          { name: 'Member of the American Antiquarian Society of Worcester, Mass.', type: 'role', description: 'A membership role.', aliases: [] },
        ],
        relationships: [
          {
            subject: 'Augustus Le Plongeon',
            predicate: 'WORKS_AS',
            object: 'Member of the American Antiquarian Society of Worcester, Mass.',
            confidence: 0.2,
            description: 'Augustus Le Plongeon served as a member of the American Antiquarian Society.',
            evidenceText: 'Member of the American Antiquarian Society of Worcester, Mass.',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Augustus Le Plongeon, M.D., Member of the American Antiquarian Society of Worcester, Mass.',
      'bucket-1',
      0,
      'source-1',
    )

    expect(graph.addTriple).not.toHaveBeenCalled()
  })

  it('allows custom ontology users to model structural sections explicitly', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Chapter XII',
            type: 'section',
            description: 'A named section in the user ontology.',
            aliases: [],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'CHAPTER XII. Food and health are discussed.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chunk-1',
      compileOntology({
        version: 'custom-section',
        profiles: ['literary'],
        entities: {
          section: { extends: 'document', description: 'A structural section intentionally modeled by the user.' },
        },
      }),
    )

    expect(graph.addEntityMentions).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'Chapter XII', type: 'section' }),
    ]))
  })

  it('forwards graph and organization identity to graph writes', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Cæsar Simon', type: 'person', aliases: ['Cole Conway'] },
          { name: 'Steve Sharp', type: 'person', aliases: [] },
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
      'document-1',
      undefined,
      undefined,
      undefined,
      {
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        groupId: 'Novel-30752',
        graphId: 'source-graph',
      },
      undefined,
      'chunk-1',
    )

    expect(graph.addEntityMentions).toHaveBeenCalled()
    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions.length).toBeGreaterThan(0)
    expect(mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        groupId: 'Novel-30752',
        graphId: 'source-graph',
      }),
    ]))

    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      groupId: 'Novel-30752',
      graphId: 'source-graph',
      bucketId: 'bucket-1',
      documentId: 'document-1',
      chunkId: 'chunk-1',
    }))
  })

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
      'source-1',
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
      aliases: expect.arrayContaining(['Cole Conway', 'Conway']),
    }))
    expect(mentions[0]!.aliases).not.toContain('Cousin Cæsar')
    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Cæsar Simon',
      subjectAliases: expect.arrayContaining(['Cole Conway']),
      object: 'Steve Sharp',
      relationshipDescription: 'Cæsar Simon and Steve Sharp were companions in Paducah.',
      evidenceText: 'in Paducah, Kentucky, calling himself Cole Conway, in company with one Steve Sharp',
      chunkId: 'chk-1',
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
      'source-1',
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
      'source-1',
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
      'source-1',
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
          { name: 'Acme security review deck', type: 'document', description: 'A security review document.', aliases: ['deck'] },
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
      'source-1',
    )

    expect(graph.addEntityMentions).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'Acme security review deck', type: 'document' }),
      expect.objectContaining({ name: 'SOC2 rollout', type: 'project' }),
      expect.objectContaining({ name: 'AUTH-123', type: 'issue' }),
      expect.objectContaining({ name: 'Acme demo', type: 'meeting' }),
    ]))
    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      predicate: 'DESCRIBES',
      subjectType: 'document',
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
      'source-1',
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions[0]!.aliases).not.toEqual(expect.arrayContaining([
      'Adarsh',
      'Hi Adarsh',
      'Inform Adarsh Tadimari',
      "Plotline's Adarsh",
      "Adarsh's",
      'Both Adarsh',
    ]))
  })

  it('drops bare given-name person aliases and standalone duplicate first-name entities', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'Ada Lovelace',
            type: 'person',
            description: 'A mathematician mentioned in the text.',
            aliases: ['Ada', 'Dr Ada'],
          },
          {
            name: 'Ada',
            type: 'person',
            description: 'A bare first-name reference to Ada Lovelace.',
            aliases: [],
          },
          {
            name: 'Alan Turing',
            type: 'person',
            description: 'A mathematician mentioned in the text.',
            aliases: ['Alan'],
          },
          {
            name: 'Kevin Durant',
            type: 'person',
            description: 'A basketball player mentioned in the text.',
            aliases: ['Kevin'],
          },
          {
            name: 'Madonna',
            type: 'person',
            description: 'A mononymous performer mentioned in the text.',
            aliases: [],
          },
          {
            name: 'Cher',
            type: 'person',
            description: 'A mononymous performer mentioned in the text.',
            aliases: [],
          },
        ],
        relationships: [],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'Ada Lovelace met Alan Turing. Ada later wrote to Alan. Kevin Durant joined the team and Kevin later spoke. Madonna and Cher performed.',
      'bucket-1',
      0,
      'source-1',
    )

    const mentions = vi.mocked(graph.addEntityMentions).mock.calls[0]![0]
    expect(mentions.map(m => m.name)).toEqual(expect.arrayContaining([
      'Ada Lovelace',
      'Alan Turing',
      'Kevin Durant',
      'Madonna',
      'Cher',
    ]))
    expect(mentions.filter(m => m.name === 'Ada')).toHaveLength(0)
    expect(mentions.find(m => m.name === 'Ada Lovelace')!.aliases).not.toEqual(expect.arrayContaining(['Ada', 'Dr Ada']))
    expect(mentions.find(m => m.name === 'Alan Turing')!.aliases).not.toContain('Alan')
    expect(mentions.find(m => m.name === 'Kevin Durant')!.aliases).not.toContain('Kevin')
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

    await expect(extractor.extractFromChunk('Alice met Bob.', 'bucket-1', 0, 'source-1'))
      .rejects.toThrow('No output generated.')
  })

  it('passes type candidates through so effective type validation can keep brand-platform facts', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'TypeGraph',
            type: 'organization',
            typeCandidates: [
              { type: 'organization', confidence: 0.8 },
              { type: 'product', confidence: 0.72 },
              { type: 'technology', confidence: 0.68 },
            ],
            description: 'A B2B SaaS platform used for graph-backed memory and retrieval.',
            aliases: ['TG'],
          },
          {
            name: 'Okta SSO',
            type: 'technology',
            description: 'An enterprise SSO technology used by Acme.',
            aliases: ['Okta'],
          },
        ],
        relationships: [
          {
            subject: 'TypeGraph',
            predicate: 'INTEGRATES_WITH',
            object: 'Okta SSO',
            confidence: 0.86,
            description: 'TypeGraph integrates with Okta SSO.',
            evidenceText: 'TypeGraph integrates with Okta SSO for Acme.',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk('TypeGraph integrates with Okta SSO for Acme.', 'bucket-1', 0, 'source-1')

    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'TypeGraph',
      subjectType: 'organization',
      subjectTypeCandidates: expect.arrayContaining([
        expect.objectContaining({ type: 'product' }),
        expect.objectContaining({ type: 'technology' }),
      ]),
      predicate: 'INTEGRATES_WITH',
      object: 'Okta SSO',
    }))
  })

  it('canonicalizes aliases from typed entity context before relationship persistence', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          {
            name: 'TG',
            type: 'product',
            description: 'A short reference to the TypeGraph platform.',
            aliases: [],
          },
          {
            name: 'Okta SSO',
            type: 'technology',
            description: 'An enterprise SSO technology.',
            aliases: ['Okta'],
          },
        ],
        relationships: [
          {
            subject: 'TG',
            predicate: 'INTEGRATES_WITH',
            object: 'Okta SSO',
            confidence: 0.9,
            description: 'TypeGraph integrates with Okta SSO.',
            evidenceText: 'TG integrates with Okta SSO.',
          },
        ],
      }),
      graph,
      twoPass: false,
    })

    await extractor.extractFromChunk(
      'TG integrates with Okta SSO.',
      'bucket-1',
      0,
      'source-1',
      undefined,
      [{ name: 'TypeGraph', type: 'organization', aliases: ['TG'], typeCandidates: [{ type: 'product', confidence: 0.8 }] }],
    )

    expect(graph.addTriple).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'TypeGraph',
      subjectAliases: expect.arrayContaining(['TG']),
      object: 'Okta SSO',
    }))
  })

  it('drops reflected triples below threshold without failing the chunk', async () => {
    const graph: KnowledgeGraphBridge = {
      addEntityMentions: vi.fn().mockResolvedValue(undefined),
      addTriple: vi.fn().mockResolvedValue(undefined),
    }
    const extractor = new TripleExtractor({
      llm: mockLLM({
        entities: [
          { name: 'Acme Corp', type: 'organization', description: 'A prospect.', aliases: [] },
          { name: 'Okta SSO', type: 'technology', description: 'An SSO technology.', aliases: [] },
        ],
        relationships: [
          {
            subject: 'Acme Corp',
            predicate: 'USES',
            object: 'Okta SSO',
            confidence: 0.9,
            description: 'Acme Corp uses Okta SSO.',
            evidenceText: 'Acme Corp mentioned auth.',
          },
        ],
      }),
      relationshipLlm: mockLLM({ results: [{ index: 0, keep: false, score: 0.1 }] }),
      graph,
      twoPass: false,
    })

    const result = await extractor.extractFromChunk('Acme Corp mentioned auth.', 'bucket-1', 0, 'source-1')

    expect(result?.entities).toHaveLength(2)
    expect(graph.addEntityMentions).toHaveBeenCalled()
    expect(graph.addTriple).not.toHaveBeenCalled()
  })
})
