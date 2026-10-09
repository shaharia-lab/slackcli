import { afterEach, describe, expect, it } from 'bun:test';
import { resetSync, type LogRecord } from '@logtape/logtape';
import { InvalidInputError } from './cli-errors.ts';
import { configureLogging } from './logger.ts';
import {
  cutAtLastRead,
  DEFAULT_MAX_CONVERSATIONS,
  DEFAULT_MESSAGE_LIMIT,
  fetchUnreadDetails,
  fetchUnreadMessages,
  fetchUnreadThreads,
  isUsableCursor,
  MAX_THREAD_PAGES,
  normalizeThreadView,
  selectConversations,
  toUnreadMessage,
  unreadMessageOptions,
} from './unread-messages.ts';
import type { UnreadChannel } from '../types/index.ts';

const channel = (id: string, mentions = 0): UnreadChannel => ({ id, name: id.toLowerCase(), mention_count: mentions, has_unreads: true });
const message = (ts: string, extra: Record<string, unknown> = {}) => ({ type: 'message', user: 'U1', text: `text ${ts}`, ts, ...extra });

// A thread as subscriptions.thread.getView returns it.
const rawThread = (channelId: string, rootTs: string, replyTs: string[], extra: Record<string, unknown> = {}) => ({
  root_msg: { ...message(rootTs), thread_ts: rootTs, channel: channelId, latest_reply: replyTs.at(-1) ?? rootTs, last_read: rootTs, ...extra },
  ...(replyTs.length > 0 ? { unread_replies: replyTs.map((ts) => message(ts, { thread_ts: rootTs, user: 'U2' })) } : {}),
});

describe('unreadMessageOptions', () => {
  it('returns undefined without --messages', () => {
    expect(unreadMessageOptions({})).toBeUndefined();
    expect(unreadMessageOptions({ messages: false })).toBeUndefined();
  });

  it('applies the defaults with --messages alone', () => {
    expect(unreadMessageOptions({ messages: true })).toEqual({
      maxConversations: DEFAULT_MAX_CONVERSATIONS,
      limit: DEFAULT_MESSAGE_LIMIT,
    });
    expect(DEFAULT_MAX_CONVERSATIONS).toBe(10);
    expect(DEFAULT_MESSAGE_LIMIT).toBe(20);
  });

  it('parses both caps, trimming spaces', () => {
    expect(unreadMessageOptions({ messages: true, maxConversations: ' 3 ', limit: '999' }))
      .toEqual({ maxConversations: 3, limit: 999 });
  });

  it.each([
    [{ maxConversations: '2' }, '--max-conversations only applies with --messages; add --messages'],
    [{ limit: '5' }, '--limit only applies with --messages; add --messages'],
    [{ messages: false, limit: '5' }, '--limit only applies with --messages; add --messages'],
  ])('refuses a cap without --messages: %j', (options, expected) => {
    expect(() => unreadMessageOptions(options)).toThrow(new InvalidInputError(expected));
  });

  it.each(['0', '-1', '1.5', 'abc', '', ' ', '1e3', '0x10', '+2', '2 3', '99999999999999999999'])(
    'refuses "%s" for either cap',
    (value) => {
      expect(() => unreadMessageOptions({ messages: true, maxConversations: value })).toThrow(InvalidInputError);
      expect(() => unreadMessageOptions({ messages: true, limit: value })).toThrow(InvalidInputError);
    },
  );

  it('caps --limit at what one conversations.history call returns, and names the range', () => {
    expect(() => unreadMessageOptions({ messages: true, limit: '1000' }))
      .toThrow('--limit must be an integer from 1 to 999, got "1000"');
    expect(unreadMessageOptions({ messages: true, maxConversations: '1000' })?.maxConversations).toBe(1000);
    expect(() => unreadMessageOptions({ messages: true, maxConversations: '0' }))
      .toThrow('--max-conversations must be a positive integer, got "0"');
  });
});

