import { getLogger } from '@logtape/logtape';
import type { SlackClient } from './slack-client.ts';
import type { ResolvedThreadTarget } from './slack-url-parser.ts';
import type { SlackMessage } from '../types/index.ts';
import { errorMessageForLog } from './tildify.ts';

const logger = getLogger(['slackcli', 'threads']);

/**
 * The parent timestamp when `ts` turns out to be a thread reply, judged from the
 * messages `conversations.replies` returned for `ts`; otherwise undefined.
 *
 * Given a parent's ts, Slack returns the parent first (its `thread_ts` equals its
 * own ts). Given a reply's ts, it returns only that reply, whose `thread_ts` names
 * the parent. A message with no thread has no `thread_ts` at all.
 */
export function replyParentTs(
  messages: Array<Pick<SlackMessage, 'ts' | 'thread_ts'>> | undefined,
  ts: string,
): string | undefined {
  const first = messages?.[0];
  if (first?.ts !== ts || !first.thread_ts || first.thread_ts === ts) return undefined;
  return first.thread_ts;
}

/**
 * The thread parent of the message at `ts`: its parent's ts when it is a reply,
 * otherwise `ts` itself. Costs one `conversations.replies` call.
 *
 * Used where the caller only has a message link without `?thread_ts=`. A failed
 * lookup (a token that can post but not read the channel, say) falls back to
 * `ts`, which is what the caller would have used before, so it never blocks a send.
 */
export async function resolveThreadParent(
  client: Pick<SlackClient, 'getConversationReplies'>,
  channelId: string,
  ts: string,
): Promise<string> {
  try {
    const response = await client.getConversationReplies(channelId, ts, { limit: 1 });
    return replyParentTs(response?.messages, ts) ?? ts;
  } catch (error) {
    logger.warn('Could not look up the thread parent of {ts} in {channel_id}; using the link timestamp: {error}', {
      ts,
      channel_id: channelId,
      error: errorMessageForLog(error),
    });
    return ts;
  }
}

/**
 * Read one page of a thread from any of its messages' ts. When `ts` is a reply,
 * the first call returns only that reply, so the thread is read again from the
 * parent: one extra call for a reply, none for a parent (#482).
 */
export async function fetchThreadReplies(
  client: Pick<SlackClient, 'getConversationReplies'>,
  channelId: string,
  ts: string,
  options: { limit?: number; oldest?: string; latest?: string } = {},
): Promise<any> {
  const response = await client.getConversationReplies(channelId, ts, options);
  const parentTs = replyParentTs(response?.messages, ts);
  return parentTs ? client.getConversationReplies(channelId, parentTs, options) : response;
}

/**
 * The thread target to post under: a target whose thread ts may be a reply's
 * (`mayBeReply`, a message link without `?thread_ts=`) gets its parent's ts;
 * every other target is returned as is, with no Slack call.
 */
export async function resolvePostThread<T extends Pick<ResolvedThreadTarget, 'threadTs' | 'mayBeReply'>>(
  client: Pick<SlackClient, 'getConversationReplies'>,
  channelId: string,
  target: T,
): Promise<T> {
  if (!target.mayBeReply || !target.threadTs) return target;
  return { ...target, threadTs: await resolveThreadParent(client, channelId, target.threadTs) };
}
