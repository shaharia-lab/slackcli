import type { SlackClient } from './slack-client.ts';
import type { SlackMessage } from '../types/index.ts';

/**
 * Fetch a single message by channel ID and timestamp.
 *
 * Browser auth uses messages.list which resolves both top-level messages
 * and thread replies in a single call.
 *
 * Standard auth can only resolve top-level messages via conversations.history.
 * Thread replies require the parent thread_ts for conversations.replies, which
 * is not available when you only have the reply's timestamp. There is no public
 * Slack API to look up an arbitrary reply by timestamp alone.
 */
export async function fetchMessage(
  client: SlackClient,
  channelId: string,
  timestamp: string,
): Promise<SlackMessage | undefined> {
  if (client.authType === 'browser') {
    const response = await client.listMessages([{ channel: channelId, timestamps: [timestamp] }]);
    const msgs = response.messages?.[channelId] || [];
    return msgs[0];
  }

  // Standard auth: can only resolve top-level messages.
  const history = await client.getConversationHistory(channelId, {
    latest: timestamp,
    oldest: timestamp,
    inclusive: true,
    limit: 1,
  });
  return history.messages?.[0];
}

export interface DeletedMessageResult {
  channel_id: string;
  ts: string;
  deleted: boolean;
  already_deleted: boolean;
}

/**
 * Delete a message the caller posted. Idempotent: Slack's message_not_found is
 * a success with `deleted: false, already_deleted: true`, so a retry is safe.
 * Slack cannot tell an already-deleted message from a wrong timestamp, so
 * callers must not claim a delete happened. Every other failure is rethrown.
 */
export async function deleteMessage(
  client: Pick<SlackClient, 'deleteMessage'>,
  channelId: string,
  timestamp: string,
): Promise<DeletedMessageResult> {
  try {
    await client.deleteMessage(channelId, timestamp);
    return { channel_id: channelId, ts: timestamp, deleted: true, already_deleted: false };
  } catch (error) {
    if ((error as { slackData?: { error?: unknown } })?.slackData?.error !== 'message_not_found') throw error;
    return { channel_id: channelId, ts: timestamp, deleted: false, already_deleted: true };
  }
}