describe('isUsableCursor', () => {
  it.each(['1700000000.000100', '1700000000', '0000000001.000000', '0000000000.000001'])('accepts %s', (cursor) => {
    expect(isUsableCursor(cursor)).toBe(true);
  });

  // Slack answers `invalid_ts_oldest` for the never-read cursor.
  it.each([undefined, null, '', '0000000000.000000', '0', '0.0', 'abc', '1700000000.', '.5', 1700000000, '17e8'])(
    'rejects %p',
    (cursor) => {
      expect(isUsableCursor(cursor)).toBe(false);
    },
  );
});

describe('selectConversations', () => {
  it('puts mentions first, keeps the given order otherwise, and caps', () => {
    const channels = [channel('A'), channel('B', 2), channel('C'), channel('D', 5), channel('E', 2)];
    expect(selectConversations(channels, 4).map((ch) => ch.id)).toEqual(['D', 'B', 'E', 'A']);
    expect(selectConversations(channels, 99).map((ch) => ch.id)).toEqual(['D', 'B', 'E', 'A', 'C']);
  });

  it('returns nothing for an empty list or a zero cap, without changing the input', () => {
    const channels = [channel('A'), channel('B', 1)];
    expect(selectConversations([], 3)).toEqual([]);
    expect(selectConversations(channels, 0)).toEqual([]);
    expect(channels.map((ch) => ch.id)).toEqual(['A', 'B']);
  });
});

describe('toUnreadMessage', () => {
  it('keeps the fields conversations read prints and drops the rest', () => {
    const out = toUnreadMessage({
      ...message('1700000000.000100'),
      thread_ts: '1700000000.000100',
      reply_count: 2,
      reactions: [{ name: 'eyes', count: 1, users: ['U1'] }],
      bot_id: 'B1',
      blocks: [{ type: 'rich_text' }],
      attachments: [{ id: 1 }],
      team: 'T1',
      client_msg_id: 'abc',
      bot_profile: { name: 'bot' },
      files: [{ id: 'F1', name: 'a.txt', title: 'A', mimetype: 'text/plain', filetype: 'text', size: 3, url_private: 'https://files.example/a', permalink: 'https://acme.slack.com/files/a', mode: 'hosted', user: 'U1', preview: 'secret preview' }],
    });

    expect(out).toEqual({
      ts: '1700000000.000100',
      thread_ts: '1700000000.000100',
      user: 'U1',
      text: 'text 1700000000.000100',
      type: 'message',
      reply_count: 2,
      reactions: [{ name: 'eyes', count: 1, users: ['U1'] }],
      bot_id: 'B1',
      blocks: [{ type: 'rich_text' }],
      attachments: [{ id: 1 }],
      files: [{ id: 'F1', name: 'a.txt', title: 'A', mimetype: 'text/plain', filetype: 'text', size: 3, url_private: 'https://files.example/a', permalink: 'https://acme.slack.com/files/a', mode: 'hosted' }],
    } as any);
  });

  it('fills in a missing text and type so the message can be printed', () => {
    expect(toUnreadMessage({ ts: '1700000000.000100', text: 5, files: [] })).toEqual({ ts: '1700000000.000100', text: '', type: 'message' });
  });

  // Each case is wrapped: it.each spreads an array row into arguments.
  it.each([null, undefined, 'text', 7, [], {}, { text: 'no ts' }, { ts: 1700000000 }, { ts: 'abc' }].map((raw) => [raw]))(
    'returns undefined for %p',
    (raw) => {
      expect(toUnreadMessage(raw)).toBeUndefined();
    },
  );

  it('drops a files entry that is not an object', () => {
    expect(toUnreadMessage({ ts: '1.1', text: 'x', files: [null, 'F1', { id: 'F2' }] })?.files).toEqual([{ id: 'F2' }]);
  });
});

