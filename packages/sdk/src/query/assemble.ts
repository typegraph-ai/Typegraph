import type { ContextFormat, ContextSection, QueryContextOptions, QueryContextStats, QueryResults } from '../types/query.js'
import { formatFactEvidence } from '../graph/retrieval-primitives.js'

const DEFAULT_CONTEXT_SECTIONS: ContextSection[] = ['chunks', 'facts', 'entities', 'memories']
const DEFAULT_MAX_TOTAL_TOKENS = 30_000
const DEFAULT_MAX_FACT_TOKENS = 1_500
const DEFAULT_MAX_ENTITY_TOKENS = 1_500

type TokenCounter = (text: string) => number

interface ContextEntry {
  section: ContextSection
  index: number
  content: string
  attributes: Record<string, string | number | boolean | undefined>
  metadata?: Record<string, unknown> | undefined
}

interface SelectedSection {
  entries: ContextEntry[]
  available: number
  truncated: boolean
}

interface ResolvedContextOptions {
  format: ContextFormat
  sections: ContextSection[]
  includeAttributes: boolean
  maxTotalTokens: number
  maxChunkTokens?: number | undefined
  maxFactTokens: number
  maxEntityTokens: number
  maxMemoryTokens?: number | undefined
}

export interface BuildContextResult {
  context: string
  stats: QueryContextStats
}

export function buildContext(
  results: QueryResults,
  context: true | QueryContextOptions = true,
  tokenizer?: TokenCounter,
): BuildContextResult {
  const opts = normalizeContextOptions(context)
  const countTokens = tokenizer ?? estimateTokens
  const entries = entriesBySection(results)
  const selected: Record<ContextSection, SelectedSection> = {
    chunks: selectSection(entries.chunks, opts.maxChunkTokens, countTokens, opts),
    facts: selectSection(entries.facts, opts.maxFactTokens, countTokens, opts),
    entities: selectSection(entries.entities, opts.maxEntityTokens, countTokens, opts),
    memories: selectSection(entries.memories, opts.maxMemoryTokens, countTokens, opts),
  }

  trimToTotalBudget(selected, opts.sections, opts.maxTotalTokens, countTokens, opts)

  const contextString = renderContext(selected, opts)
  const stats = contextStats(selected, opts, countTokens, contextString)
  return { context: contextString, stats }
}

function normalizeContextOptions(context: true | QueryContextOptions): ResolvedContextOptions {
  const opts = context === true ? {} : context
  return {
    format: opts.format ?? 'xml',
    sections: normalizeSections(opts.sections),
    includeAttributes: opts.includeAttributes ?? false,
    maxTotalTokens: opts.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
    maxChunkTokens: opts.maxChunkTokens,
    maxFactTokens: opts.maxFactTokens ?? DEFAULT_MAX_FACT_TOKENS,
    maxEntityTokens: opts.maxEntityTokens ?? DEFAULT_MAX_ENTITY_TOKENS,
    maxMemoryTokens: opts.maxMemoryTokens,
  }
}

function normalizeSections(sections: ContextSection[] | undefined): ContextSection[] {
  const seen = new Set<ContextSection>()
  const requested = sections?.length ? sections : DEFAULT_CONTEXT_SECTIONS
  return requested.filter((section): section is ContextSection => {
    if (!DEFAULT_CONTEXT_SECTIONS.includes(section) || seen.has(section)) return false
    seen.add(section)
    return true
  })
}

