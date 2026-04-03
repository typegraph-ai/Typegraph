import type { RawDocument } from '@d8um-ai/core'
import type { LinearRawIssue } from '../types.js'
import type { LinearIssue } from '../models.js'

/**
 * Transform a raw Linear GraphQL issue into a normalized LinearIssue.
 */
export function toLinearIssue(raw: LinearRawIssue): LinearIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    state: {
      name: raw.state.name,
      type: raw.state.type,
    },
    assignee: raw.assignee
      ? { name: raw.assignee.name, email: raw.assignee.email }
      : undefined,
    labels: raw.labels.nodes.map(l => l.name),
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    dueDate: raw.dueDate ? new Date(raw.dueDate) : undefined,
    estimate: raw.estimate,
    url: raw.url,
  }
}

/**
 * Transform a raw Linear GraphQL issue into a RawDocument for indexing.
 */
export function toIssueDocument(raw: LinearRawIssue): RawDocument {
  return {
    id: `linear-issue-${raw.id}`,
    content: [raw.title, raw.description].filter(Boolean).join('\n\n'),
    title: `${raw.identifier}: ${raw.title}`,
    updatedAt: new Date(raw.updatedAt),
    metadata: {
      identifier: raw.identifier,
      priority: raw.priority,
      priorityLabel: raw.priorityLabel,
      state: raw.state.name,
      stateType: raw.state.type,
      assignee: raw.assignee?.name,
      teamKey: raw.team.key,
      teamName: raw.team.name,
      projectName: raw.project?.name,
      labels: raw.labels.nodes.map(l => l.name),
      dueDate: raw.dueDate,
      estimate: raw.estimate,
      url: raw.url,
    },
  }
}
