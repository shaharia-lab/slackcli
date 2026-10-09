// `conversations unread --messages` (#361): the unread messages themselves,
// grouped by conversation, plus the followed threads with unread replies.
// Browser auth only. The grouping, the cut at the read cursor and the thread
// view normalisation are pure, so they are tested without a transport; the two
// fetch functions take the client and make every call one at a time.
//
// This module moves more message content than any other. It logs IDs, counts
// and durations only: never text, blocks, attachments or file names.
import { getLogger } from '@logtape/logtape';
import type { SlackClient } from './slack-client.ts';
import type {
  SlackFile, SlackMessage, SlackUser, UnreadChannel, UnreadCursor, UnreadThread, UnreadThreads,
} from '../types/index.ts';
import { InvalidInputError } from './cli-errors.ts';
import { compareTs, filterNewerThan } from './poll.ts';
import { hasUnreadThreads } from './unread.ts';

const logger = getLogger(['slackcli', 'unread']);

export const DEFAULT_MAX_CONVERSATIONS = 10;
export const DEFAULT_MESSAGE_LIMIT = 20;
// conversations.history returns at most 999 messages per call.
export const MAX_MESSAGE_LIMIT = 999;
// The Threads view returns 10 threads per page. Five pages bound the cost of a
// long backlog; past that the list is reported as incomplete.
export const MAX_THREAD_PAGES = 5;

export interface UnreadMessageOptions {
  maxConversations: number;
  limit: number;
}

type MessageReader = Pick<SlackClient, 'getConversationHistory'>;
type ThreadViewReader = Pick<SlackClient, 'getUnreadThreadView'>;
type DetailsClient = MessageReader & ThreadViewReader & Pick<SlackClient, 'getUsersInfo'>;

function positiveInteger(value: string, flag: string, max?: number): number {
  const trimmed = value.trim();
  const parsed = /^[1-9]\d*$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max)) {
    const range = max === undefined ? 'a positive integer' : `an integer from 1 to ${max}`;
    throw new InvalidInputError(`${flag} must be ${range}, got "${value}"`);
  }
  return parsed;
}

/**
 * Read and validate the `--messages` flags of `conversations unread`. Returns
 * undefined when `--messages` was not given. Throws InvalidInputError when
 * `--max-conversations` or `--limit` is given without it, or is not a positive
 * integer. Call it before any Slack request.
 */
export function unreadMessageOptions(options: {
  messages?: boolean;
  maxConversations?: string;
  limit?: string;
}): UnreadMessageOptions | undefined {
  if (!options.messages) {
    for (const [value, flag] of [[options.maxConversations, '--max-conversations'], [options.limit, '--limit']] as const) {
      if (value !== undefined) throw new InvalidInputError(`${flag} only applies with --messages; add --messages`);
    }
    return undefined;
  }
  return {
    maxConversations: options.maxConversations === undefined
      ? DEFAULT_MAX_CONVERSATIONS
      : positiveInteger(options.maxConversations, '--max-conversations'),
    limit: options.limit === undefined
      ? DEFAULT_MESSAGE_LIMIT
      : positiveInteger(options.limit, '--limit', MAX_MESSAGE_LIMIT),
  };
}

function isTs(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value);
}

/**
 * Whether a read cursor can be sent as `oldest`. A conversation that was never
 * read reports `0000000000.000000`, which conversations.history rejects with
 * `invalid_ts_oldest`, so an all-zero or malformed cursor counts as none.
 */
export function isUsableCursor(cursor: unknown): cursor is string {
  return isTs(cursor) && /[1-9]/.test(cursor);
}

/**
 * The conversations to read: mentions first, in the order given otherwise
 * (fetchUnread already sorts by name), capped at `max`.
 */
export function selectConversations(channels: UnreadChannel[], max: number): UnreadChannel[] {
  // Array.prototype.sort is stable, so equal mention counts keep their order.
  return [...channels].sort((a, b) => b.mention_count - a.mention_count).slice(0, Math.max(0, max));
}

const FILE_KEYS = [
  'id', 'name', 'title', 'mimetype', 'filetype', 'size', 'url_private', 'permalink', 'mode',
] as const satisfies ReadonlyArray<keyof SlackFile>;

