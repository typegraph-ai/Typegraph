import { describe, it, expect } from 'vitest'
import { defaultChunker } from '../index-engine/chunker.js'
import { createTestDocument } from './helpers/mock-connector.js'

describe('defaultChunker', () => {
  it('returns single chunk for short content', async () => {
    const doc = createTestDocument({ content: 'Short text.' })
    const chunks = await defaultChunker(doc, { chunkSize: 100, chunkOverlap: 20 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe('Short text.')
    expect(chunks[0]!.chunkIndex).toBe(0)
  })

  it('splits long content into multiple chunks', async () => {
    const content = 'This is a sentence. '.repeat(200)
    const doc = createTestDocument({ content })
    const chunks = await defaultChunker(doc, { chunkSize: 512, chunkOverlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('preserves chunk indices in order', async () => {
    const content = 'This is a sentence. '.repeat(200)
    const doc = createTestDocument({ content })
    const chunks = await defaultChunker(doc, { chunkSize: 512, chunkOverlap: 0 })
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunkIndex).toBe(i)
    }
  })

  it('skips empty chunks after trimming', async () => {
    const content = 'Hello' + ' '.repeat(500)
    const doc = createTestDocument({ content })
    const chunks = await defaultChunker(doc, { chunkSize: 512, chunkOverlap: 0 })
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0)
    }
  })

  it('returns empty array for empty content', async () => {
    const doc = createTestDocument({ content: '' })
    const chunks = await defaultChunker(doc, { chunkSize: 512, chunkOverlap: 0 })
    expect(chunks).toHaveLength(0)
  })

  it('does not break mid-sentence', async () => {
    const sentences = [
      'The quick brown fox jumps over the lazy dog.',
      'A stitch in time saves nine.',
      'All that glitters is not gold.',
      'Actions speak louder than words.',
      'Beauty is in the eye of the beholder.',
    ]
    const content = sentences.join(' ')
    const doc = createTestDocument({ content })
    // Use a small chunk size to force splitting
    const chunks = await defaultChunker(doc, { chunkSize: 64, chunkOverlap: 0 })

    for (const chunk of chunks) {
      const trimmed = chunk.content.trim()
      // Each chunk should end with sentence-ending punctuation or be the last chunk
      const endsWithPunctuation = /[.!?]$/.test(trimmed)
      const isLastChunk = chunk.chunkIndex === chunks.length - 1
      expect(endsWithPunctuation || isLastChunk).toBe(true)
    }
  })
})
