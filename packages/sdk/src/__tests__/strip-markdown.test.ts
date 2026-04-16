import { describe, it, expect } from 'vitest'
import { stripMarkdown } from '../index-engine/strip-markdown.js'

describe('stripMarkdown', () => {
  it('removes fenced code blocks', () => {
    const input = 'Before\n```js\nconst x = 1;\n```\nAfter'
    expect(stripMarkdown(input)).toBe('Before\n\nAfter')
  })

  it('removes images but keeps alt text', () => {
    expect(stripMarkdown('![Alt text](image.png)')).toBe('Alt text')
  })

  it('removes links but keeps text', () => {
    expect(stripMarkdown('[Click here](https://example.com)')).toBe('Click here')
  })

  it('removes heading markers', () => {
    expect(stripMarkdown('# Heading 1')).toBe('Heading 1')
    expect(stripMarkdown('## Heading 2')).toBe('Heading 2')
    expect(stripMarkdown('###### Heading 6')).toBe('Heading 6')
  })

  it('removes bold markers', () => {
    expect(stripMarkdown('**bold text**')).toBe('bold text')
    expect(stripMarkdown('__bold text__')).toBe('bold text')
  })

  it('removes italic markers', () => {
    expect(stripMarkdown('*italic text*')).toBe('italic text')
    expect(stripMarkdown('_italic text_')).toBe('italic text')
  })

  it('removes strikethrough markers', () => {
    expect(stripMarkdown('~~deleted~~')).toBe('deleted')
  })

  it('removes blockquote markers', () => {
    expect(stripMarkdown('> Quoted text')).toBe('Quoted text')
  })

  it('removes unordered list markers', () => {
    expect(stripMarkdown('- Item 1\n- Item 2')).toBe('Item 1\nItem 2')
    expect(stripMarkdown('* Item 1\n* Item 2')).toBe('Item 1\nItem 2')
    expect(stripMarkdown('+ Item 1\n+ Item 2')).toBe('Item 1\nItem 2')
  })

  it('removes ordered list markers', () => {
    expect(stripMarkdown('1. First\n2. Second')).toBe('First\nSecond')
  })

  it('removes horizontal rules', () => {
    expect(stripMarkdown('Before\n---\nAfter')).toBe('Before\n\nAfter')
    expect(stripMarkdown('Before\n----\nAfter')).toBe('Before\n\nAfter')
  })

  it('removes HTML tags', () => {
    expect(stripMarkdown('<div>content</div>')).toBe('content')
    expect(stripMarkdown('<br/>')).toBe('')
  })

  it('keeps inline code text but removes backticks', () => {
    expect(stripMarkdown('Use `console.log` for debugging')).toBe('Use console.log for debugging')
  })

  it('collapses excess newlines', () => {
    expect(stripMarkdown('A\n\n\n\nB')).toBe('A\n\nB')
  })

  it('handles complex markdown', () => {
    const input = [
      '# Title',
      '',
      'Some **bold** and *italic* text.',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      '- [Link](url) to somewhere',
      '- ![img](pic.png)',
      '',
      '> A quote with ~~deleted~~ text',
    ].join('\n')

    const result = stripMarkdown(input)
    expect(result).not.toContain('#')
    expect(result).not.toContain('**')
    expect(result).not.toContain('```')
    expect(result).toContain('bold')
    expect(result).toContain('italic')
    expect(result).toContain('Link')
    expect(result).toContain('img')
    expect(result).toContain('deleted')
  })

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('')
  })
})