const MESSAGE_KEYS = [
  'ts', 'thread_ts', 'user', 'text', 'type', 'reply_count', 'reactions', 'bot_id', 'blocks', 'attachments',
] as const satisfies ReadonlyArray<keyof SlackMessage>;

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * One raw Slack message reduced to the fields `conversations read --json`
 * prints, so the two commands agree. Returns undefined for anything without a
 * usable `ts`, which nothing downstream could order or cite.
 */
export function toUnreadMessage(raw: unknown): SlackMessage | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (!isTs(source.ts)) return undefined;
  const message = pick(source, MESSAGE_KEYS);
  if (typeof message.text !== 'string') message.text = '';
  if (typeof message.type !== 'string') message.type = 'message';
  if (Array.isArray(source.files) && source.files.length > 0) {
    message.files = source.files
      .filter((file) => file !== null && typeof file === 'object')
      .map((file) => pick(file as Record<string, unknown>, FILE_KEYS));
  }
  return message as unknown as SlackMessage;
}

function oldestFirst(messages: SlackMessage[]): SlackMessage[] {
  return [...messages].sort((a, b) => compareTs(a.ts, b.ts));
}

export interface UnreadCut {
  messages: SlackMessage[];
  has_more: boolean;
}

/**
 * The unread part of one raw page: only messages strictly newer than
 * `lastRead`, oldest first, at most `limit`. With a cursor the earliest unread
 * messages are kept, so reading continues in order; without a usable one the
 * newest `limit` are kept, since nothing says where the unread part starts.
 * `has_more` is set when the cap dropped messages.
 */
export function cutAtLastRead(rawMessages: unknown, lastRead: string | undefined, limit: number): UnreadCut {
  const usable = isUsableCursor(lastRead);
  const all = (Array.isArray(rawMessages) ? rawMessages : [])
    .map(toUnreadMessage)
    .filter((message): message is SlackMessage => message !== undefined);
  const unread = oldestFirst(usable ? filterNewerThan(all, lastRead) : all);
  if (unread.length <= limit) return { messages: unread, has_more: false };
  return { messages: usable ? unread.slice(0, limit) : unread.slice(-limit), has_more: true };
}

/**
 * Read the unread messages of the first `maxConversations` conversations, one
 * call each, in order. Every conversation comes back with its cursors; only
 * the ones that were read carry `messages`. A failing read fails the call.
 */
export async function fetchUnreadMessages(
  client: MessageReader,
  channels: UnreadChannel[],
  cursors: Record<string, UnreadCursor> = {},
  options: UnreadMessageOptions & { onProgress?: (message: string) => void },
): Promise<UnreadChannel[]> {
  const selected = selectConversations(channels, options.maxConversations);
  const read = new Map<string, UnreadCut>();
  const startedAt = performance.now();
  let messageCount = 0;

  for (const [index, channel] of selected.entries()) {
    options.onProgress?.(`Reading unread messages (${index + 1}/${selected.length})...`);
    const lastRead = cursors[channel.id]?.last_read;
    const channelStartedAt = performance.now();
    const response = await client.getConversationHistory(channel.id, {
      oldest: isUsableCursor(lastRead) ? lastRead : undefined,
      limit: options.limit,
    });
    const cut = cutAtLastRead(response?.messages, lastRead, options.limit);
    const hasMore = cut.has_more || response?.has_more === true;
    read.set(channel.id, { messages: cut.messages, has_more: hasMore });
    messageCount += cut.messages.length;
    logger.debug('Read {message_count} unread messages of {channel_id}', {
      channel_id: channel.id,
      message_count: cut.messages.length,
      has_more: hasMore,
      has_cursor: isUsableCursor(lastRead),
      duration_ms: Math.round(performance.now() - channelStartedAt),
    });
  }

  logger.info('Read unread messages of {conversations_read} of {conversations} conversations', {
    conversations: channels.length,
    conversations_read: selected.length,
    message_count: messageCount,
    duration_ms: Math.round(performance.now() - startedAt),
  });

  // The selection only decides which conversations are read; the list keeps
  // the order it came in.
  return channels.map((channel) => {
    const cut = read.get(channel.id);
    return {
      ...channel,
      ...cursors[channel.id],
      ...(cut ? { messages: cut.messages } : {}),
      ...(cut?.has_more ? { has_more: true } : {}),
    };
  });
}

export interface ThreadViewPage {
  threads: UnreadThread[];
  /** `current_ts` for the next page; undefined when this page gives none. */
  nextCursor?: string;
  /** True when no later page can hold an unread thread. */
  done: boolean;
  /** Entries that are a thread with no unread reply. */
  read: number;
  /** Entries that could not be read as a thread at all. */
  malformed: number;
}

