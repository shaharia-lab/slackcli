import { describe, expect, it } from 'bun:test';
import { fetchThreadReplies, replyParentTs, resolvePostThread, resolveThreadParent } from './thread-parent.ts';

const PARENT = '1712345678.000100';
const REPLY = '1712345699.000200';
const LONE = '1712345700.000300';
const CHANNEL = 'C0123456789';

// What conversations.replies returns, keyed by the ts it is asked for: a parent's
// ts gives the whole thread, a reply's ts gives only that reply, a message with no
// thread gives itself without a thread_ts.
const THREAD = [
  { ts: PARENT, thread_ts: PARENT, text: 'parent' },
  { ts: REPLY, thread_ts: PARENT, text: 'reply' },
];
const REPLIES_BY_TS: Record<string, unknown[]> = {
  [PARENT]: THREAD,
  [REPLY]: [THREAD[1]],
  [LONE]: [{ ts: LONE, text: 'lone' }],
};

function fakeClient(handler?: (ts: string, options: any) => unknown) {
  const calls: Array<{ channel: string; ts: string; options: any }> = [];
  return {
    calls,
    getConversationReplies: async (channel: string, ts: string, options: any = {}) => {
      calls.push({ channel, ts, options });
      if (handler) return handler(ts, options);
      return { ok: true, messages: REPLIES_BY_TS[ts] ?? [] };
    },
  };
}

describe('replyParentTs', () => {
  it('returns the parent when the only message is the reply itself', () => {
    expect(replyParentTs([THREAD[1]!], REPLY)).toBe(PARENT);
  });

  it('returns undefined for a thread parent', () => {
    expect(replyParentTs(THREAD, PARENT)).toBeUndefined();
  });

  it('returns undefined for a message with no thread', () => {
    expect(replyParentTs([{ ts: LONE }], LONE)).toBeUndefined();
  });

  it('returns undefined when the first message is not the one asked for', () => {
    // e.g. an --oldest bound that leaves the asked-for message out
    expect(replyParentTs([THREAD[1]!], PARENT)).toBeUndefined();
  });

  it('returns undefined for an empty or missing list', () => {
    expect(replyParentTs([], REPLY)).toBeUndefined();
    expect(replyParentTs(undefined, REPLY)).toBeUndefined();
  });
});

describe('fetchThreadReplies', () => {
  it('reads a parent ts in one call', async () => {
    const client = fakeClient();
    const response = await fetchThreadReplies(client, CHANNEL, PARENT, { limit: 50 });
    expect(response.messages).toEqual(THREAD);
    expect(client.calls).toHaveLength(1);
  });

  it('re-reads from the parent when the ts is a reply, with the same options', async () => {
    const client = fakeClient();
    const options = { limit: 50, oldest: '1712345600.000000', latest: '1712345800.000000' };
    const response = await fetchThreadReplies(client, CHANNEL, REPLY, options);
    expect(response.messages).toEqual(THREAD);
    expect(client.calls).toEqual([
      { channel: CHANNEL, ts: REPLY, options },
      { channel: CHANNEL, ts: PARENT, options },
    ]);
  });

  it('reads a message with no thread in one call and returns it', async () => {
    const client = fakeClient();
    const response = await fetchThreadReplies(client, CHANNEL, LONE);
    expect(response.messages).toEqual([{ ts: LONE, text: 'lone' }]);
    expect(client.calls).toHaveLength(1);
  });

  it('returns an empty response as is', async () => {
    const client = fakeClient(() => ({ ok: true, messages: [] }));
    const response = await fetchThreadReplies(client, CHANNEL, REPLY);
    expect(response.messages).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it('lets a Slack error propagate', async () => {
    const client = fakeClient(() => {
      throw new Error('thread_not_found');
    });
    await expect(fetchThreadReplies(client, CHANNEL, REPLY)).rejects.toThrow('thread_not_found');
  });
});

describe('resolveThreadParent', () => {
  it('returns the parent of a reply, asking for a single message', async () => {
    const client = fakeClient();
    expect(await resolveThreadParent(client, CHANNEL, REPLY)).toBe(PARENT);
    expect(client.calls).toEqual([{ channel: CHANNEL, ts: REPLY, options: { limit: 1 } }]);
  });

  it('returns a parent ts unchanged', async () => {
    expect(await resolveThreadParent(fakeClient(), CHANNEL, PARENT)).toBe(PARENT);
  });

  it('returns the ts of a message with no thread unchanged', async () => {
    expect(await resolveThreadParent(fakeClient(), CHANNEL, LONE)).toBe(LONE);
  });

  it('falls back to the ts when the lookup fails', async () => {
    const client = fakeClient(() => {
      throw new Error('not_in_channel');
    });
    expect(await resolveThreadParent(client, CHANNEL, REPLY)).toBe(REPLY);
  });

  it('falls back to the ts when Slack returns no messages', async () => {
    const client = fakeClient(() => ({ ok: true }));
    expect(await resolveThreadParent(client, CHANNEL, REPLY)).toBe(REPLY);
  });
});

describe('resolvePostThread', () => {
  it('resolves a target that may name a reply to its parent', async () => {
    const client = fakeClient();
    const target = { channelId: CHANNEL, threadTs: REPLY, workspace: 'acme', mayBeReply: true as const };
    expect(await resolvePostThread(client, CHANNEL, target)).toEqual({ ...target, threadTs: PARENT });
  });

  it('keeps a parent link target unchanged after one lookup', async () => {
    const client = fakeClient();
    const target = { channelId: CHANNEL, threadTs: PARENT, mayBeReply: true as const };
    expect(await resolvePostThread(client, CHANNEL, target)).toEqual(target);
    expect(client.calls).toHaveLength(1);
  });

  it('makes no call for a target whose thread came from ?thread_ts= or --thread-ts', async () => {
    const client = fakeClient();
    const target = { channelId: CHANNEL, threadTs: REPLY };
    expect(await resolvePostThread(client, CHANNEL, target)).toBe(target);
    expect(client.calls).toHaveLength(0);
  });

  it('makes no call for a target with no thread', async () => {
    const client = fakeClient();
    const target = { channelId: CHANNEL, threadTs: undefined };
    expect(await resolvePostThread(client, CHANNEL, target)).toBe(target);
    expect(client.calls).toHaveLength(0);
  });

  it('looks the thread up in the channel it is given', async () => {
    const client = fakeClient();
    await resolvePostThread(client, 'C0999999999', { channelId: CHANNEL, threadTs: REPLY, mayBeReply: true as const });
    expect(client.calls[0]?.channel).toBe('C0999999999');
  });
});
