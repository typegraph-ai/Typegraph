import type { RawDocument } from '@d8um-ai/core'
import type { GmailRawMessage, GmailRawMessagePart } from '../types.js'
import type { GmailMessage } from '../models.js'

/**
 * Extract a header value from a Gmail message payload.
 */
function getHeader(payload: GmailRawMessagePart | undefined, name: string): string | undefined {
  return payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value
}

/**
 * Extract the plain text body from a Gmail message payload.
 * Recursively searches through MIME parts for text/plain content.
 */
function extractTextBody(payload: GmailRawMessagePart | undefined): string | undefined {
  if (!payload) return undefined

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractTextBody(part)
      if (text) return text
    }
  }

  return undefined
}

/**
 * Extract the HTML body from a Gmail message payload.
 * Recursively searches through MIME parts for text/html content.
 */
function extractHtmlBody(payload: GmailRawMessagePart | undefined): string | undefined {
  if (!payload) return undefined

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractHtmlBody(part)
      if (html) return html
    }
  }

  return undefined
}

/**
 * Extract attachment metadata from a Gmail message payload.
 */
function extractAttachments(payload: GmailRawMessagePart | undefined): Array<{
  filename: string
  mimeType: string
  size: number
  attachmentId?: string | undefined
}> {
  const attachments: Array<{
    filename: string
    mimeType: string
    size: number
    attachmentId?: string | undefined
  }> = []

  if (!payload) return attachments

  if (payload.filename && payload.filename.length > 0 && payload.body) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: payload.body.size,
      attachmentId: payload.body.attachmentId,
    })
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part))
    }
  }

  return attachments
}

/**
 * Transform a raw Gmail API message into a normalized GmailMessage.
 */
export function toGmailMessage(raw: GmailRawMessage): GmailMessage {
  const attachments = extractAttachments(raw.payload)

  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds,
    snippet: raw.snippet,
    from: getHeader(raw.payload, 'From'),
    to: getHeader(raw.payload, 'To'),
    cc: getHeader(raw.payload, 'Cc'),
    subject: getHeader(raw.payload, 'Subject'),
    date: getHeader(raw.payload, 'Date'),
    body: {
      text: extractTextBody(raw.payload),
      html: extractHtmlBody(raw.payload),
    },
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

/**
 * Transform a raw Gmail API message into a RawDocument for indexing.
 */
export function toMessageDocument(raw: GmailRawMessage): RawDocument {
  const subject = getHeader(raw.payload, 'Subject') ?? 'No Subject'
  const from = getHeader(raw.payload, 'From') ?? 'Unknown'
  const to = getHeader(raw.payload, 'To') ?? ''
  const date = getHeader(raw.payload, 'Date')
  const textBody = extractTextBody(raw.payload)
  const attachments = extractAttachments(raw.payload)

  const contentParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    textBody ?? raw.snippet ?? '',
  ].filter(Boolean)

  return {
    id: `gmail-msg-${raw.id}`,
    content: contentParts.join('\n'),
    title: subject,
    updatedAt: raw.internalDate ? new Date(parseInt(raw.internalDate, 10)) : new Date(),
    metadata: {
      messageId: raw.id,
      threadId: raw.threadId,
      from,
      to,
      subject,
      date,
      labelIds: raw.labelIds,
      hasAttachments: attachments.length > 0,
      attachmentCount: attachments.length,
      snippet: raw.snippet,
      isUnread: raw.labelIds?.includes('UNREAD') ?? false,
      isInbox: raw.labelIds?.includes('INBOX') ?? false,
    },
  }
}
