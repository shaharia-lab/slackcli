import { describe, expect, it } from 'bun:test';
import type { SlackAuthTestResponse, SlackMessage } from '../types/index.ts';
import {
  compareTs,
  filterNewerThan,
  filterSelf,
  nextOldest,
  processReadPage,
  resolveSelfIdentity,
  type IdentitySource,
} from './poll.ts';

const msg = (ts: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  type: 'message',
  ts,
  text: `m ${ts}`,
  ...extra,
});

const tsOf = (messages: SlackMessage[]) => messages.map(m => m.ts);

describe('compareTs', () => {
  it('orders by seconds first, as integers', () => {
    expect(compareTs('1700000001.000000', '1700000000.999999')).toBeGreaterThan(0);
    expect(compareTs('999999999.000000', '1000000000.000000')).toBeLessThan(0);
  });

  it('orders by microseconds when the seconds are equal', () => {
    expect(compareTs('1700000000.000002', '1700000000.000001')).toBeGreaterThan(0);
    expect(compareTs('1700000000.000001', '1700000000.000002')).toBeLessThan(0);
  });

  it('treats equal timestamps as equal', () => {
    expect(compareTs('1700000000.123456', '1700000000.123456')).toBe(0);
  });

  it('pads fractions of different lengths on the right', () => {
    expect(compareTs('1700000000.1', '1700000000.100000')).toBe(0);
    expect(compareTs('1700000000.1', '1700000000.099999')).toBeGreaterThan(0);
  });

  it('accepts bare epoch seconds (what --oldest=1735689600 normalises to)', () => {
    expect(compareTs('1735689600', '1735689600.000000')).toBe(0);
    expect(compareTs('1735689600.000001', '1735689600')).toBeGreaterThan(0);
  });

  it('does not lose microsecond precision the way a float compare would', () => {
    // As floats these two are the same double.
    expect(Number.parseFloat('1700000000.12345601')).toBe(Number.parseFloat('1700000000.12345602'));
    expect(compareTs('1700000000.12345602', '1700000000.12345601')).toBeGreaterThan(0);
  });

  it('rejects a malformed timestamp', () => {
    expect(() => compareTs('abc', '1700000000.000000')).toThrow('Invalid Slack timestamp');
  });
});

describe('filterNewerThan', () => {
  it('returns the messages unchanged without an oldest', () => {
    const messages = [msg('1.000001'), msg('2.000001')];
    expect(filterNewerThan(messages)).toBe(messages);
  });

  it('keeps only messages strictly newer than oldest', () => {
    const messages = [msg('1700000000.000001'), msg('1700000000.000002'), msg('1700000000.000003')];
    expect(tsOf(filterNewerThan(messages, '1700000000.000002'))).toEqual(['1700000000.000003']);
  });

  it('drops a message without a ts', () => {
    expect(filterNewerThan([{ type: 'message' } as SlackMessage], '1.0')).toEqual([]);
  });
});

describe('filterSelf', () => {
  const messages = [
    msg('1.000001', { user: 'U_ME' }),
    msg('1.000002', { user: 'U_OTHER' }),
    msg('1.000003', { bot_id: 'B_ME' }),
    msg('1.000004', { bot_id: 'B_OTHER', user: 'U_OTHER_BOT' }),
    msg('1.000005'),
  ];

  it('drops messages whose user is the authenticated user', () => {
    expect(tsOf(filterSelf(messages, { userId: 'U_ME' }))).toEqual([
      '1.000002',
      '1.000003',
      '1.000004',
      '1.000005',
    ]);
  });

  it('also drops messages carrying the bot token\'s bot_id', () => {
    expect(tsOf(filterSelf(messages, { userId: 'U_ME', botId: 'B_ME' }))).toEqual([
      '1.000002',
      '1.000004',
      '1.000005',
    ]);
  });

  it('keeps messages that have neither user nor bot_id', () => {
    expect(tsOf(filterSelf([msg('2.000001')], { userId: 'U_ME', botId: 'B_ME' }))).toEqual(['2.000001']);
  });
});

describe('nextOldest', () => {
  it('is the newest ts of the page, whatever order Slack returned it in', () => {
    const newestFirst = [msg('1700000000.000009'), msg('1700000000.000003'), msg('1699999999.999999')];
    expect(nextOldest(newestFirst, '1600000000.000000')).toBe('1700000000.000009');
    expect(nextOldest([...newestFirst].reverse())).toBe('1700000000.000009');
  });

  it('echoes oldest back on an empty page, so a loop stays stable', () => {
    expect(nextOldest([], '1700000000.000001')).toBe('1700000000.000001');
  });

  it('is null on an empty page without an oldest', () => {
    expect(nextOldest([])).toBeNull();
  });

  it('never moves behind oldest (a thread page holding only the old parent)', () => {
    expect(nextOldest([msg('1600000000.000001')], '1700000000.000001')).toBe('1700000000.000001');
  });
});

