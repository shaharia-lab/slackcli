import { describe, expect, it } from 'bun:test';
import {
  applyCanvasMentions,
  CanvasReadError,
  fetchCanvasHtml,
  resolveCanvasId,
  resolveCanvasMentions,
} from './canvas-read.ts';
import type { SlackClient } from './slack-client.ts';
import type { SlackUser } from '../types/index.ts';

// Minimal fake client that records every call and returns canned responses
function createFakeClient(overrides: {
  getChannelCanvasId?: (channel: string) => Promise<string | null>;
  getFileInfo?: (fileId: string) => Promise<any>;
  downloadFile?: (url: string, maxBytes: number) => Promise<string>;
  getUsersInfo?: (ids: string[]) => Promise<any>;
  getConversationInfo?: (channel: string) => Promise<any>;
} = {}): { client: SlackClient; calls: Array<[string, ...any[]]> } {
  const calls: Array<[string, ...any[]]> = [];
  const record = <A extends any[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push([name, ...args]);
      return fn(...args);
    };

  const client = {
    getChannelCanvasId: record('getChannelCanvasId', overrides.getChannelCanvasId ?? (() => Promise.resolve(null))),
    getFileInfo: record('getFileInfo', overrides.getFileInfo ?? (() => Promise.resolve({}))),
    downloadFile: record('downloadFile', overrides.downloadFile ?? (() => Promise.resolve(''))),
    getUsersInfo: record('getUsersInfo', overrides.getUsersInfo ?? (() => Promise.resolve({ users: [] }))),
    getConversationInfo: record('getConversationInfo', overrides.getConversationInfo ?? (() => Promise.resolve({ channel: {} }))),
  } as unknown as SlackClient;

  return { client, calls };
}

async function captureError(promise: Promise<unknown>): Promise<CanvasReadError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CanvasReadError);
    return err as CanvasReadError;
  }
  throw new Error('expected the promise to reject');
}

describe('CanvasReadError', () => {
  it('uses the detail as its message when there is one', () => {
    const err = new CanvasReadError('Summary', 1, 'Detail');
    expect(err.message).toBe('Detail');
    expect(err.name).toBe('CanvasReadError');
    expect(err).toBeInstanceOf(Error);
  });

  it('falls back to the summary as its message', () => {
    const err = new CanvasReadError('Summary', 0);
    expect(err.message).toBe('Summary');
    expect(err.detail).toBeUndefined();
  });
});

