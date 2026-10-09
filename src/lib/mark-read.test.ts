import { describe, expect, it } from 'bun:test';
import { markConversationRead, previousLastRead, readCursorOf } from './mark-read.ts';

// A stand-in for the two client calls the module makes, recording their order.
function stubClient(options: { info?: unknown; infoError?: Error; markError?: Error } = {}) {
  const calls: Array<[string, ...string[]]> = [];
  return {
    calls,
    client: {
      getConversationInfo: async (channel: string) => {
        calls.push(['conversations.info', channel]);
        if (options.infoError) throw options.infoError;
        return options.info;
      },
      markConversation: async (channel: string, ts: string) => {
        calls.push(['conversations.mark', channel, ts]);
        if (options.markError) throw options.markError;
        return { ok: true };
      },
    },
  };
}

describe('readCursorOf', () => {
  it('returns channel.last_read when it is a non-empty string', () => {
    expect(readCursorOf({ ok: true, channel: { id: 'C0123456789', last_read: '1712345600.000200' } })).toBe('1712345600.000200');
  });

  it('keeps the all-zero cursor Slack reports for a conversation never read', () => {
    expect(readCursorOf({ channel: { last_read: '0000000000.000000' } })).toBe('0000000000.000000');
  });

  it.each([
    ['a channel without last_read', { channel: { id: 'C0123456789' } }],
    ['an empty last_read', { channel: { last_read: '' } }],
    ['a numeric last_read', { channel: { last_read: 1712345600.0002 } }],
    ['a null last_read', { channel: { last_read: null } }],
    ['an object last_read', { channel: { last_read: { ts: '1712345600.000200' } } }],
    ['a response without channel', { ok: true }],
    ['a null channel', { channel: null }],
    ['a null response', null],
    ['an undefined response', undefined],
    ['a string response', 'last_read'],
  ])('returns null for %s', (_name, info) => {
    expect(readCursorOf(info)).toBeNull();
  });
});

describe('previousLastRead', () => {
  it('reads the cursor with one conversations.info call', async () => {
    const { client, calls } = stubClient({ info: { channel: { last_read: '1712345600.000200' } } });

    expect(await previousLastRead(client, 'C0123456789')).toBe('1712345600.000200');
    expect(calls).toEqual([['conversations.info', 'C0123456789']]);
  });

  it('returns null when Slack reports no cursor', async () => {
    const { client } = stubClient({ info: { channel: { id: 'C0123456789' } } });

    expect(await previousLastRead(client, 'C0123456789')).toBeNull();
  });

  it('returns null instead of throwing when the read fails', async () => {
    const { client } = stubClient({ infoError: new Error('Slack API error: missing_scope') });

    expect(await previousLastRead(client, 'C0123456789')).toBeNull();
  });
});

describe('markConversationRead', () => {
  it('reads the cursor, then marks, and reports both', async () => {
    const { client, calls } = stubClient({ info: { channel: { last_read: '1712345600.000200' } } });

    const result = await markConversationRead(client, 'C0123456789', '1712345678.123456');

    expect(result).toEqual({ channel_id: 'C0123456789', ts: '1712345678.123456', previous_last_read: '1712345600.000200' });
    expect(Object.keys(result)).toEqual(['channel_id', 'ts', 'previous_last_read']);
    expect(calls).toEqual([
      ['conversations.info', 'C0123456789'],
      ['conversations.mark', 'C0123456789', '1712345678.123456'],
    ]);
  });

  it('reports a null cursor when Slack returns none', async () => {
    const { client } = stubClient({ info: { channel: { id: 'D0123456789' } } });

    expect(await markConversationRead(client, 'D0123456789', '1712345678.123456')).toEqual({
      channel_id: 'D0123456789',
      ts: '1712345678.123456',
      previous_last_read: null,
    });
  });

  it('still marks when the cursor read fails, and reports null', async () => {
    const { client, calls } = stubClient({ infoError: new Error('Slack API error: channel_not_found') });

    const result = await markConversationRead(client, 'C0123456789', '1712345678.123456');

    expect(result.previous_last_read).toBeNull();
    expect(calls).toContainEqual(['conversations.mark', 'C0123456789', '1712345678.123456']);
  });

  it('lets a failed write propagate, after reading the cursor once', async () => {
    const { client, calls } = stubClient({
      info: { channel: { last_read: '1712345600.000200' } },
      markError: new Error('Slack API error: not_in_channel'),
    });

    await expect(markConversationRead(client, 'C0123456789', '1712345678.123456')).rejects.toThrow('not_in_channel');
    expect(calls.filter(([method]) => method === 'conversations.info')).toHaveLength(1);
    expect(calls.filter(([method]) => method === 'conversations.mark')).toHaveLength(1);
  });
});
