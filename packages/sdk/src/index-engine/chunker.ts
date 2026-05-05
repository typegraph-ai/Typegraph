import type { Chunk, ChunkOpts } from '../types/connector.js'
import type { SourceInput } from '../types/connector.js'

/** Approximate characters per BPE token (calibrated for GPT/Voyage tokenizers). */
const CHARS_PER_TOKEN = 4.2

/** Minimum characters for a chunk. Smaller trailing chunks merge into the previous one. */
const MIN_CHARS = 24

// ── Low-level chunker ──

export interface ChunkerOptions {
  /** Max characters per chunk. */
  maxChars: number
  /** Characters to overlap between adjacent chunks. Default: 0 */
  overlapChars?: number
  /** Minimum characters for a chunk. Shorter trailing chunks merge back. Default: 24 */
  minChars?: number
}

/**
 * Split text into chunks respecting paragraph and sentence boundaries.
 * Never splits mid-word. Zero external dependencies.
 *
 * Algorithm:
 * 1. Split on paragraph boundaries (\n\n)
 * 2. For oversized paragraphs, split on sentence boundaries (. ! ? followed by whitespace)
 * 3. For oversized sentences, split on word boundaries (whitespace)
 * 4. Greedily merge segments into chunks up to maxChars
 * 5. Merge trailing runt chunks (< minChars) into the previous chunk
 * 6. Apply overlap from the previous chunk at a word boundary
 */
export function chunkText(
  text: string,
  opts: ChunkerOptions
): Array<{ content: string; startIndex: number; endIndex: number }> {
  const { maxChars, overlapChars = 0, minChars = MIN_CHARS } = opts
  if (!text || text.trim().length === 0) return []

  // Step 1: Split into atomic segments that respect boundaries
  const segments = splitToSegments(text, maxChars)

  // Step 2: Greedily merge segments into chunks up to maxChars
  const merged = mergeSegments(segments, maxChars)

  // Step 3: Handle runt final chunk
  if (merged.length > 1) {
    const last = merged[merged.length - 1]!
    if (last.length < minChars) {
      merged[merged.length - 2] += last
      merged.pop()
    }
  }

  // Step 4: Build chunks with overlap and track offsets
  const chunks: Array<{ content: string; startIndex: number; endIndex: number }> = []
  let offset = 0

  for (let i = 0; i < merged.length; i++) {
    const raw = merged[i]!
    let content: string

    if (i > 0 && overlapChars > 0) {
      // Take overlap from previous chunk's content (not from merged, to avoid double overlap)
      const prevContent = chunks[i - 1]!.content
      const overlap = takeTrailingAtWordBoundary(prevContent, overlapChars)
      content = overlap + raw
    } else {
      content = raw
    }

    chunks.push({ content, startIndex: offset, endIndex: offset + raw.length })
    offset += raw.length
  }

  return chunks
}

/** Split text into atomic segments that each fit within maxChars. */
function splitToSegments(text: string, maxChars: number): string[] {
  // Split on paragraph boundaries (double newline)
  const paragraphs = text.split(/\n\n+/)
  const segments: string[] = []

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p]!
    // Re-add the paragraph separator (except for first)
    const segment = p > 0 ? '\n\n' + para : para

    if (segment.length <= maxChars) {
      segments.push(segment)
    } else {
      // Split oversized paragraph on sentence boundaries
      segments.push(...splitOnSentences(segment, maxChars))
    }
  }

  return segments
}

/** Split text on sentence-ending punctuation followed by whitespace. */
function splitOnSentences(text: string, maxChars: number): string[] {
  // Match sentence boundaries: . ! ? followed by whitespace
  const parts = text.split(/(?<=[.!?])\s+/)
  const segments: string[] = []

  for (const part of parts) {
    if (part.length <= maxChars) {
      segments.push(part)
    } else {
      // Split oversized sentences on word boundaries
      segments.push(...splitOnWords(part, maxChars))
    }
  }

  return segments
}

/** Split text on whitespace. Never splits mid-word. */
function splitOnWords(text: string, maxChars: number): string[] {
  const words = text.split(/(\s+)/)
  const segments: string[] = []
  let current = ''

  for (const word of words) {
    if (current.length + word.length > maxChars && current.length > 0) {
      segments.push(current)
      current = word.trimStart()
    } else {
      current += word
    }
  }
  if (current.length > 0) segments.push(current)

  return segments
}

/** Greedily merge segments into chunks up to maxChars. */
function mergeSegments(segments: string[], maxChars: number): string[] {
  const chunks: string[] = []
  let current = ''

  for (const segment of segments) {
    if (current.length + segment.length > maxChars && current.length > 0) {
      chunks.push(current)
      current = segment
    } else {
      current += segment
    }
  }
  if (current.length > 0) chunks.push(current)

  return chunks
}

/** Take up to `maxChars` from the end of text, snapping to a word boundary. */
function takeTrailingAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(-maxChars)
  // Find first whitespace to snap to word boundary
  const wsIdx = slice.search(/\s/)
  if (wsIdx > 0) return slice.slice(wsIdx)
  return slice
}

// ── Public API (token-based wrapper) ──

export async function defaultChunker(source: SourceInput, opts: ChunkOpts): Promise<Chunk[]> {
  if (!source.content || source.content.trim().length === 0) return []

  const results = chunkText(source.content, {
    maxChars: Math.round(opts.chunkSize * CHARS_PER_TOKEN),
    overlapChars: opts.chunkOverlap ? Math.round(opts.chunkOverlap * CHARS_PER_TOKEN) : 0,
  })

  return results
    .filter(c => c.content.trim().length > 0)
    .map((c, i) => ({ content: c.content, chunkIndex: i }))
}
