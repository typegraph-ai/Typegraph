import type { typegraphResult } from '../types/query.js'

export interface AssembleOpts {
  format?: 'xml' | 'markdown' | 'plain' | ((results: typegraphResult[]) => string)
  citeBuckets?: boolean
}

export function assemble(results: typegraphResult[], opts: AssembleOpts = {}): string {
  const {
    format = 'xml',
    citeBuckets = true,
  } = opts

  if (typeof format === 'function') return format(results)

  switch (format) {
    case 'xml':  return assembleXml(results, { citeBuckets })
    case 'markdown': return assembleMarkdown(results, { citeBuckets })
    case 'plain': return assemblePlain(results)
    default: return assembleXml(results, { citeBuckets })
  }
}

export function assembleXml(results: typegraphResult[], _opts: { citeBuckets: boolean }): string {
  const sources = groupByBucketId(results)
  const parts = Object.entries(sources).map(([bucketId, chunks]) => {
    const first = chunks[0]!
    const attrs = [
      `id="${bucketId}"`,
      first.document.title ? `title="${escapeXml(first.document.title)}"` : '',
      first.document.url ? `url="${escapeXml(first.document.url)}"` : '',
    ].filter(Boolean).join(' ')

    const passages = chunks.map(c =>
      `  <passage score="${c.score.toFixed(4)}">\n    ${escapeXml(c.content)}\n  </passage>`
    ).join('\n')

    return `<source ${attrs}>\n${passages}\n</source>`
  })

  return `<context>\n${parts.join('\n')}\n</context>`
}

export function assembleMarkdown(results: typegraphResult[], _opts: { citeBuckets: boolean }): string {
  return results.map(r => {
    const title = r.document.title
    const url = r.document.url
    const heading = url ? `# [${title}](${url})` : `# ${title}`
    return `${heading}\n${r.content}`
  }).join('\n\n---\n\n')
}

export function assemblePlain(results: typegraphResult[]): string {
  return results.map(r => r.content).join('\n\n')
}

export function groupByBucketId(results: typegraphResult[]): Record<string, typegraphResult[]> {
  return results.reduce((acc, r) => {
    const key = r.document.bucketId
    ;(acc[key] = acc[key] ?? []).push(r)
    return acc
  }, {} as Record<string, typegraphResult[]>)
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