describe('processReadPage', () => {
  const OLDEST = '1700000000.000100';

  it('never re-emits the thread parent on a thread poll with --oldest', () => {
    const parent = msg('1700000000.000001', { thread_ts: '1700000000.000001', user: 'U_A' });
    const page = processReadPage({ messages: [parent] }, { oldest: OLDEST, isThread: true });
    expect(page.messages).toEqual([]);
    expect(page.nextOldest).toBe(OLDEST);
  });

  it('keeps only the new replies after the parent', () => {
    const response = {
      messages: [
        msg('1700000000.000001', { thread_ts: '1700000000.000001' }),
        msg('1700000000.000100', { thread_ts: '1700000000.000001' }),
        msg('1700000000.000200', { thread_ts: '1700000000.000001' }),
      ],
    };
    const page = processReadPage(response, { oldest: OLDEST, isThread: true });
    expect(tsOf(page.messages)).toEqual(['1700000000.000200']);
    expect(page.nextOldest).toBe('1700000000.000200');
  });

  it('advances the cursor past a page made only of your own messages', () => {
    const response = { messages: [msg('1700000000.000300', { user: 'U_ME' }), msg('1700000000.000200', { user: 'U_ME' })] };
    const page = processReadPage(response, { oldest: OLDEST, self: { userId: 'U_ME' } });
    expect(page.messages).toEqual([]);
    expect(page.nextOldest).toBe('1700000000.000300');
  });

  it('computes the cursor before --exclude-replies drops a newer reply', () => {
    const response = {
      messages: [
        msg('1700000000.000300', { thread_ts: '1700000000.000200' }),
        msg('1700000000.000200', { thread_ts: '1700000000.000200' }),
      ],
    };
    const page = processReadPage(response, { excludeReplies: true });
    expect(tsOf(page.messages)).toEqual(['1700000000.000200']);
    expect(page.nextOldest).toBe('1700000000.000300');
  });

  it('ignores --exclude-replies on a thread read', () => {
    const response = { messages: [msg('1.000001', { thread_ts: '1.000000' })] };
    expect(processReadPage(response, { excludeReplies: true, isThread: true }).messages).toHaveLength(1);
  });

  it('reports has_more from the Slack response, defaulting to false', () => {
    expect(processReadPage({ messages: [], has_more: true }).hasMore).toBe(true);
    expect(processReadPage({ messages: [] }).hasMore).toBe(false);
  });

  it('treats a missing messages array as an empty page', () => {
    expect(processReadPage({}, { oldest: OLDEST })).toEqual({ messages: [], nextOldest: OLDEST, hasMore: false });
  });

  it('leaves the page unchanged with no options', () => {
    const response = { messages: [msg('2.000001', { user: 'U_ME' }), msg('1.000001')] };
    const page = processReadPage(response);
    expect(tsOf(page.messages)).toEqual(['2.000001', '1.000001']);
    expect(page.nextOldest).toBe('2.000001');
  });
});

describe('resolveSelfIdentity', () => {
  function source(storedUserId: string | undefined, isBotToken: boolean, auth: Partial<SlackAuthTestResponse>) {
    const calls = { count: 0 };
    const src: IdentitySource = {
      storedUserId,
      isBotToken,
      async testAuth() {
        calls.count++;
        return { ok: true, url: '', team: '', user: '', team_id: 'T1', user_id: '', ...auth };
      },
    };
    return { src, calls };
  }

  it('uses the stored user_id without an API call for a user identity', async () => {
    const { src, calls } = source('U_ME', false, { user_id: 'U_OTHER' });
    expect(await resolveSelfIdentity(src)).toEqual({ userId: 'U_ME' });
    expect(calls.count).toBe(0);
  });

  it('calls auth.test once for a legacy record without user_id', async () => {
    const { src, calls } = source(undefined, false, { user_id: 'U_ME' });
    expect(await resolveSelfIdentity(src)).toEqual({ userId: 'U_ME' });
    expect(calls.count).toBe(1);
  });

  it('calls auth.test for a bot token to learn its bot_id', async () => {
    const { src, calls } = source('U_BOT', true, { user_id: 'U_BOT', bot_id: 'B_ME' });
    expect(await resolveSelfIdentity(src)).toEqual({ userId: 'U_BOT', botId: 'B_ME' });
    expect(calls.count).toBe(1);
  });

  it('falls back to the stored user_id when auth.test omits it', async () => {
    const { src } = source('U_BOT', true, { bot_id: 'B_ME' });
    expect(await resolveSelfIdentity(src)).toEqual({ userId: 'U_BOT', botId: 'B_ME' });
  });

  it('throws instead of silently skipping the filter when no identity is known', async () => {
    const { src } = source(undefined, false, {});
    await expect(resolveSelfIdentity(src)).rejects.toThrow('--exclude-self');
  });

  it('propagates an auth.test failure', async () => {
    const src: IdentitySource = {
      storedUserId: undefined,
      isBotToken: false,
      testAuth: () => Promise.reject(new Error('invalid_auth')),
    };
    await expect(resolveSelfIdentity(src)).rejects.toThrow('invalid_auth');
  });
});
