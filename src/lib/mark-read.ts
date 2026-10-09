import { getLogger } from '@logtape/logtape';
import type { SlackClient } from './slack-client.ts';
import { errorMessageForLog } from './tildify.ts';
import type { MarkReadResult } from '../types/index.ts';

// `conversations mark-read` (#362): move the read cursor of one channel or DM
// to an explicit message, and report the cursor it replaced so the change can
// be undone by marking back to that value.

const logger = getLogger(['slackcli', 'mark-read']);

type CursorClient = Pick<SlackClient, 'getConversationInfo'>;
type MarkClient = CursorClient & Pick<SlackClient, 'markConversation'>;

/**
 * The read cursor in a conversations.info response: `channel.last_read` when
 * it is a non-empty string, otherwise null (Slack leaves it out for some
 * tokens and conversation kinds).
 */
export function readCursorOf(info: unknown): string | null {
  const lastRead = (info as { channel?: { last_read?: unknown } } | null | undefined)?.channel?.last_read;
  return typeof lastRead === 'string' && lastRead ? lastRead : null;
}

/**
 * The conversation's read cursor right now, or null when Slack does not
 * report one. Best effort: the cursor only makes the write undoable, so a
 * failed read gives null instead of blocking the write.
 */
export async function previousLastRead(client: CursorClient, channelId: string): Promise<string | null> {
  try {
    return readCursorOf(await client.getConversationInfo(channelId));
  } catch (err) {
    logger.warn('Could not read the current read cursor: {error}', {
      channel_id: channelId,
      method: 'conversations.info',
      error: errorMessageForLog(err),
    });
    return null;
  }
}

/** Read the current cursor, then move it to `ts`. */
export async function markConversationRead(client: MarkClient, channelId: string, ts: string): Promise<MarkReadResult> {
  const previous = await previousLastRead(client, channelId);
  await client.markConversation(channelId, ts);
  return { channel_id: channelId, ts, previous_last_read: previous };
}