describe('resolveCanvasId', () => {
  it('returns an explicit canvas ID without calling Slack', async () => {
    const { client, calls } = createFakeClient();
    const progress: string[] = [];

    const id = await resolveCanvasId(client, { canvasId: 'F0123ABC' }, (m) => progress.push(m));

    expect(id).toBe('F0123ABC');
    expect(calls).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('prefers the explicit canvas ID over --channel', async () => {
    const { client, calls } = createFakeClient({ getChannelCanvasId: () => Promise.resolve('F999') });

    expect(await resolveCanvasId(client, { canvasId: 'F111', channel: 'C1' })).toBe('F111');
    expect(calls).toEqual([]);
  });

  it('accepts a lowercase canvas ID', async () => {
    const { client } = createFakeClient();
    expect(await resolveCanvasId(client, { canvasId: 'f0123abc' })).toBe('f0123abc');
  });

  it('looks up the canvas of a channel', async () => {
    const { client, calls } = createFakeClient({ getChannelCanvasId: () => Promise.resolve('F0CHANNEL') });
    const progress: string[] = [];

    const id = await resolveCanvasId(client, { channel: 'C123' }, (m) => progress.push(m));

    expect(id).toBe('F0CHANNEL');
    expect(calls).toEqual([['getChannelCanvasId', 'C123']]);
    expect(progress).toEqual(['Looking up channel canvas...']);
  });

  it('fails with exit code 0 when the channel has no canvas', async () => {
    const { client } = createFakeClient({ getChannelCanvasId: () => Promise.resolve(null) });

    const err = await captureError(resolveCanvasId(client, { channel: 'C123' }));

    expect(err.summary).toBe('No canvas found for this channel');
    expect(err.detail).toBeUndefined();
    expect(err.exitCode).toBe(0);
  });

  it('fails with exit code 1 when neither a canvas ID nor a channel is given', async () => {
    const { client, calls } = createFakeClient();

    const err = await captureError(resolveCanvasId(client, {}));

    expect(err.summary).toBe('Missing canvas ID');
    expect(err.detail).toBe('Provide a canvas ID or use --channel to read a channel canvas.');
    expect(err.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it('treats an empty canvas ID as missing', async () => {
    const { client } = createFakeClient();
    const err = await captureError(resolveCanvasId(client, { canvasId: '' }));
    expect(err.summary).toBe('Missing canvas ID');
  });

  it.each(['C0123ABC', 'F', 'F12-34', 'F123 ', 'xF123', 'F12_3'])(
    'fails with exit code 1 for the invalid canvas ID %p',
    async (canvasId) => {
      const { client } = createFakeClient();

      const err = await captureError(resolveCanvasId(client, { canvasId }));

      expect(err.summary).toBe('Invalid canvas ID');
      expect(err.detail).toBe(
        'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).',
      );
      expect(err.exitCode).toBe(1);
    },
  );

  it('validates a canvas ID that came from the channel lookup too', async () => {
    const { client } = createFakeClient({ getChannelCanvasId: () => Promise.resolve('not-a-canvas') });

    const err = await captureError(resolveCanvasId(client, { channel: 'C123' }));

    expect(err.summary).toBe('Invalid canvas ID');
    expect(err.exitCode).toBe(1);
  });

  it('lets API errors from the channel lookup propagate unchanged', async () => {
    const apiError = new Error('channel_not_found');
    const { client } = createFakeClient({ getChannelCanvasId: () => Promise.reject(apiError) });

    await expect(resolveCanvasId(client, { channel: 'C123' })).rejects.toBe(apiError);
  });
});

describe('fetchCanvasHtml', () => {
  const canvasHtml = '<html><body><h1>Plan</h1></body></html>';

  it('downloads the canvas from url_private_download with a 10 MB cap', async () => {
    const file = { id: 'F1', title: 'Plan', url_private_download: 'https://dl', url_private: 'https://priv' };
    const { client, calls } = createFakeClient({
      getFileInfo: () => Promise.resolve({ file }),
      downloadFile: () => Promise.resolve(canvasHtml),
    });
    const progress: string[] = [];

    const result = await fetchCanvasHtml(client, 'F1', (m) => progress.push(m));

    expect(result).toEqual({ file, html: canvasHtml });
    expect(calls).toEqual([
      ['getFileInfo', 'F1'],
      ['downloadFile', 'https://dl', 10 * 1024 * 1024],
    ]);
    expect(progress).toEqual(['Fetching canvas metadata...', 'Downloading canvas content...']);
  });

  it('falls back to url_private when there is no download URL', async () => {
    const { client, calls } = createFakeClient({
      getFileInfo: () => Promise.resolve({ file: { id: 'F1', url_private: 'https://priv' } }),
      downloadFile: () => Promise.resolve(canvasHtml),
    });

    await fetchCanvasHtml(client, 'F1');

    expect(calls[1]).toEqual(['downloadFile', 'https://priv', 10 * 1024 * 1024]);
  });

  it('fails with exit code 0 when Slack returns no file info', async () => {
    const { client, calls } = createFakeClient({ getFileInfo: () => Promise.resolve({ ok: true }) });

    const err = await captureError(fetchCanvasHtml(client, 'F1'));

    expect(err.summary).toBe('Canvas not found');
    expect(err.detail).toBeUndefined();
    expect(err.exitCode).toBe(0);
    expect(calls).toEqual([['getFileInfo', 'F1']]);
  });

  it('fails with exit code 0 when the file has no download URL', async () => {
    const { client, calls } = createFakeClient({
      getFileInfo: () => Promise.resolve({ file: { id: 'F1', url_private_download: '', url_private: '' } }),
    });

    const err = await captureError(fetchCanvasHtml(client, 'F1'));

    expect(err.summary).toBe('No download URL available for this canvas');
    expect(err.detail).toBeUndefined();
    expect(err.exitCode).toBe(0);
    expect(calls).toEqual([['getFileInfo', 'F1']]);
  });

  it.each([
    '<html><form action="/signin" method="post"></form></html>',
    '<html><div data-qa="signin_domain_input"></div></html>',
    '<html><head><title>Sign in | Slack</title></head></html>',
  ])('fails with exit code 1 when the download is a sign-in page (%#)', async (signInHtml) => {
    const { client } = createFakeClient({
      getFileInfo: () => Promise.resolve({ file: { id: 'F1', url_private: 'https://priv' } }),
      downloadFile: () => Promise.resolve(signInHtml),
    });

    const err = await captureError(fetchCanvasHtml(client, 'F1'));

    expect(err.summary).toBe('Authentication expired');
    expect(err.detail).toBe('The downloaded content is a Slack sign-in page. Your token may have expired.');
    expect(err.exitCode).toBe(1);
  });

  it('lets download errors propagate unchanged', async () => {
    const downloadError = new Error('File exceeds maximum size');
    const { client } = createFakeClient({
      getFileInfo: () => Promise.resolve({ file: { id: 'F1', url_private: 'https://priv' } }),
      downloadFile: () => Promise.reject(downloadError),
    });

    await expect(fetchCanvasHtml(client, 'F1')).rejects.toBe(downloadError);
  });
});

describe('resolveCanvasMentions', () => {
  it('makes no calls and reports no progress when there are no mentions', async () => {
    const { client, calls } = createFakeClient();
    const progress: string[] = [];

    const mentions = await resolveCanvasMentions(client, '# Plan\n\nNo mentions here.', (m) => progress.push(m));

    expect(mentions.users.size).toBe(0);
    expect(mentions.channels.size).toBe(0);
    expect(calls).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('resolves each distinct user and channel once', async () => {
    const { client, calls } = createFakeClient({
      getUsersInfo: (ids) => Promise.resolve({
        users: ids.map((id) => ({ id, name: id.toLowerCase(), real_name: `Real ${id}` })),
      }),
      getConversationInfo: (ch) => Promise.resolve({ channel: { name: `chan-${ch}` } }),
    });
    const progress: string[] = [];

    const mentions = await resolveCanvasMentions(
      client,
      '<@U1> and <@U2> and <@U1> in <#C1> and <#C2> and <#C1>',
      (m) => progress.push(m),
    );

    expect(calls).toEqual([
      ['getUsersInfo', ['U1', 'U2']],
      ['getConversationInfo', 'C1'],
      ['getConversationInfo', 'C2'],
    ]);
    expect(Array.from(mentions.users.keys())).toEqual(['U1', 'U2']);
    expect(Object.fromEntries(mentions.channels)).toEqual({ C1: 'chan-C1', C2: 'chan-C2' });
    expect(progress).toEqual(['Resolving mentions...']);
  });

  it('matches mentions case-insensitively', async () => {
    const { client, calls } = createFakeClient();

    await resolveCanvasMentions(client, '<@u1abc> <#c9xyz>');

    expect(calls).toEqual([
      ['getUsersInfo', ['u1abc']],
      ['getConversationInfo', 'c9xyz'],
    ]);
  });

  it('skips the user lookup when only channels are mentioned', async () => {
    const { client, calls } = createFakeClient({
      getConversationInfo: () => Promise.resolve({ channel: { name: 'general' } }),
    });

    const mentions = await resolveCanvasMentions(client, 'See <#C1>');

    expect(calls).toEqual([['getConversationInfo', 'C1']]);
    expect(Object.fromEntries(mentions.channels)).toEqual({ C1: 'general' });
  });

  it('skips the channel lookups when only users are mentioned', async () => {
    const { client, calls } = createFakeClient();

    await resolveCanvasMentions(client, 'Ping <@U1>');

    expect(calls).toEqual([['getUsersInfo', ['U1']]]);
  });

  it('tolerates a users response without a users array', async () => {
    const { client } = createFakeClient({ getUsersInfo: () => Promise.resolve({}) });

    const mentions = await resolveCanvasMentions(client, '<@U1>');

    expect(mentions.users.size).toBe(0);
  });

  it('skips channels that fail to resolve or have no name', async () => {
    const { client } = createFakeClient({
      getConversationInfo: (ch) => {
        if (ch === 'C1') return Promise.reject(new Error('channel_not_found'));
        if (ch === 'C2') return Promise.resolve({ channel: {} });
        return Promise.resolve({ channel: { name: 'ok' } });
      },
    });

    const mentions = await resolveCanvasMentions(client, '<#C1> <#C2> <#C3>');

    expect(Array.from(mentions.channels.entries())).toEqual([['C3', 'ok']]);
  });

  it('lets a failed user lookup propagate', async () => {
    const usersError = new Error('ratelimited');
    const { client } = createFakeClient({ getUsersInfo: () => Promise.reject(usersError) });

    await expect(resolveCanvasMentions(client, '<@U1>')).rejects.toBe(usersError);
  });

  it('ignores mention-like text that is not a user or channel mention', async () => {
    const { client, calls } = createFakeClient();

    await resolveCanvasMentions(client, '<@W1> <#G1> <@U> <#C> @U1 #C1');

    expect(calls).toEqual([]);
  });
});

describe('applyCanvasMentions', () => {
  const user = (fields: Partial<SlackUser> & { id: string }) => fields as SlackUser;

  it('prefers real_name, then name, then the raw ID for users', () => {
    const markdown = applyCanvasMentions('<@U1> <@U2> <@U3>', {
      users: new Map([
        ['U1', user({ id: 'U1', name: 'alice', real_name: 'Alice Smith' })],
        ['U2', user({ id: 'U2', name: 'bob', real_name: '' })],
        ['U3', user({ id: 'U3', name: '' })],
      ]),
      channels: new Map(),
    });

    expect(markdown).toBe('@Alice Smith @bob @U3');
  });

  it('replaces every occurrence of a resolved mention', () => {
    const markdown = applyCanvasMentions('<@U1> <#C1> <@U1> <#C1>', {
      users: new Map([['U1', user({ id: 'U1', name: 'alice' })]]),
      channels: new Map([['C1', 'general']]),
    });

    expect(markdown).toBe('@alice #general @alice #general');
  });

  it('leaves unresolved mentions untouched', () => {
    const markdown = applyCanvasMentions('<@U1> <@U2> <#C1> <#C2>', {
      users: new Map([['U1', user({ id: 'U1', name: 'alice' })]]),
      channels: new Map([['C1', 'general']]),
    });

    expect(markdown).toBe('@alice <@U2> #general <#C2>');
  });

  it('returns the markdown unchanged when nothing was resolved', () => {
    const markdown = '# Plan\n\n<@U1> owns <#C1>';
    expect(applyCanvasMentions(markdown, { users: new Map(), channels: new Map() })).toBe(markdown);
  });
});
