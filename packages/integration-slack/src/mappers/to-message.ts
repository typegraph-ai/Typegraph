import type { RawDocument } from '@d8um-ai/core'
import type { SlackRawMessage } from '../types.js'
import type { SlackMessage } from '../models.js'

/**
 * Transform a raw Slack API message into a normalized SlackMessage.
 */
export function toSlackMessage(raw: SlackRawMessage, channelId: string): SlackMessage {
  return {
    id: raw.ts,
    channelId,
    userId: raw.user ?? raw.bot_id ?? 'unknown',
    text: raw.text,
    timestamp: raw.ts,
    threadTs: raw.thread_ts,
    replyCount: raw.reply_count,
    reactions: raw.reactions?.map(r => ({
      name: r.name,
      count: r.count,
      users: r.users,
    })),
    attachments: raw.attachments,
    edited: raw.edited,
  }
}

/**
 * Transform a raw Slack API message into a RawDocument for indexing.
 */
export function toMessageDocument(raw: SlackRawMessage, channelId: string, channelName: string): RawDocument {
  return {
    id: `slack-msg-${channelId}-${raw.ts}`,
    content: raw.text,
    title: `Slack message in #${channelName}`,
    updatedAt: new Date(parseFloat(raw.ts) * 1000),
    metadata: {
      channelId,
      channelName,
      userId: raw.user ?? raw.bot_id ?? 'unknown',
      threadTs: raw.thread_ts,
      messageType: raw.thread_ts && raw.thread_ts !== raw.ts ? 'thread_reply' : 'message',
      replyCount: raw.reply_count,
      hasAttachments: (raw.attachments?.length ?? 0) > 0,
    },
  }
}
