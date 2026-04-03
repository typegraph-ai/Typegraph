import type { RawDocument } from '../../types/connector.js'

export function createTestDocument(overrides?: Partial<RawDocument>): RawDocument {
  return {
    id: 'doc-1',
    content: 'Test document content. This is the body of the test document.',
    title: 'Test Document',
    url: 'https://example.com/doc-1',
    updatedAt: new Date('2024-01-01'),
    metadata: {},
    ...overrides,
  }
}

export function createTestDocuments(count: number, contentPrefix?: string): RawDocument[] {
  const prefix = contentPrefix ?? 'Document'
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i + 1}`,
    content: `${prefix} ${i + 1} content. This is the body of document number ${i + 1}.`,
    title: `${prefix} ${i + 1}`,
    url: `https://example.com/doc-${i + 1}`,
    updatedAt: new Date('2024-01-01'),
    metadata: {},
  }))
}