function entriesBySection(results: QueryResults): Record<ContextSection, ContextEntry[]> {
  return {
    chunks: results.chunks.map((chunk, index) => ({
      section: 'chunks',
      index: index + 1,
      content: chunk.content,
      attributes: {
        score: formatScore(chunk.score),
        bucketId: chunk.source.bucketId,
        sourceId: chunk.source.id,
        title: chunk.source.title || undefined,
        url: chunk.source.url,
        chunkIndex: chunk.chunk.index,
        totalChunks: chunk.chunk.total,
      },
      metadata: nonEmptyRecord(chunk.metadata),
    })),
    facts: results.facts.map((fact, index) => ({
      section: 'facts',
      index: index + 1,
      content: formatFactEvidence(fact),
      attributes: {
        id: fact.id,
        edgeId: fact.edgeId,
        relation: fact.relation,
        sourceEntityId: fact.sourceEntityId,
        source: fact.sourceEntityName,
        targetEntityId: fact.targetEntityId,
        target: fact.targetEntityName,
        weight: formatScore(fact.weight),
        evidenceCount: fact.evidenceCount,
        similarity: fact.similarity != null ? formatScore(fact.similarity) : undefined,
      },
      metadata: nonEmptyRecord(fact.properties),
    })),
    entities: results.entities.map((entity, index) => ({
      section: 'entities',
      index: index + 1,
      content: entity.name,
      attributes: {
        id: entity.id,
        type: entity.entityType,
        aliases: entity.aliases.length ? entity.aliases.join(', ') : undefined,
        edgeCount: entity.edgeCount,
        similarity: entity.similarity != null ? formatScore(entity.similarity) : undefined,
      },
      metadata: nonEmptyRecord(entity.properties),
    })),
    memories: results.memories.map((memory, index) => ({
      section: 'memories',
      index: index + 1,
      content: memory.content,
      attributes: {
        id: memory.id,
        category: memory.category,
        status: memory.status,
        score: formatScore(memory.score),
        importance: formatScore(memory.importance),
        accessCount: memory.accessCount,
      },
      metadata: nonEmptyRecord(memory.metadata),
    })),
  }
}

function selectSection(
  entries: ContextEntry[],
  maxSectionTokens: number | undefined,
  countTokens: TokenCounter,
  opts: ResolvedContextOptions,
): SelectedSection {
  if (maxSectionTokens == null) return { entries: [...entries], available: entries.length, truncated: false }

  const selected: ContextEntry[] = []
  let used = 0
  for (const entry of entries) {
    const rendered = renderEntryForBudget(entry, opts)
    const tokens = countTokens(rendered)
    if (selected.length > 0 && used + tokens > maxSectionTokens) break
    selected.push(entry)
    used += tokens
  }
  return {
    entries: selected,
    available: entries.length,
    truncated: selected.length < entries.length,
  }
}

function trimToTotalBudget(
  selected: Record<ContextSection, SelectedSection>,
  sections: ContextSection[],
  maxTotalTokens: number,
  countTokens: TokenCounter,
  opts: ResolvedContextOptions,
): void {
  const totalEntries = () => sections.reduce((sum, section) => sum + selected[section].entries.length, 0)
  while (countTokens(renderContext(selected, opts)) > maxTotalTokens && totalEntries() > 1) {
    for (let i = sections.length - 1; i >= 0; i--) {
      const section = selected[sections[i]!]
      if (section.entries.length === 0) continue
      section.entries.pop()
      section.truncated = true
      break
    }
  }
}

function contextStats(
  selected: Record<ContextSection, SelectedSection>,
  opts: ResolvedContextOptions,
  countTokens: TokenCounter,
  context: string,
): QueryContextStats {
  const sections: QueryContextStats['sections'] = {}
  for (const section of opts.sections) {
    const selectedSection = selected[section]
    const rendered = renderContext({ ...emptySelectedSections(), [section]: selectedSection }, { ...opts, sections: [section] })
    sections[section] = {
      available: selectedSection.available,
      included: selectedSection.entries.length,
      tokens: selectedSection.entries.length > 0 ? countTokens(rendered) : 0,
      truncated: selectedSection.truncated,
    }
  }

  return {
    format: opts.format,
    totalTokens: countTokens(context),
    truncated: Object.values(sections).some(section => section?.truncated),
    sections,
  }
}

function renderContext(
  selected: Record<ContextSection, SelectedSection>,
  opts: ResolvedContextOptions,
): string {
  switch (opts.format) {
    case 'markdown':
      return renderMarkdown(selected, opts)
    case 'plain':
      return renderPlain(selected, opts)
    case 'xml':
    default:
      return renderXml(selected, opts)
  }
}

function renderXml(
  selected: Record<ContextSection, SelectedSection>,
  opts: ResolvedContextOptions,
): string {
  const sections = opts.sections
    .filter(section => selected[section].entries.length > 0)
    .map(section => {
      const entries = selected[section].entries.map(entry => renderXmlEntry(entry, opts)).join('\n')
      return `  <${sectionTag(section)}>\n${entries}\n  </${sectionTag(section)}>`
    })
  return `<context>\n${sections.join('\n')}\n</context>`
}