describe('cutAtLastRead', () => {
  // conversations.history returns newest first.
  const page = ['1700000005.000000', '1700000004.000000', '1700000003.000000', '1700000002.000000', '1700000001.000000'].map((ts) => message(ts));

  it('keeps only messages strictly newer than the cursor, oldest first', () => {
    const cut = cutAtLastRead(page, '1700000003.000000', 20);
    expect(cut.messages.map((m) => m.ts)).toEqual(['1700000004.000000', '1700000005.000000']);
    expect(cut.has_more).toBe(false);
  });

  it('tells messages a microsecond apart from the cursor', () => {
    const close = [message('1700000000.000101'), message('1700000000.000100'), message('1700000000.000099')];
    expect(cutAtLastRead(close, '1700000000.000100', 20).messages.map((m) => m.ts)).toEqual(['1700000000.000101']);
    // An 8-digit fraction collides as a float at this magnitude.
    const wide = [message('1700000000.12345679'), message('1700000000.12345678')];
    expect(cutAtLastRead(wide, '1700000000.12345678', 20).messages.map((m) => m.ts)).toEqual(['1700000000.12345679']);
  });

  it('returns nothing when every message is at or before the cursor', () => {
    expect(cutAtLastRead(page, '1700000005.000000', 20)).toEqual({ messages: [], has_more: false });
    expect(cutAtLastRead(page, '1800000000.000000', 20)).toEqual({ messages: [], has_more: false });
  });

  it('keeps the earliest unread messages when the cap cuts, and says so', () => {
    const cut = cutAtLastRead(page, '1700000001.000000', 2);
    expect(cut.messages.map((m) => m.ts)).toEqual(['1700000002.000000', '1700000003.000000']);
    expect(cut.has_more).toBe(true);
  });

  it('does not flag has_more when the unread messages fit the cap exactly', () => {
    expect(cutAtLastRead(page, '1700000003.000000', 2).has_more).toBe(false);
  });

  it.each([undefined, '', '0000000000.000000', 'not-a-ts'])(
    'keeps the newest messages when the cursor is %p',
    (cursor) => {
      expect(cutAtLastRead(page, cursor, 20).messages).toHaveLength(5);
      const cut = cutAtLastRead(page, cursor, 2);
      expect(cut.messages.map((m) => m.ts)).toEqual(['1700000004.000000', '1700000005.000000']);
      expect(cut.has_more).toBe(true);
    },
  );

  it('ignores entries without a usable ts instead of throwing on them', () => {
    const dirty = [message('1700000002.000000'), { text: 'no ts' }, null, { ts: 'bad', text: 'x' }, message('1700000001.000000')];
    expect(cutAtLastRead(dirty, '1700000000.000000', 20).messages.map((m) => m.ts)).toEqual(['1700000001.000000', '1700000002.000000']);
  });

  it.each([undefined, null, 'messages', {}, 4].map((raw) => [raw]))('treats a %p page as empty', (raw) => {
    expect(cutAtLastRead(raw, '1700000000.000000', 20)).toEqual({ messages: [], has_more: false });
  });
});

