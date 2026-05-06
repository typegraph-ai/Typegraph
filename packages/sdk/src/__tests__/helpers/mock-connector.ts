import type { SourceInput } from '../../types/connector.js'

export function createTestSource(overrides?: Partial<SourceInput>): SourceInput {
  return {
    id: 'source-1',
    content: 'Test source content. This is the body of the test source.',
    title: 'Test Source',
    url: 'https://example.com/source-1',
    updatedAt: new Date('2024-01-01'),
    metadata: {},
    ...overrides,
  }
}

export function createTestSources(count: number, contentPrefix?: string): SourceInput[] {
  const prefix = contentPrefix ?? 'Source'
  return Array.from({ length: count }, (_, i) => ({
    id: `source-${i + 1}`,
    content: `${prefix} ${i + 1} content. This is the body of source number ${i + 1}.`,
    title: `${prefix} ${i + 1}`,
    url: `https://example.com/source-${i + 1}`,
    updatedAt: new Date('2024-01-01'),
    metadata: {},
  }))
}
