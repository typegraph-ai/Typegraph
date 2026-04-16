/**
 * Strip markdown syntax from text, returning plain text suitable for embedding.
 * The original markdown content is preserved in chunk storage for retrieval.
 */
export function stripMarkdown(content: string): string {
  return content
    // Code blocks (fenced)
    .replace(/```[\s\S]*?```/g, '')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Links - keep link text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Headings
    .replace(/#{1,6}\s+/g, '')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // Italic
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Strikethrough
    .replace(/~~(.+?)~~/g, '$1')
    // Blockquotes
    .replace(/^\s*>\s+/gm, '')
    // Unordered list markers
    .replace(/^\s*[-*+]\s+/gm, '')
    // Ordered list markers
    .replace(/^\s*\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // HTML tags
    .replace(/<[^>]+>/g, '')
    // Excess newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
