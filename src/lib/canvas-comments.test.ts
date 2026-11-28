import { describe, expect, it } from 'bun:test';
import { canvasCommentChannelId, checkCanvasId, fetchCanvasComments } from './canvas-comments.ts';
import { InvalidInputError, NotFoundError } from './cli-errors.ts';

const CANVAS = 'F0123456789';
const CHANNEL = 'C0123456789';

// History comes newest first, as Slack returns it.
const HISTORY = [
  { type: 'message', ts: '1712345678.000300', user: 'U0123456789', text: 'third' },
  { type: 'message', ts: '1712345678.000200', user: 'U0123456789', text: 'second', reply_count: 2 },
  { type: 'message', ts: '1712345678.000100', user: 'U0123456789', text: 'first', reply_count: 0 },
];

const THREAD = [
  { type: 'message', ts: '1712345678.000200', thread_ts: '1712345678.000200', text: 'second' },
  { type: 'message', ts: '1712345678.000210', thread_ts: '1712345678.000200', text: 'reply a' },
  { type: 'message', ts: '1712345678.000220', thread_ts: '1712345678.000200', text: 'reply b' },
];

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { slackData: { ok: false, error: code } });
}

function fakeClient(history: () => any = () => ({ ok: true, messages: HISTORY, has_more: false })) {
  const calls: Array<{ method: string; channel: string; ts?: string; options: unknown }> = [];
  return {
    calls,
    async getConversationHistory(channel: string, options: unknown) {
      calls.push({ method: 'history', channel, options });
      return history();
    },
    async getConversationReplies(channel: string, ts: string, options: unknown) {
      calls.push({ method: 'replies', channel, ts, options });
      return { ok: true, messages: THREAD };
    },
  };
}

describe('canvasCommentChannelId', () => {
  it('swaps the leading F for C', () => {
    expect(canvasCommentChannelId(CANVAS)).toBe(CHANNEL);
  });

  it('upper-cases a lower-case ID, as Slack IDs are', () => {
    expect(canvasCommentChannelId('f0123abc')).toBe('C0123ABC');
  });
});

describe('checkCanvasId', () => {
  it('accepts a canvas file ID', () => {
    expect(checkCanvasId(CANVAS)).toBe(CANVAS);
  });

  it.each(['C0123456789', 'U0123456789', 'F', 'F01-23', ''])('rejects %p', (id) => {
    expect(() => checkCanvasId(id)).toThrow(InvalidInputError);
  });
});

describe('fetchCanvasComments', () => {
  it('reads the mapped conversation, oldest first, with replies and without the comment itself', async () => {
    const client = fakeClient();
    const result = await fetchCanvasComments(client, CANVAS, { limit: 50 });

    expect(result.channel_id).toBe(CHANNEL);
    expect(result.has_more).toBe(false);
    expect(result.comments.map((c) => c.text)).toEqual(['first', 'second', 'third']);
    expect(result.comments[0].replies).toEqual([]);
    expect(result.comments[1].replies.map((r) => r.text)).toEqual(['reply a', 'reply b']);
    expect(result.comments[2].replies).toEqual([]);
  });

  it('reads replies only for comments that have them', async () => {
    const client = fakeClient();
    await fetchCanvasComments(client, CANVAS, { limit: 50 });
    expect(client.calls).toEqual([
      { method: 'history', channel: CHANNEL, options: { limit: 50 } },
      { method: 'replies', channel: CHANNEL, ts: '1712345678.000200', options: { limit: 1000 } },
    ]);
  });

  it('passes has_more through', async () => {
    const client = fakeClient(() => ({ ok: true, messages: HISTORY.slice(0, 1), has_more: true }));
    const result = await fetchCanvasComments(client, CANVAS, { limit: 1 });
    expect(result.has_more).toBe(true);
    expect(result.comments).toHaveLength(1);
  });

  it('returns no comments for an empty conversation', async () => {
    const client = fakeClient(() => ({ ok: true, messages: [] }));
    const result = await fetchCanvasComments(client, CANVAS, { limit: 50 });
    expect(result.comments).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it('reports progress', async () => {
    const progress: string[] = [];
    await fetchCanvasComments(fakeClient(), CANVAS, { limit: 50, onProgress: (m) => progress.push(m) });
    expect(progress).toEqual(['Fetching canvas comments...', 'Fetching comment replies...']);
  });

  it('turns channel_not_found into not_found, as a canvas with no comments has no conversation', async () => {
    const client = fakeClient(() => {
      throw slackError('channel_not_found');
    });
    const err = await fetchCanvasComments(client, CANVAS, { limit: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe(`No comments found for canvas ${CANVAS}`);
    expect(err.hint).toContain('no comments yet');
  });

  it('lets any other Slack error propagate unchanged', async () => {
    const original = slackError('missing_scope');
    const client = fakeClient(() => {
      throw original;
    });
    await expect(fetchCanvasComments(client, CANVAS, { limit: 50 })).rejects.toBe(original);
  });

  it('does not mistake a message that merely mentions channel_not_found for the Slack code', async () => {
    const client = fakeClient(() => {
      throw new Error('channel_not_found');
    });
    const err = await fetchCanvasComments(client, CANVAS, { limit: 50 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(NotFoundError);
  });
});