describe('fetchUnreadMessages', () => {
  function reader(pages: Record<string, { messages?: unknown; has_more?: boolean }>) {
    const calls: Array<{ channel: string; options: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        getConversationHistory: async (channelId: string, options: Record<string, unknown> = {}) => {
          calls.push({ channel: channelId, options });
          return { ok: true, ...pages[channelId] };
        },
      },
    };
  }

  it('reads each selected conversation from its cursor, in order, one call each', async () => {
    const { client, calls } = reader({
      A: { messages: [message('1700000002.000000'), message('1700000001.000000')] },
      B: { messages: [message('1700000009.000000')] },
    });
    const progress: string[] = [];

    const out = await fetchUnreadMessages(
      client,
      [channel('B', 1), channel('A')],
      { A: { last_read: '1700000001.000000', latest: '1700000002.000000' }, B: { last_read: '1700000008.000000' } },
      { maxConversations: 10, limit: 7, onProgress: (text) => progress.push(text) },
    );

    expect(calls).toEqual([
      { channel: 'B', options: { oldest: '1700000008.000000', limit: 7 } },
      { channel: 'A', options: { oldest: '1700000001.000000', limit: 7 } },
    ]);
    expect(progress).toEqual(['Reading unread messages (1/2)...', 'Reading unread messages (2/2)...']);
    expect(out).toEqual([
      { ...channel('B', 1), last_read: '1700000008.000000', messages: [message('1700000009.000000')] },
      { ...channel('A'), last_read: '1700000001.000000', latest: '1700000002.000000', messages: [message('1700000002.000000')] },
    ] as any);
  });

  it('reads only --max-conversations conversations and leaves messages off the rest', async () => {
    const { client, calls } = reader({});
    const channels = [channel('A', 3), channel('B', 1), channel('C'), channel('D'), channel('E')];

    const out = await fetchUnreadMessages(client, channels, { D: { last_read: '1700000000.000000' } }, { maxConversations: 2, limit: 20 });

    expect(calls.map((call) => call.channel)).toEqual(['A', 'B']);
    expect(out.map((ch) => 'messages' in ch)).toEqual([true, true, false, false, false]);
    expect(out[0].messages).toEqual([]);
    // The cursor is still reported for a conversation that was not read.
    expect(out[3]).toEqual({ ...channel('D'), last_read: '1700000000.000000' });
  });

  it('picks the mentions first when the list is not sorted, and keeps the list order', async () => {
    const { client, calls } = reader({});
    const out = await fetchUnreadMessages(client, [channel('A'), channel('B', 2)], {}, { maxConversations: 1, limit: 20 });

    expect(calls.map((call) => call.channel)).toEqual(['B']);
    expect(out.map((ch) => ch.id)).toEqual(['A', 'B']);
    expect('messages' in out[0]).toBe(false);
  });

  it('sends no oldest for a missing, never-read or malformed cursor', async () => {
    const { client, calls } = reader({ A: { messages: [message('1700000001.000000')] } });

    await fetchUnreadMessages(
      client,
      [channel('A'), channel('B'), channel('C')],
      { B: { last_read: '0000000000.000000' }, C: { last_read: 'garbage' } },
      { maxConversations: 10, limit: 3 },
    );

    expect(calls.map((call) => call.options)).toEqual([
      { oldest: undefined, limit: 3 },
      { oldest: undefined, limit: 3 },
      { oldest: undefined, limit: 3 },
    ]);
  });

  it('sets has_more when Slack says there is more, or when the cap cut the page', async () => {
    const { client } = reader({
      A: { messages: [message('1700000001.000000')], has_more: true },
      B: { messages: [message('1700000003.000000'), message('1700000002.000000'), message('1700000001.000000')] },
      C: { messages: [message('1700000001.000000')], has_more: false },
    });

    const out = await fetchUnreadMessages(client, [channel('A'), channel('B'), channel('C')], {}, { maxConversations: 10, limit: 2 });

    expect(out.map((ch) => ch.has_more)).toEqual([true, true, undefined]);
    expect('has_more' in out[2]).toBe(false);
    expect(out[1].messages).toHaveLength(2);
  });

  it('makes no call for an empty list', async () => {
    const { client, calls } = reader({});
    expect(await fetchUnreadMessages(client, [], undefined, { maxConversations: 10, limit: 20 })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('lets a failing read fail the call', async () => {
    const client = { getConversationHistory: async () => { throw new Error('Slack API error: channel_not_found'); } };
    await expect(fetchUnreadMessages(client, [channel('A')], {}, { maxConversations: 10, limit: 20 }))
      .rejects.toThrow('channel_not_found');
  });
});

describe('normalizeThreadView', () => {
  it('returns each unread thread with its root and unread replies, oldest first', () => {
    const view = normalizeThreadView({
      ok: true,
      total_unread_replies: 3,
      new_threads_count: 2,
      has_more: false,
      max_ts: '1700000999.000000',
      threads: [
        { root_msg: rawThread('C1', '1700000100.000000', []).root_msg, unread_replies: [message('1700000120.000000'), message('1700000110.000000')] },
        rawThread('D1', '1700000050.000000', ['1700000060.000000']),
      ],
    }, 20);

    expect(view?.done).toBe(true);
    expect(view?.threads.map((t) => [t.channel_id, t.thread_ts, t.root.ts, t.unread_replies.map((r) => r.ts)])).toEqual([
      ['C1', '1700000100.000000', '1700000100.000000', ['1700000110.000000', '1700000120.000000']],
      ['D1', '1700000050.000000', '1700000050.000000', ['1700000060.000000']],
    ]);
    // Slack-only fields of the root (channel, latest_reply, last_read) are not copied into the message.
    expect(Object.keys(view!.threads[0].root).sort()).toEqual(['text', 'thread_ts', 'ts', 'type', 'user']);
    expect('has_more' in view!.threads[0]).toBe(false);
  });

  it('caps the replies of a thread at the limit, keeping the earliest', () => {
    const view = normalizeThreadView({ threads: [rawThread('C1', '1700000100.000000', ['1700000101.000000', '1700000102.000000', '1700000103.000000'])] }, 2);

    expect(view?.threads[0].unread_replies.map((r) => r.ts)).toEqual(['1700000101.000000', '1700000102.000000']);
    expect(view?.threads[0].has_more).toBe(true);
  });

  it('uses the root ts when the root has no thread_ts', () => {
    const raw = rawThread('C1', '1700000100.000000', ['1700000101.000000']);
    delete (raw.root_msg as Record<string, unknown>).thread_ts;
    expect(normalizeThreadView({ threads: [raw] }, 20)?.threads[0].thread_ts).toBe('1700000100.000000');
  });

  it('asks for another page only while every thread on a full page is unread', () => {
    const unread = rawThread('C1', '1700000100.000000', ['1700000130.000000']);
    const read = rawThread('C2', '1700000050.000000', [], { latest_reply: '1700000070.000000' });

    const more = normalizeThreadView({ has_more: true, threads: [unread] }, 20);
    expect(more).toMatchObject({ done: false, nextCursor: '1700000130.000000' });

    // A read thread marks the end of the unread section, whatever has_more says.
    const mixed = normalizeThreadView({ has_more: true, threads: [unread, read] }, 20);
    expect(mixed?.done).toBe(true);
    expect(mixed?.threads).toHaveLength(1);

    expect(normalizeThreadView({ has_more: false, threads: [unread] }, 20)?.done).toBe(true);
    expect(normalizeThreadView({ threads: [unread] }, 20)?.done).toBe(true);
    expect(normalizeThreadView({ has_more: 'yes', threads: [unread] }, 20)?.done).toBe(true);
  });

  it('takes the next cursor from the last thread, falling back to its newest unread reply', () => {
    const last = rawThread('C1', '1700000100.000000', ['1700000110.000000', '1700000120.000000']);
    delete (last.root_msg as Record<string, unknown>).latest_reply;
    expect(normalizeThreadView({ has_more: true, threads: [last] }, 20)?.nextCursor).toBe('1700000120.000000');

    const none = { root_msg: { ...message('1700000100.000000'), channel: 'C1', latest_reply: '0000000000.000000' }, unread_replies: [{ text: 'no ts' }] };
    expect(normalizeThreadView({ has_more: true, threads: [none] }, 20)).toEqual({ threads: [], done: true });
  });

  it('accepts an empty thread list', () => {
    expect(normalizeThreadView({ ok: true, threads: [], has_more: false }, 20)).toEqual({ threads: [], done: true });
  });

  it.each([undefined, null, 'ok', 3, [], {}, { ok: true }, { threads: null }, { threads: {} }, { threads: 'none' }].map((raw) => [raw]))(
    'returns undefined for the unexpected shape %p',
    (raw) => {
      expect(normalizeThreadView(raw, 20)).toBeUndefined();
    },
  );

  it('skips entries that are not usable threads without failing the page', () => {
    const view = normalizeThreadView({
      threads: [
        null,
        'thread',
        {},
        { root_msg: null, unread_replies: [message('1.1')] },
        { root_msg: { text: 'no ts', channel: 'C1' }, unread_replies: [message('1.1')] },
        { root_msg: message('1700000001.000000'), unread_replies: [message('1700000002.000000')] }, // no channel
        { root_msg: { ...message('1700000001.000000'), channel: 7 }, unread_replies: [message('1700000002.000000')] },
        { root_msg: { ...message('1700000001.000000'), channel: 'C1' }, unread_replies: 'none' },
        rawThread('C9', '1700000100.000000', ['1700000101.000000']),
      ],
    }, 20);

    expect(view?.threads.map((t) => t.channel_id)).toEqual(['C9']);
  });
});

describe('fetchUnreadThreads', () => {
  function viewer(pages: Array<unknown | Error>) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      client: {
        getUnreadThreadView: async (options: Record<string, unknown> = {}) => {
          calls.push(options);
          const page = pages[calls.length - 1];
          if (page instanceof Error) throw page;
          return page;
        },
      },
    };
  }
  const fullPage = (start: number) => ({
    has_more: true,
    threads: [rawThread('C1', `17000${start}00.000000`, [`17000${start}50.000000`]), rawThread('C1', `17000${start - 1}00.000000`, [`17000${start - 1}50.000000`])],
  });

  it('returns the unread threads of a single page', async () => {
    const { client, calls } = viewer([{ has_more: false, threads: [rawThread('C1', '1700000100.000000', ['1700000101.000000'])] }]);

    const list = await fetchUnreadThreads(client, { limit: 20 });

    expect(calls).toEqual([{}]);
    expect(list?.has_more).toBe(false);
    expect(list?.items.map((t) => t.thread_ts)).toEqual(['1700000100.000000']);
  });

  it('follows pages with current_ts until a page holds a read thread', async () => {
    const { client, calls } = viewer([
      fullPage(90),
      { has_more: true, threads: [rawThread('C1', '1700008000.000000', ['1700008050.000000']), rawThread('C1', '1700007000.000000', [])] },
      fullPage(10),
    ]);

    const list = await fetchUnreadThreads(client, { limit: 20 });

    // The cursor is the latest reply of the last thread of the page before.
    expect(calls).toEqual([{}, { current_ts: '170008950.000000' }]);
    expect(list?.items).toHaveLength(3);
    expect(list?.has_more).toBe(false);
  });

  it('stops at the page cap and reports the list as incomplete', async () => {
    const pages = Array.from({ length: MAX_THREAD_PAGES + 3 }, (_, i) => fullPage(90 - i * 2));
    const { client, calls } = viewer(pages);

    const list = await fetchUnreadThreads(client, { limit: 20 });

    expect(MAX_THREAD_PAGES).toBe(5);
    expect(calls).toHaveLength(MAX_THREAD_PAGES);
    expect(list?.items).toHaveLength(MAX_THREAD_PAGES * 2);
    expect(list?.has_more).toBe(true);
  });

  it('lists a thread once when two pages repeat it', async () => {
    const page = fullPage(90);
    const { client } = viewer([page, { ...page, has_more: false }]);
    // Different cursor on page 2 is not possible here, so move it by hand.
    (page.threads[1].root_msg as Record<string, unknown>).latest_reply = '1700008940.000000';

    const list = await fetchUnreadThreads(client, { limit: 20 });

    expect(list?.items).toHaveLength(2);
  });

  it('stops instead of looping when the cursor does not move or is missing', async () => {
    const same = fullPage(90);
    const stuck = viewer([same, same, same, same]);
    const stuckList = await fetchUnreadThreads(stuck.client, { limit: 20 });
    expect(stuck.calls).toHaveLength(2);
    expect(stuckList).toMatchObject({ has_more: true });
    expect(stuckList?.items).toHaveLength(2);

    // Neither the last thread's latest_reply nor its newest unread reply can be sent as current_ts.
    const last = rawThread('C1', '1700000090.000000', ['0000000000.000000'], { latest_reply: 'x' });
    const stranded = viewer([{ has_more: true, threads: [rawThread('C1', '1700000100.000000', ['1700000101.000000']), last] }, same]);
    const strandedList = await fetchUnreadThreads(stranded.client, { limit: 20 });
    expect(stranded.calls).toHaveLength(1);
    expect(strandedList?.items).toHaveLength(2);
    expect(strandedList?.has_more).toBe(true);
  });

  it.each([
    ['a request failure', new Error('Slack API error: unknown_method')],
    ['an unexpected shape', { ok: true, view: [] }],
    ['a null response', null],
  ])('returns undefined on %s on the first page, without throwing', async (_label, page) => {
    const { client, calls } = viewer([page]);

    expect(await fetchUnreadThreads(client, { limit: 20 })).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a request failure', new Error('Slack API error: ratelimited')],
    ['an unexpected shape', { threads: 'gone' }],
  ])('keeps what it read and marks it incomplete on %s on a later page', async (_label, page) => {
    const { client } = viewer([fullPage(90), page]);

    const list = await fetchUnreadThreads(client, { limit: 20 });

    expect(list?.items).toHaveLength(2);
    expect(list?.has_more).toBe(true);
  });
});