// One entry of the view: an unread thread, a thread with nothing unread, or
// something that is not recognisably a thread. The last two must stay apart: a
// read thread ends the unread section, an unreadable entry says the list
// cannot be trusted.
function normalizeThread(raw: unknown, limit: number): UnreadThread | 'read' | 'malformed' {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'malformed';
  const { root_msg: rootRaw, unread_replies: repliesRaw } = raw as Record<string, unknown>;
  const root = toUnreadMessage(rootRaw);
  const channelId = (rootRaw as Record<string, unknown> | null | undefined)?.channel;
  if (!root || typeof channelId !== 'string' || channelId === '') return 'malformed';
  // A read thread carries no unread_replies key.
  if (repliesRaw === undefined || repliesRaw === null) return 'read';
  if (!Array.isArray(repliesRaw)) return 'malformed';
  if (repliesRaw.length === 0) return 'read';
  const replies = oldestFirst(
    repliesRaw.map(toUnreadMessage).filter((message): message is SlackMessage => message !== undefined),
  );
  if (replies.length === 0) return 'malformed';
  const capped = replies.length > limit;
  return {
    channel_id: channelId,
    thread_ts: isTs(root.thread_ts) ? root.thread_ts : root.ts,
    root,
    unread_replies: capped ? replies.slice(0, limit) : replies,
    ...(capped ? { has_more: true } : {}),
  };
}

/**
 * One page of `subscriptions.thread.getView` as unread threads. The method is
 * undocumented, so nothing about its shape is trusted: returns undefined when
 * the response has no `threads` array, and counts every entry that is not a
 * thread with a root message, a channel and a list of replies as `malformed`.
 *
 * Observed on a live workspace (2026-10-10): the view lists the threads with
 * unread replies first, then the read ones, newest activity first, 10 per
 * page. So a page holding a read thread is the last one worth reading. The
 * next page is asked for with `current_ts` set to the last thread's
 * `root_msg.latest_reply` (equal to its newest unread reply), an exclusive
 * upper bound. The response's own `max_ts` is not that cursor: it is newer
 * than every thread on the page, and sending it back returns the same page.
 */
export function normalizeThreadView(raw: unknown, limit: number): ThreadViewPage | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { threads: rawThreads, has_more: hasMore } = raw as Record<string, unknown>;
  if (!Array.isArray(rawThreads)) return undefined;

  const threads: UnreadThread[] = [];
  let read = 0;
  let malformed = 0;
  for (const rawThread of rawThreads) {
    const thread = normalizeThread(rawThread, limit);
    if (thread === 'read') read += 1;
    else if (thread === 'malformed') malformed += 1;
    else threads.push(thread);
  }

  const last = rawThreads.at(-1) as Record<string, any> | null | undefined;
  const latestReply = last?.root_msg?.latest_reply;
  const lastUnread = Array.isArray(last?.unread_replies) ? last.unread_replies.at(-1)?.ts : undefined;
  const nextCursor = [latestReply, lastUnread].find(isUsableCursor);

  return {
    threads,
    ...(nextCursor ? { nextCursor } : {}),
    done: hasMore !== true || read > 0,
    read,
    malformed,
  };
}

// Why a thread view call failed, as a code: Slack's own error code, else the
// error class. Never the message, which is free text.
function failureCode(err: unknown): string {
  const slackError = (err as { slackData?: { error?: unknown } } | null)?.slackData?.error;
  if (typeof slackError === 'string') return slackError;
  return err instanceof Error ? err.name : 'unknown';
}

export interface UnreadThreadList {
  items: UnreadThread[];
  /** True when the page cap, an unreadable entry or a failing later page left the list incomplete. */
  has_more: boolean;
}

/**
 * The followed threads with unread replies, following the view's pages up to
 * MAX_THREAD_PAGES. Never throws. A failure, an unexpected shape, or a page of
 * entries none of which is a thread returns undefined when nothing was read
 * yet, so the caller falls back to the aggregate summary; after that it
 * returns what was read, marked incomplete. A single unreadable entry among
 * readable ones is skipped and also marks the list incomplete.
 */
