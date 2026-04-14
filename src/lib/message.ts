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