describe('fetchUnreadDetails', () => {
  function detailsClient(options: {
    history?: Record<string, unknown[]>;
    view?: unknown | Error;
  } = {}) {
    const calls: string[] = [];
    const client = {
      getConversationHistory: async (channelId: string) => {
        calls.push(`history:${channelId}`);
        return { ok: true, messages: options.history?.[channelId] ?? [] };
      },
      getUnreadThreadView: async () => {
        calls.push('threadView');
        if (options.view instanceof Error) throw options.view;
        return options.view ?? { threads: [], has_more: false };
      },
      getUsersInfo: async (ids: string[]) => {
        calls.push(`users:${ids.join(',')}`);
        return { ok: true, users: ids.map((id) => ({ id, name: id.toLowerCase() })) };
      },
    };
    return { client, calls };
  }
  const caps = { maxConversations: 10, limit: 20 };
  const unreadThreads = { has_unreads: true, mention_count: 1 };

  it('adds messages, thread items and the authors of both', async () => {
    const { client, calls } = detailsClient({
      history: { A: [message('1700000002.000000', { user: 'U1' }), message('1700000001.000000', { user: 'U3', bot_id: 'B1' })] },
      view: { has_more: false, threads: [rawThread('C1', '1700000100.000000', ['1700000101.000000'])] },
    });

    const details = await fetchUnreadDetails(client, { channels: [channel('A')], threads: unreadThreads, cursors: {} }, caps);

    expect(calls).toEqual(['history:A', 'threadView', 'users:U3,U1,U2']);
    expect(details.channels[0].messages).toHaveLength(2);
    expect(details.threads).toMatchObject({ has_unreads: true, mention_count: 1 });
    expect(details.threads?.items).toHaveLength(1);
    expect('has_more' in details.threads!).toBe(false);
    expect([...details.users.keys()]).toEqual(['U3', 'U1', 'U2']);
    expect(details.threadsUnavailable).toBe(false);
  });

  it('skips the thread view when client.counts says no thread is unread', async () => {
    const { client, calls } = detailsClient();

    const details = await fetchUnreadDetails(client, { channels: [], threads: { has_unreads: false, mention_count: 0 } }, caps);

    expect(calls).toEqual([]);
    expect(details.threads).toEqual({ has_unreads: false, mention_count: 0, items: [] });
    expect(details.users.size).toBe(0);
  });

  it('reads the thread view for a thread mention even when has_unreads is false', async () => {
    const { client, calls } = detailsClient();
    await fetchUnreadDetails(client, { channels: [], threads: { has_unreads: false, mention_count: 2 } }, caps);
    expect(calls).toEqual(['threadView']);
  });

  it('falls back to the summary when the thread view fails', async () => {
    const { client } = detailsClient({ view: new Error('Slack API error: unknown_method') });

    const details = await fetchUnreadDetails(client, { channels: [], threads: unreadThreads }, caps);

    expect(details.threads).toEqual(unreadThreads);
    expect(details.threadsUnavailable).toBe(true);
  });

  it('falls back to the summary when the thread view has an unexpected shape', async () => {
    const { client } = detailsClient({ view: { ok: true, threads: 'none' } });

    const details = await fetchUnreadDetails(client, { channels: [], threads: unreadThreads }, caps);

    expect(details.threads).toEqual(unreadThreads);
    expect(details.threadsUnavailable).toBe(true);
  });

  it('marks the thread list incomplete when the view stops short', async () => {
    const page = { has_more: true, threads: [rawThread('C1', '1700000100.000000', ['1700000101.000000'])] };
    const { client } = detailsClient({ view: page });

    const details = await fetchUnreadDetails(client, { channels: [], threads: unreadThreads }, caps);

    expect(details.threads?.has_more).toBe(true);
  });

  it('still asks the thread view when client.counts sent no threads block', async () => {
    const empty = detailsClient();
    const none = await fetchUnreadDetails(empty.client, { channels: [] }, caps);
    expect(empty.calls).toEqual(['threadView']);
    expect('threads' in none).toBe(false);

    const found = detailsClient({ view: { has_more: false, threads: [rawThread('C1', '1700000100.000000', ['1700000101.000000'])] } });
    const some = await fetchUnreadDetails(found.client, { channels: [] }, caps);
    expect(some.threads).toMatchObject({ has_unreads: true, mention_count: 0 });
    expect(some.threads?.items).toHaveLength(1);
  });
});

