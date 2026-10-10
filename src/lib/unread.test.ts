import { describe, expect, it } from 'bun:test';
import type { SlackClient } from './slack-client.ts';
import { fetchUnread, hasUnreadThreads, normalizeUnreadThreads } from './unread.ts';

// Minimal mock client: canned unread counts, and names resolved from two maps.
function createMockClient(
  authType: 'browser' | 'standard',
  counts: unknown,
  lookups: {
    channels?: Record<string, Record<string, unknown>>;
    users?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const calls: string[] = [];
  const client = {
    authType,
    getUnreadCounts: async () => {
      calls.push('getUnreadCounts');
      return counts;
    },
    getConversationInfo: async (id: string) => {
      calls.push(`getConversationInfo:${id}`);
      const channel = lookups.channels?.[id];
      if (!channel) throw new Error('channel_not_found');
      return { ok: true, channel };
    },
    getUserInfo: async (id: string) => {
      calls.push(`getUserInfo:${id}`);
      const user = lookups.users?.[id];
      if (!user) throw new Error('user_not_found');
      return { ok: true, user };
    },
  } as unknown as SlackClient;
  return { client, calls };
}

describe('normalizeUnreadThreads', () => {
  it('keeps only has_unreads and mention_count', () => {
    expect(normalizeUnreadThreads({ has_unreads: true, mention_count: 2, vip_count: 1 }))
      .toEqual({ has_unreads: true, mention_count: 2 });
  });

  it('fills in missing fields as nothing unread', () => {
    expect(normalizeUnreadThreads({})).toEqual({ has_unreads: false, mention_count: 0 });
    expect(normalizeUnreadThreads({ has_unreads: true })).toEqual({ has_unreads: true, mention_count: 0 });
    expect(normalizeUnreadThreads({ mention_count: 3 })).toEqual({ has_unreads: false, mention_count: 3 });
  });

  it.each([
    ['a truthy string', 'true'],
    ['a number', 1],
    ['null', null],
  ])('reads has_unreads given as %s as false', (_label, value) => {
    expect(normalizeUnreadThreads({ has_unreads: value })?.has_unreads).toBe(false);
  });

  it.each([
    ['a negative number', -1, 0],
    ['a numeric string', '4', 0],
    ['NaN', Number.NaN, 0],
    ['Infinity', Number.POSITIVE_INFINITY, 0],
    ['null', null, 0],
    ['a fraction', 2.7, 2],
  ])('reads mention_count given as %s as %p', (_label, value, expected) => {
    expect(normalizeUnreadThreads({ mention_count: value })?.mention_count).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', [{ has_unreads: true }]],
    ['a string', 'threads'],
    ['a boolean', true],
    ['a number', 1],
  ])('returns undefined for %s', (_label, value) => {
    expect(normalizeUnreadThreads(value)).toBeUndefined();
  });
});

describe('hasUnreadThreads', () => {
  it('is true for unread replies, for a mention, or for both', () => {
    expect(hasUnreadThreads({ has_unreads: true, mention_count: 0 })).toBe(true);
    expect(hasUnreadThreads({ has_unreads: false, mention_count: 1 })).toBe(true);
    expect(hasUnreadThreads({ has_unreads: true, mention_count: 4 })).toBe(true);
  });

  it('is false when nothing is unread or the summary is missing', () => {
    expect(hasUnreadThreads({ has_unreads: false, mention_count: 0 })).toBe(false);
    expect(hasUnreadThreads(undefined)).toBe(false);
  });
});

describe('fetchUnread with browser auth (client.counts)', () => {
  const lookups = {
    channels: {
      C1: { name: 'general', is_private: false },
      G1: { name: 'mpdm-a--b-1', is_mpim: true, is_private: true },
      D1: { is_im: true, user: 'U1' },
      D2: { is_im: true, user: 'U404' },
    },
    users: { U1: { name: 'alice', real_name: 'Alice Doe' } },
  };

  it('returns the read cursors of the unread conversations, keyed by ID, and leaves them off the list', async () => {
    const { client } = createMockClient('browser', {
      ok: true,
      channels: [
        { id: 'C1', has_unreads: true, mention_count: 0, last_read: '1700000001.000000', latest: '1700000009.000000' },
        { id: 'C2', has_unreads: false, mention_count: 0, last_read: '1700000002.000000', latest: '1700000002.000000' },
      ],
      mpims: [{ id: 'G1', has_unreads: false, mention_count: 2, last_read: '0000000000.000000' }],
      ims: [{ id: 'D1', has_unreads: true, mention_count: 1, last_read: 1700000003, latest: null }],
    }, lookups);

    const result = await fetchUnread(client);

    // C2 is read, and D1 sent no usable cursor: neither gets an entry.
    expect(result.cursors).toEqual({
      C1: { last_read: '1700000001.000000', latest: '1700000009.000000' },
      G1: { last_read: '0000000000.000000' },
    });
    for (const channel of result.channels) {
      expect(Object.keys(channel)).not.toContain('last_read');
      expect(Object.keys(channel)).not.toContain('latest');
    }
  });

  it('leaves cursors out when Slack sent none, and with an app token', async () => {
    const browser = createMockClient('browser', { ok: true, channels: [{ id: 'C1', has_unreads: true, mention_count: 0 }] }, lookups);
    expect('cursors' in await fetchUnread(browser.client)).toBe(false);

    const standard = createMockClient('standard', {
      ok: true,
      channels: [{ id: 'C1', name: 'general', is_member: true, unread_count: 2, last_read: '1700000001.000000' }],
    });
    expect('cursors' in await fetchUnread(standard.client)).toBe(false);
  });

  it('returns the thread summary next to the unread conversations', async () => {
    const { client, calls } = createMockClient('browser', {
      ok: true,
      channels: [{ id: 'C1', has_unreads: true, mention_count: 0 }, { id: 'C2', has_unreads: false, mention_count: 0 }],
      mpims: [{ id: 'G1', has_unreads: false, mention_count: 2 }],
      ims: [{ id: 'D1', has_unreads: true, mention_count: 1 }],
      threads: { has_unreads: true, mention_count: 1, vip_count: 0 },
    }, lookups);

    const result = await fetchUnread(client);

    expect(result.threads).toEqual({ has_unreads: true, mention_count: 1 });
    // Mentions first, then by name; the read channel C2 is dropped.
    expect(result.channels).toEqual([
      { id: 'G1', mention_count: 2, has_unreads: false, is_im: undefined, is_mpim: true, is_private: true, name: 'mpdm-a--b-1' },
      { id: 'D1', mention_count: 1, has_unreads: true, is_im: true, is_mpim: undefined, is_private: undefined, name: 'Alice Doe' },
      { id: 'C1', mention_count: 0, has_unreads: true, is_im: undefined, is_mpim: undefined, is_private: false, name: 'general' },
    ]);
    // The summary comes from the one client.counts response.
    expect(calls.filter((call) => call === 'getUnreadCounts')).toHaveLength(1);
    expect(calls.filter((call) => !call.startsWith('get'))).toEqual([]);
  });

  it('reports unread threads when no conversation is unread, without any lookup', async () => {
    const { client, calls } = createMockClient('browser', {
      ok: true,
      channels: [{ id: 'C1', has_unreads: false, mention_count: 0 }],
      mpims: [],
      ims: [],
      threads: { has_unreads: true, mention_count: 0 },
    }, lookups);

    expect(await fetchUnread(client)).toEqual({ channels: [], threads: { has_unreads: true, mention_count: 0 } });
    expect(calls).toEqual(['getUnreadCounts']);
  });

  it('reports a read thread summary as nothing unread', async () => {
    const { client } = createMockClient('browser', { ok: true, threads: { has_unreads: false, mention_count: 0 } });

    expect(await fetchUnread(client)).toEqual({ channels: [], threads: { has_unreads: false, mention_count: 0 } });
  });

  it.each([
    ['absent', {}],
    ['null', { threads: null }],
    ['not an object', { threads: 'nope' }],
  ])('leaves threads out when the block is %s', async (_label, extra) => {
    const { client } = createMockClient('browser', {
      ok: true,
      channels: [{ id: 'C1', has_unreads: true, mention_count: 0 }],
      ...extra,
    }, lookups);

    const result = await fetchUnread(client);

    expect('threads' in result).toBe(false);
    expect(result.channels.map((channel) => channel.id)).toEqual(['C1']);
  });

  it('falls back to the user ID or channel ID when a name lookup fails', async () => {
    const { client } = createMockClient('browser', {
      ok: true,
      channels: [{ id: 'C404', has_unreads: true }],
      ims: [{ id: 'D2', has_unreads: true }],
    }, lookups);

    const result = await fetchUnread(client);

    expect(result.channels.map((channel) => [channel.id, channel.name, channel.mention_count])).toEqual([
      ['C404', 'C404', 0],
      ['D2', 'U404', 0],
    ]);
  });

  // Name resolution, one row per path through the lookup: what the lookups
  // answer, and the fields the conversation ends up with.
  it.each([
    ['a channel', { channel: { name: 'general', is_private: false } }, undefined,
      { name: 'general', is_im: undefined, is_mpim: undefined, is_private: false }],
    ['a channel without a name', { channel: { is_private: true } }, undefined,
      { name: 'X1', is_im: undefined, is_mpim: undefined, is_private: true }],
    ['a channel that carries a user', { channel: { name: 'general', user: 'U1' } }, undefined,
      { name: 'general', is_im: undefined, is_mpim: undefined, is_private: undefined }],
    ['a DM without a user', { channel: { is_im: true, name: 'dm-name' } }, undefined,
      { name: 'dm-name', is_im: true, is_mpim: undefined, is_private: undefined }],
    ['a DM with a real name', { channel: { is_im: true, user: 'U1' } }, { user: { name: 'alice', real_name: 'Alice Doe' } },
      { name: 'Alice Doe', is_im: true, is_mpim: undefined, is_private: undefined }],
    ['a DM with a handle only', { channel: { is_im: true, user: 'U1' } }, { user: { name: 'alice' } },
      { name: 'alice', is_im: true, is_mpim: undefined, is_private: undefined }],
    ['a DM whose user has no name', { channel: { is_im: true, user: 'U1' } }, { user: {} },
      { name: 'U1', is_im: true, is_mpim: undefined, is_private: undefined }],
    ['a DM whose lookup returns no user', { channel: { is_im: true, user: 'U1' } }, {},
      { name: 'U1', is_im: true, is_mpim: undefined, is_private: undefined }],
    ['a DM whose user lookup fails', { channel: { is_im: true, is_private: true, user: 'U1' } }, 'throw',
      { name: 'U1', is_im: true, is_mpim: undefined, is_private: true }],
    ['a failed conversation lookup', 'throw', undefined, { name: 'X1' }],
    ['a lookup that returns no channel', {}, undefined, {}],
  ] as const)('resolves %s', async (_label, info, userInfo, expected) => {
    const calls: string[] = [];
    const answer = (value: unknown) => {
      if (value === 'throw') throw new Error('lookup_failed');
      return value;
    };
    const client = {
      authType: 'browser',
      getUnreadCounts: async () => ({ ok: true, channels: [{ id: 'X1', has_unreads: true, mention_count: 3 }] }),
      getConversationInfo: async (id: string) => {
        calls.push(`getConversationInfo:${id}`);
        return answer(info);
      },
      getUserInfo: async (id: string) => {
        calls.push(`getUserInfo:${id}`);
        return answer(userInfo);
      },
    } as unknown as SlackClient;

    const result = await fetchUnread(client);

    expect(result.channels).toStrictEqual([{ id: 'X1', mention_count: 3, has_unreads: true, ...expected }]);
    expect(calls).toEqual(userInfo === undefined ? ['getConversationInfo:X1'] : ['getConversationInfo:X1', 'getUserInfo:U1']);
  });

  it('keeps a cursor that has only one of its two timestamps', async () => {
    const { client } = createMockClient('browser', {
      ok: true,
      channels: [{ id: 'C1', has_unreads: true, latest: '1700000009.000000' }],
      ims: [{ id: 'D1', has_unreads: true, last_read: '1700000003.000000', latest: 1700000004 }],
    }, lookups);

    expect((await fetchUnread(client)).cursors).toStrictEqual({
      C1: { latest: '1700000009.000000' },
      D1: { last_read: '1700000003.000000' },
    });
  });

  it('sorts by mentions, then by name, with an unnamed conversation first', async () => {
    const client = {
      authType: 'browser',
      getUnreadCounts: async () => ({
        ok: true,
        channels: [
          { id: 'C1', has_unreads: true, mention_count: 1 },
          { id: 'C2', has_unreads: true, mention_count: 1 },
          { id: 'C3', has_unreads: true, mention_count: 1 },
          { id: 'C4', has_unreads: true, mention_count: 5 },
        ],
      }),
      getConversationInfo: async (id: string) => {
        const names: Record<string, string> = { C1: 'zulu', C2: 'alpha', C4: 'mike' };
        return id === 'C3' ? { ok: true } : { ok: true, channel: { name: names[id] } };
      },
    } as unknown as SlackClient;

    const result = await fetchUnread(client);

    expect(result.channels.map((channel) => [channel.id, channel.name])).toEqual([
      ['C4', 'mike'],
      ['C3', undefined],
      ['C2', 'alpha'],
      ['C1', 'zulu'],
    ]);
  });

  it('reports progress once, before the first name lookup', async () => {
    const { client, calls } = createMockClient('browser', {
      ok: true,
      channels: [{ id: 'C1', has_unreads: true }, { id: 'G1', has_unreads: true }],
    }, lookups);

    await fetchUnread(client, { onProgress: (message) => calls.push(`progress:${message}`) });

    expect(calls.slice(0, 2)).toEqual(['getUnreadCounts', 'progress:Fetching channel details...']);
    expect(calls.filter((call) => call.startsWith('progress:'))).toHaveLength(1);
  });

  it('reports progress before resolving names', async () => {
    const { client } = createMockClient('browser', { ok: true, channels: [] });
    const messages: string[] = [];

    await fetchUnread(client, { onProgress: (message) => messages.push(message) });

    expect(messages).toEqual(['Fetching channel details...']);
  });
});

describe('fetchUnread with an app token (conversations.list)', () => {
  it('returns unread member conversations and no thread summary', async () => {
    const { client, calls } = createMockClient('standard', {
      ok: true,
      channels: [
        { id: 'C1', name: 'general', is_member: true, unread_count: 4, unread_count_display: 3, mention_count_display: 1 },
        { id: 'C2', name: 'alpha', is_member: true, unread_count: 2, unread_count_display: 0 },
        { id: 'C3', name: 'not-joined', is_member: false, unread_count: 9 },
        { id: 'C4', name: 'read', is_member: true, unread_count: 0, unread_count_display: 0 },
      ],
    });

    const result = await fetchUnread(client);

    expect(result).toEqual({
      channels: [
        { id: 'C1', name: 'general', mention_count: 1, unread_count: 3, has_unreads: true, is_im: undefined, is_mpim: undefined, is_private: undefined },
        { id: 'C2', name: 'alpha', mention_count: 0, unread_count: 2, has_unreads: true, is_im: undefined, is_mpim: undefined, is_private: undefined },
      ],
    });
    expect('threads' in result).toBe(false);
    expect(calls).toEqual(['getUnreadCounts']);
  });

  it.each([
    ['only a display count', { unread_count: 0, unread_count_display: 2 }, { unread_count: 2, mention_count: 0 }],
    ['only a raw count', { unread_count: 5 }, { unread_count: 5, mention_count: 0 }],
    ['a mention', { unread_count: 1, mention_count_display: 4, mention_count: 9 }, { unread_count: 1, mention_count: 4 }],
  ])('maps a conversation with %s', async (_label, counts, expected) => {
    const { client } = createMockClient('standard', {
      ok: true,
      channels: [{ id: 'G1', name: 'team', is_member: true, is_mpim: true, is_private: true, is_im: false, ...counts }],
    });

    expect((await fetchUnread(client)).channels).toStrictEqual([
      { id: 'G1', name: 'team', has_unreads: true, is_im: false, is_mpim: true, is_private: true, ...expected },
    ]);
  });

  it('returns nothing, and reports no progress, when the response has no channels', async () => {
    const { client, calls } = createMockClient('standard', { ok: true });
    const messages: string[] = [];

    expect(await fetchUnread(client, { onProgress: (message) => messages.push(message) })).toStrictEqual({ channels: [] });
    expect(messages).toEqual([]);
    expect(calls).toEqual(['getUnreadCounts']);
  });

  it('ignores a threads key on a conversations.list response', async () => {
    const { client } = createMockClient('standard', { ok: true, channels: [], threads: { has_unreads: true, mention_count: 5 } });

    expect(await fetchUnread(client)).toEqual({ channels: [] });
  });
});