export async function fetchUnreadThreads(
  client: ThreadViewReader,
  options: { limit: number; onProgress?: (message: string) => void },
): Promise<UnreadThreadList | undefined> {
  const items: UnreadThread[] = [];
  const seen = new Set<string>();
  const startedAt = performance.now();
  let cursor: string | undefined;
  let skipped = 0;

  // `unusable` exits give up on the view: with nothing read yet there is no list to report.
  const stop = (page: number, reason: string, outcome: 'complete' | 'incomplete' | 'unusable'): UnreadThreadList | undefined => {
    const hasMore = outcome !== 'complete' || skipped > 0;
    logger.info('Read {thread_count} unread threads in {pages} pages ({reason})', {
      thread_count: items.length,
      pages: page,
      reason,
      skipped_entries: skipped,
      has_more: hasMore,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return outcome === 'unusable' && page === 1 ? undefined : { items, has_more: hasMore };
  };

  for (let page = 1; page <= MAX_THREAD_PAGES; page++) {
    options.onProgress?.('Reading unread threads...');
    let view: ThreadViewPage | undefined;
    try {
      view = normalizeThreadView(await client.getUnreadThreadView(cursor ? { current_ts: cursor } : {}), options.limit);
    } catch (err) {
      logger.warn('Unread thread view failed on page {page}: {reason}', { page, reason: failureCode(err) });
      return stop(page, 'request_failed', 'unusable');
    }
    if (!view) {
      logger.warn('Unread thread view returned an unexpected shape on page {page}', { page });
      return stop(page, 'unexpected_shape', 'unusable');
    }
    if (view.malformed > 0) {
      logger.warn('Unread thread view had {malformed} unreadable entries on page {page}', { page, malformed: view.malformed });
      skipped += view.malformed;
      // Not one entry of the page is a thread: the shape has changed.
      if (view.threads.length === 0 && view.read === 0) return stop(page, 'unexpected_shape', 'unusable');
    }

    for (const thread of view.threads) {
      const key = `${thread.channel_id}:${thread.thread_ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(thread);
    }

    if (view.done) return stop(page, 'end_of_unread', 'complete');
    // No cursor, or one that did not move: the next call would repeat this page.
    if (!view.nextCursor || view.nextCursor === cursor) return stop(page, 'no_cursor', 'incomplete');
    cursor = view.nextCursor;
  }

  return stop(MAX_THREAD_PAGES, 'page_cap', 'incomplete');
}

export interface UnreadDetails {
  channels: UnreadChannel[];
  threads?: UnreadThreads;
  users: Map<string, SlackUser>;
  /** True when the thread list could not be read and only the summary is reported. */
  threadsUnavailable: boolean;
}

function authorsOf(channels: UnreadChannel[], threads: UnreadThread[]): string[] {
  const ids = new Set<string>();
  const add = (message: SlackMessage) => { if (message.user) ids.add(message.user); };
  for (const channel of channels) channel.messages?.forEach(add);
  for (const thread of threads) {
    add(thread.root);
    thread.unread_replies.forEach(add);
  }
  return [...ids];
}

/**
 * Everything `--messages` adds to the unread summary: the messages of the
 * selected conversations, the unread threads under `threads.items`, and the
 * authors. The thread view is skipped when client.counts already says no
 * thread is unread, and its failure never fails the call.
 */
export async function fetchUnreadDetails(
  client: DetailsClient,
  summary: { channels: UnreadChannel[]; threads?: UnreadThreads; cursors?: Record<string, UnreadCursor> },
  options: UnreadMessageOptions & { onProgress?: (message: string) => void },
): Promise<UnreadDetails> {
  const channels = await fetchUnreadMessages(client, summary.channels, summary.cursors, options);

  let threads = summary.threads;
  let threadsUnavailable = false;
  if (threads && !hasUnreadThreads(threads)) {
    threads = { ...threads, items: [] };
  } else {
    const list = await fetchUnreadThreads(client, options);
    if (!list) {
      threadsUnavailable = true;
    } else if (threads || list.items.length > 0) {
      threads = {
        ...(threads ?? { has_unreads: true, mention_count: 0 }),
        items: list.items,
        ...(list.has_more ? { has_more: true } : {}),
      };
    }
  }

  const users = new Map<string, SlackUser>();
  const authors = authorsOf(channels, threads?.items ?? []);
  if (authors.length > 0) {
    options.onProgress?.('Fetching user information...');
    const response = await client.getUsersInfo(authors);
    response.users?.forEach((user: SlackUser) => users.set(user.id, user));
  }

  return { channels, ...(threads ? { threads } : {}), users, threadsUnavailable };
}