function renderXmlEntry(entry: ContextEntry, opts: ResolvedContextOptions): string {
  const tag = entryTag(entry)
  if (!opts.includeAttributes) {
    return `    <${tag}>${escapeXmlText(entry.content)}</${tag}>`
  }

  const attrs = renderXmlAttributes(entry.attributes)
  const metadata = entry.metadata
    ? `\n      <${tag}_metadata>${escapeXmlText(JSON.stringify(entry.metadata))}</${tag}_metadata>`
    : ''
  return `    <${tag}${attrs ? ` ${attrs}` : ''}>${metadata}\n      <${tag}_content>${escapeXmlText(entry.content)}</${tag}_content>\n    </${tag}>`
}

function renderMarkdown(
  selected: Record<ContextSection, SelectedSection>,
  opts: ResolvedContextOptions,
): string {
  const sections = opts.sections
    .filter(section => selected[section].entries.length > 0)
    .map(section => {
      const entries = selected[section].entries.map(entry => renderMarkdownEntry(entry, opts)).join('\n\n')
      return `## ${sectionTitle(section)}\n\n${entries}`
    })
  return ['# Context', ...sections].join('\n\n')
}

function renderMarkdownEntry(entry: ContextEntry, opts: ResolvedContextOptions): string {
  const lines = [`### ${entryTitle(entry)}`]
  if (opts.includeAttributes) {
    lines.push(...renderMarkdownAttributes(entry))
    lines.push('')
  } else {
    lines.push('')
  }
  const tag = entryTag(entry)
  lines.push(`<${tag}>\n${entry.content}\n</${tag}>`)
  return lines.join('\n')
}

function renderPlain(
  selected: Record<ContextSection, SelectedSection>,
  opts: ResolvedContextOptions,
): string {
  const sections = opts.sections
    .filter(section => selected[section].entries.length > 0)
    .map(section => {
      const entries = selected[section].entries.map(entry => {
        const attrLines = opts.includeAttributes ? [...renderMarkdownAttributes(entry), ''] : []
        return [entryTitle(entry), ...attrLines, entry.content].join('\n')
      }).join('\n\n')
      return `${sectionTitle(section)}\n\n${entries}`
    })
  return sections.join('\n\n')
}

function renderEntryForBudget(entry: ContextEntry, opts: ResolvedContextOptions): string {
  switch (opts.format) {
    case 'markdown':
      return renderMarkdownEntry(entry, opts)
    case 'plain':
      return `${entryTitle(entry)}\n${entry.content}`
    case 'xml':
    default:
      return renderXmlEntry(entry, opts)
  }
}

function renderXmlAttributes(attributes: ContextEntry['attributes']): string {
  return Object.entries(attributes)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] != null && entry[1] !== '')
    .map(([key, value]) => `${key}="${escapeXmlAttribute(String(value))}"`)
    .join(' ')
}

function renderMarkdownAttributes(entry: ContextEntry): string[] {
  const attrs = Object.entries(entry.attributes)
    .filter((attr): attr is [string, string | number | boolean] => attr[1] != null && attr[1] !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
  if (entry.metadata) attrs.push(`metadata: ${JSON.stringify(entry.metadata)}`)
  return attrs
}

function emptySelectedSections(): Record<ContextSection, SelectedSection> {
  return {
    chunks: { entries: [], available: 0, truncated: false },
    facts: { entries: [], available: 0, truncated: false },
    entities: { entries: [], available: 0, truncated: false },
    memories: { entries: [], available: 0, truncated: false },
  }
}

function sectionTag(section: ContextSection): string {
  return `context_${section}`
}

function entryTag(entry: ContextEntry): string {
  return `context_${singular(entry.section)}_${entry.index}`
}

function sectionTitle(section: ContextSection): string {
  return `Context ${capitalize(section)}`
}

function entryTitle(entry: ContextEntry): string {
  return `Context ${capitalize(singular(entry.section))} ${entry.index}`
}

function singular(section: ContextSection): string {
  switch (section) {
    case 'chunks': return 'chunk'
    case 'facts': return 'fact'
    case 'entities': return 'entity'
    case 'memories': return 'memory'
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(4) : '0.0000'
}

function nonEmptyRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined
}

function estimateTokens(text: string): number {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3)
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;')
}
