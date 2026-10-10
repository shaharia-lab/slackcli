import type { SlackClient } from './slack-client.ts';
import type { UnreadChannel, UnreadCursor, UnreadSummary, UnreadThreads } from '../types/index.ts';

// The `threads` block of client.counts, reduced to the two fields the CLI
// reports. Returns undefined when Slack sent no usable block, so callers can
// tell "no unread threads" from "not reported".
export function normalizeUnreadThreads(raw: unknown): UnreadThreads | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { has_unreads: hasUnreads, mention_count: mentionCount } = raw as Record<string, unknown>;
  const mentions = typeof mentionCount === 'number' && Number.isFinite(mentionCount) && mentionCount > 0
    ? Math.floor(mentionCount)
    : 0;
  return { has_unreads: hasUnreads === true, mention_count: mentions };
}

// A thread mention counts as unread activity even if Slack left has_unreads
// false, the same rule the channel filter below applies.
export function hasUnreadThreads(threads: UnreadThreads | undefined): boolean {
  return threads !== undefined && (threads.has_unreads || threads.mention_count > 0);
}

// What one auth path found; fetchUnread sorts the list and builds the summary.
interface UnreadParts {
  channels: UnreadChannel[];
  threads?: UnreadThreads;
  cursors?: Record<string, UnreadCursor>;
}

// The read cursors of the unread conversations, kept beside the list and
// not on it so the default output stays as it was; `--messages` reads each
// conversation from its cursor (#361). Left out when Slack sent none.
function collectCursors(allChannels: any[], channels: UnreadChannel[]): Record<string, UnreadCursor> | undefined {
  const found: Record<string, UnreadCursor> = {};
  for (const ch of allChannels) {
    if (!channels.some((unread) => unread.id === ch.id)) continue;
    const cursor: UnreadCursor = {};
    if (typeof ch.last_read === 'string') cursor.last_read = ch.last_read;
    if (typeof ch.latest === 'string') cursor.latest = ch.latest;
    if (Object.keys(cursor).length > 0) found[ch.id] = cursor;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

// The other person's name for a DM, or their user ID when the lookup fails.
async function resolveUserName(client: SlackClient, userId: string): Promise<string> {
  try {
    const userInfo = await client.getUserInfo(userId);
    return userInfo.user?.real_name || userInfo.user?.name || userId;
  } catch {
    return userId;
  }
}

// Fills in the name and type flags of one unread conversation, in place. A
// failed lookup leaves the channel ID as the name.
async function resolveChannelName(client: SlackClient, ch: UnreadChannel): Promise<void> {
  try {
    const info = await client.getConversationInfo(ch.id);
    if (info.channel) {
      ch.is_im = info.channel.is_im;
      ch.is_mpim = info.channel.is_mpim;
      ch.is_private = info.channel.is_private;
      if (info.channel.is_im && info.channel.user) {
        ch.name = await resolveUserName(client, info.channel.user);
      } else {
        ch.name = info.channel.name || ch.id;
      }
    }
  } catch {
    ch.name = ch.id;
  }
}

// client.counts response
async function browserUnread(
  client: SlackClient,
  response: any,
  options: { onProgress?: (message: string) => void },
): Promise<UnreadParts> {
  const allChannels = [
    ...(response.channels || []),
    ...(response.mpims || []),
    ...(response.ims || []),
  ];
  const threads = normalizeUnreadThreads(response.threads);

  const channels: UnreadChannel[] = allChannels
    .filter((ch: any) => ch.has_unreads || (ch.mention_count && ch.mention_count > 0))
    .map((ch: any) => ({
      id: ch.id,
      mention_count: ch.mention_count || 0,
      has_unreads: ch.has_unreads || false,
    }));

  const cursors = collectCursors(allChannels, channels);

  // Resolve channel names in parallel
  // NOTE: may hit Slack rate limits with many unread channels
  options.onProgress?.('Fetching channel details...');
  await Promise.all(channels.map((ch) => resolveChannelName(client, ch)));

  return { channels, threads, cursors };
}

// conversations.list response. It has no thread equivalent, so an app token
// reports none, and no read cursors either.
function standardUnread(response: any): UnreadParts {
  const channels: UnreadChannel[] = (response.channels || [])
    .filter((ch: any) => ch.is_member && (ch.unread_count > 0 || ch.unread_count_display > 0))
    .map((ch: any) => ({
      id: ch.id,
      name: ch.name,
      mention_count: ch.mention_count_display || 0,
      unread_count: ch.unread_count_display || ch.unread_count || 0,
      has_unreads: true,
      is_im: ch.is_im,
      is_mpim: ch.is_mpim,
      is_private: ch.is_private,
    }));
  return { channels };
}

export async function fetchUnread(
  client: SlackClient,
  options: {
    onProgress?: (message: string) => void;
  } = {},
): Promise<UnreadSummary> {
  const response = await client.getUnreadCounts();
  const { channels, threads, cursors } = client.authType === 'browser'
    ? await browserUnread(client, response, options)
    : standardUnread(response);

  // Sort: mentions first, then alphabetical
  channels.sort((a, b) => {
    if (a.mention_count !== b.mention_count) return b.mention_count - a.mention_count;
    return (a.name || '').localeCompare(b.name || '');
  });

  return { channels, ...(threads ? { threads } : {}), ...(cursors ? { cursors } : {}) };
}