// This module carries message content, so its log records are checked for it.
describe('logging', () => {
  afterEach(() => resetSync());

  it('logs IDs, counts and durations, never message content', async () => {
    const records: LogRecord[] = [];
    configureLogging({ level: 'trace', verbose: false, sinks: { capture: (r) => records.push(r) } });
    const secret = 'ZEBRA-PAYROLL-7731';
    const loud = (ts: string) => message(ts, {
      text: `${secret} text`,
      blocks: [{ type: 'rich_text', elements: [{ type: 'text', text: `${secret} block` }] }],
      attachments: [{ fallback: `${secret} attachment` }],
      files: [{ id: 'F1', name: `${secret}.pdf`, title: `${secret} title` }],
    });
    const client = {
      getConversationHistory: async () => ({ ok: true, messages: [loud('1700000002.000000'), loud('1700000001.000000')], has_more: true }),
      getUnreadThreadView: async (options: { current_ts?: string } = {}) => {
        if (options.current_ts) throw new Error(`${secret} is not in an error either`);
        return { has_more: true, threads: [{ root_msg: { ...loud('1700000100.000000'), channel: 'C1', latest_reply: '1700000101.000000' }, unread_replies: [loud('1700000101.000000')] }] };
      },
      getUsersInfo: async () => ({ ok: true, users: [{ id: 'U1', name: `${secret} name` }] }),
    };

    const details = await fetchUnreadDetails(
      client,
      { channels: [channel('C0123456789', 1)], threads: { has_unreads: true, mention_count: 0 }, cursors: { C0123456789: { last_read: '1700000000.000000' } } },
      { maxConversations: 10, limit: 20 },
    );

    // The content did flow through, so the assertion below is not vacuous.
    expect(details.channels[0].messages?.[0].text).toContain(secret);
    expect(details.threads?.items?.[0].unread_replies[0].text).toContain(secret);

    const own = records.filter((r) => r.category.join('.') === 'slackcli.unread');
    expect(own.length).toBeGreaterThanOrEqual(3);
    expect(own.some((r) => r.properties.channel_id === 'C0123456789' && r.properties.message_count === 2)).toBe(true);
    const serialized = JSON.stringify(records.map((r) => ({ message: r.message, properties: r.properties, raw: r.rawMessage })));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('ZEBRA');
  });
});
