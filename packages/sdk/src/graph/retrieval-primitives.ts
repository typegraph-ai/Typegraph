export interface FactSearchTextInput {
  factText: string
  description?: string | undefined
  evidenceText?: string | undefined
}

export function normalizeGraphText(value: string): string {
  return value
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function tokenOverlapScore(queryTokenSet: Set<string>, text: string): number {
  if (queryTokenSet.size === 0) return 0
  const textTokens = new Set(normalizeGraphText(text).split(/\s+/).filter(Boolean))
  let hits = 0
  for (const token of queryTokenSet) {
    if (textTokens.has(token)) hits++
  }
  return hits / Math.max(1, queryTokenSet.size)
}

export function buildFactSearchText(input: FactSearchTextInput): string {
  return [input.factText, input.description, input.evidenceText]
    .map(part => part?.trim())
    .filter((part): part is string => !!part)
    .join('\n')
}

export function formatFactEvidence(input: FactSearchTextInput): string {
  const description = input.description?.trim()
  const evidenceText = input.evidenceText?.trim()
  if (description && evidenceText) return `${input.factText}: ${description} Evidence: ${evidenceText}`
  if (description) return `${input.factText}: ${description}`
  if (evidenceText) return `${input.factText}: ${evidenceText}`
  return input.factText
}
