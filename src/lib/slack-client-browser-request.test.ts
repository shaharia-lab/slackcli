import { afterEach, describe, expect, it } from 'bun:test';
import { SlackClient, SlackTransportError } from './slack-client.ts';
import { RateLimiter } from './rate-limiter.ts';
import type { WorkspaceConfig } from '../types/index.ts';

// Pins the browser-auth transport (browserRequest and its helpers) end to end
// through request(): the exact request it sends and the exact error it throws
// for each failure. retry.ts and command-errors.ts depend on that contract.

const browserConfig: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Test Workspace',
  auth_type: 'browser',
  xoxd_token: 'xoxd-a/b+c=',
  xoxc_token: 'xoxc-test',
  workspace_url: 'https://acme.slack.com',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Sent {
  url: string;
  init: RequestInit;
}

function client(): SlackClient {
  return new SlackClient(
    { ...browserConfig },
    { rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }), retry: { maxRetries: 0 } },
  );
}

function answerWith(response: () => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input, init) => {
    sent.push({ url: String(input), init: init! });
    return response();
  }) as typeof fetch;
  return sent;
}

async function failureOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('browser-auth request shape', () => {
  it('sends a urlencoded body, token first, objects as JSON and undefined params left out', async () => {
    const sent = answerWith(() => Response.json({ ok: true, value: 1 }));

    const data = await client().request('chat.postMessage', {
      channel: 'C123',
      skipped: undefined,
      blocks: [{ type: 'section' }],
      unfurl_links: false,
      limit: 5,
    });

    expect(data).toEqual({ ok: true, value: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://acme.slack.com/api/chat.postMessage');
    expect(sent[0].init.method).toBe('POST');
    expect(sent[0].init.headers).toStrictEqual({
      'Cookie': 'd=xoxd-a%2Fb%2Bc%3D',
      'Origin': 'https://app.slack.com',
      'User-Agent': 'Mozilla/5.0 (compatible; SlackCLI/0.1.0)',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = sent[0].init.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect([...body.entries()]).toStrictEqual([
      ['token', 'xoxc-test'],
      ['channel', 'C123'],
      ['blocks', '[{"type":"section"}]'],
      ['unfurl_links', 'false'],
      ['limit', '5'],
    ]);
  });

  it('sends a multipart body with no Content-Type when a param is a Blob', async () => {
    const sent = answerWith(() => Response.json({ ok: true }));

    await client().request('emoji.add', {
      mode: 'data',
      name: 'party',
      image: new File(['png-bytes'], 'party.png', { type: 'image/png' }),
      skipped: undefined,
      extra: { a: 1 },
    });

    expect(sent[0].init.headers).toStrictEqual({
      'Cookie': 'd=xoxd-a%2Fb%2Bc%3D',
      'Origin': 'https://app.slack.com',
      'User-Agent': 'Mozilla/5.0 (compatible; SlackCLI/0.1.0)',
    });
    const form = sent[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toStrictEqual(['token', 'mode', 'name', 'image', 'extra']);
    expect(form.get('token')).toBe('xoxc-test');
    expect(form.get('extra')).toBe('{"a":1}');
    const image = form.get('image') as File;
    expect(image.name).toBe('party.png');
    expect(await image.text()).toBe('png-bytes');
  });

  it('names a nameless Blob after its param key', async () => {
    const sent = answerWith(() => Response.json({ ok: true }));

    await client().request('emoji.add', { image: new Blob(['raw']) });

    const image = (sent[0].init.body as FormData).get('image') as File;
    expect(image.name).toBe('image');
    expect(await image.text()).toBe('raw');
  });
});

describe('browser-auth error contract', () => {
  it('turns a fetch rejection into a retryable network SlackTransportError', async () => {
    globalThis.fetch = (async (_input, _init): Promise<Response> => {
      throw new TypeError('network down');
    }) as typeof fetch;

    const error = await failureOf(client().request('users.info', { user: 'U1' }));

    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.message).toBe('Slack API error: network down');
    expect(error.httpStatus).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.networkError).toBe(true);
  });

  it('cancels a non-2xx body and reports its status and Retry-After', async () => {
    let cancelled = false;
    answerWith(() => {
      const body = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 429, headers: { 'Retry-After': '7' } });
    });

    const error = await failureOf(client().request('users.info', { user: 'U1' }));

    expect(cancelled).toBe(true);
    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.message).toBe('Slack API error: HTTP error! status: 429');
    expect(error.httpStatus).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
    expect(error.networkError).toBe(false);
  });

  it('keeps the transport error when cancelling the body fails', async () => {
    answerWith(() => {
      const response = new Response('broken', { status: 503 });
      Object.defineProperty(response, 'body', {
        value: { cancel: () => Promise.reject(new Error('already errored')) },
      });
      return response;
    });

    const error = await failureOf(client().request('users.info', { user: 'U1' }));

    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.message).toBe('Slack API error: HTTP error! status: 503');
    expect(error.httpStatus).toBe(503);
    expect(error.retryAfterMs).toBeUndefined();
  });

  it('wraps an ok:false payload as a Slack API error that carries the payload', async () => {
    const payload = { ok: false, error: 'channel_not_found', needed: 'x' };
    answerWith(() => Response.json(payload));

    const error = await failureOf(client().request('chat.postMessage', { channel: 'C1' }));

    expect(error).not.toBeInstanceOf(SlackTransportError);
    expect(error.message).toBe('Slack API error: channel_not_found');
    expect(error.slackData).toStrictEqual(payload);
  });

  it('names an ok:false payload with no error code as an unknown API error', async () => {
    answerWith(() => Response.json({ ok: false }));

    const error = await failureOf(client().request('conversations.leave', { channel: 'C1' }));

    expect(error.message).toBe('Slack API error: Unknown API error');
    expect(error.slackData).toStrictEqual({ ok: false });
  });

  it('wraps an unparseable 2xx body without a Slack payload', async () => {
    answerWith(() => new Response('<html>not json</html>', { status: 200 }));

    const error = await failureOf(client().request('users.info', { user: 'U1' }));

    expect(error).not.toBeInstanceOf(SlackTransportError);
    expect(error.message.startsWith('Slack API error: ')).toBe(true);
    expect('slackData' in error).toBe(false);
  });

  it('wraps a JSON null body as a Slack API error, not a raw TypeError', async () => {
    answerWith(() => new Response('null', { status: 200 }));

    const error = await failureOf(client().request('users.info', { user: 'U1' }));

    expect(error).not.toBeInstanceOf(SlackTransportError);
    expect(error.message.startsWith('Slack API error: ')).toBe(true);
    expect('slackData' in error).toBe(false);
  });
});
