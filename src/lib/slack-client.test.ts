import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resetSync } from '@logtape/logtape';
import {
  checkUploadFile,
  DRAFT_CREATE_AUTH_MESSAGE,
  SlackClient,
  SlackTransportError,
} from './slack-client.ts';
import { InvalidInputError, UnsupportedAuthTypeError } from './cli-errors.ts';
import { AUTH_ERROR_CODES, SlackAuthError } from './auth-errors.ts';
import { configureLogging } from './logger.ts';
import { RateLimiter, SLACK_MIN_REQUEST_INTERVAL_MS } from './rate-limiter.ts';
import { isReadMethod } from './retry.ts';

class TestSlackClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private uploadCounter = 0;

  constructor() {
    super({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });
  }

  override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });

    if (method === 'files.getUploadURLExternal') {
      this.uploadCounter += 1;
      return {
        ok: true,
        upload_url: `https://uploads.slack.test/file/${this.uploadCounter}`,
        file_id: `F${this.uploadCounter}`,
      };
    }

    if (method === 'files.completeUploadExternal') {
      const files = JSON.parse(params.files as string) as Array<{ id: string; title: string }>;
      return {
        ok: true,
        files: files.map((f) => ({ id: f.id, title: f.title })),
      };
    }

    if (method === 'chat.update') {
      return { ok: true, channel: params.channel, ts: params.ts, text: params.text };
    }

    if (method === 'chat.postMessage') {
      return { ok: true, channel: params.channel, ts: '1234567890.123456' };
    }

    if (method === 'drafts.list') {
      return { ok: true, drafts: [], files: [], has_more: false };
    }

    if (method === 'drafts.create') {
      return { ok: true, draft: { id: 'Dr123' } };
    }

    if (method === 'subscriptions.thread.getView') {
      return { ok: true, threads: [], has_more: false };
    }

    if (method === 'drafts.delete') {
      return { ok: true };
    }

    if (method === 'conversations.members') {
      return {
        ok: true,
        members: ['U1', 'U2', 'U3'],
        response_metadata: { next_cursor: '' },
      };
    }

    if (method === 'chat.getPermalink') {
      return {
        ok: true,
        channel: params.channel,
        permalink: 'https://example.slack.com/archives/C123/p1234567890123456',
      };
    }

    throw new Error(`Unexpected method: ${method}`);
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SlackClient.uploadFileExternal', () => {
  it('uploads a local file and shares it with the message as the initial comment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-upload-'));
    const filePath = join(dir, 'report.txt');
    await Bun.write(filePath, 'Quarterly report');

    let uploadRequest: { url: string; bodyText: string; contentType?: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(Uint8Array);
      uploadRequest = {
        url: String(input),
        bodyText: new TextDecoder().decode(body as Uint8Array),
        contentType: init?.headers instanceof Headers
          ? init.headers.get('Content-Type') ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.['Content-Type'],
      };

      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const client = new TestSlackClient();

      await client.uploadFileExternal('C123', filePath, {
        initial_comment: 'Here is the file',
      });

      expect(client.calls).toEqual([
        {
          method: 'files.getUploadURLExternal',
          params: {
            filename: 'report.txt',
            length: 16,
          },
        },
        {
          method: 'files.completeUploadExternal',
          params: {
            files: JSON.stringify([{ id: 'F1', title: 'report.txt' }]),
            channel_id: 'C123',
            initial_comment: 'Here is the file',
          },
        },
      ]);
      expect(uploadRequest).toEqual({
        url: 'https://uploads.slack.test/file/1',
        bodyText: 'Quarterly report',
        contentType: 'application/octet-stream',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the file does not exist', async () => {
    const client = new TestSlackClient();

    await expect(
      client.uploadFileExternal('C123', '/tmp/slackcli-missing-file.txt', {
        initial_comment: 'Here is the file',
      }),
    ).rejects.toThrow('File not found: /tmp/slackcli-missing-file.txt');

    expect(client.calls).toEqual([]);
  });

describe('SlackClient.uploadFilesExternal', () => {
  it('uploads several files and shares them in one message with a single comment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-multi-upload-'));
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    const c = join(dir, 'c.txt');
    await Bun.write(a, 'alpha');
    await Bun.write(b, 'bravo!');
    await Bun.write(c, 'charlie');

    const uploads: Array<{ url: string; bodyText: string }> = [];
    globalThis.fetch = (async (input, init) => {
      uploads.push({
        url: String(input),
        bodyText: new TextDecoder().decode(init?.body as Uint8Array),
      });
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const client = new TestSlackClient();

      const result = await client.uploadFilesExternal('C123', [a, b, c], {
        initial_comment: 'Three files',
        thread_ts: '1712345678.000100',
      });

      // One getUploadURLExternal + PUT per file, then exactly ONE
      // completeUploadExternal listing every uploaded file against one comment.
      expect(client.calls).toEqual([
        { method: 'files.getUploadURLExternal', params: { filename: 'a.txt', length: 5 } },
        { method: 'files.getUploadURLExternal', params: { filename: 'b.txt', length: 6 } },
        { method: 'files.getUploadURLExternal', params: { filename: 'c.txt', length: 7 } },
        {
          method: 'files.completeUploadExternal',
          params: {
            files: JSON.stringify([
              { id: 'F1', title: 'a.txt' },
              { id: 'F2', title: 'b.txt' },
              { id: 'F3', title: 'c.txt' },
            ]),
            channel_id: 'C123',
            initial_comment: 'Three files',
            thread_ts: '1712345678.000100',
          },
        },
      ]);
      expect(uploads.map((u) => u.url)).toEqual([
        'https://uploads.slack.test/file/1',
        'https://uploads.slack.test/file/2',
        'https://uploads.slack.test/file/3',
      ]);
      expect(uploads.map((u) => u.bodyText)).toEqual(['alpha', 'bravo!', 'charlie']);
      expect(result.files?.map((f) => f.id)).toEqual(['F1', 'F2', 'F3']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates every file before any Slack call, so one bad path posts nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-multi-badpath-'));
    const good = join(dir, 'good.txt');
    await Bun.write(good, 'ok');

    let fetchCalled = false;
    globalThis.fetch = (async (_input, _init) => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const client = new TestSlackClient();

      await expect(
        client.uploadFilesExternal('C123', [good, join(dir, 'nope.txt')], {
          initial_comment: 'should not post',
        }),
      ).rejects.toThrow(/File not found: .*nope\.txt/);

      // Nothing was uploaded and no message was completed: all-or-nothing.
      expect(client.calls).toEqual([]);
      expect(fetchCalled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the file whose PUT failed and never completes the upload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-multi-putfail-'));
    const a = join(dir, 'first.txt');
    const b = join(dir, 'second.txt');
    await Bun.write(a, 'one');
    await Bun.write(b, 'two');

    // First PUT succeeds, second fails with a non-2xx.
    let call = 0;
    globalThis.fetch = (async (_input, _init) => {
      call += 1;
      return new Response('', { status: call === 1 ? 200 : 500 });
    }) as typeof fetch;

    try {
      const client = new TestSlackClient();

      await expect(
        client.uploadFilesExternal('C123', [a, b], { initial_comment: 'partial' }),
      ).rejects.toThrow('File upload failed for second.txt: HTTP 500');

      // Two upload URLs were requested, but completeUploadExternal was NEVER
      // called, so Slack posts no partial message.
      expect(client.calls.map((c) => c.method)).toEqual([
        'files.getUploadURLExternal',
        'files.getUploadURLExternal',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the file whose upload-URL request failed, keeping the Slack error code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-multi-urlfail-'));
    const a = join(dir, 'first.txt');
    const b = join(dir, 'second.txt');
    await Bun.write(a, 'one');
    await Bun.write(b, 'two');

    // A subclass that fails files.getUploadURLExternal on the SECOND file with
    // a Slack error carrying slackData — exactly how request() surfaces e.g.
    // file_upload_size_restricted. The PUT never runs for a URL that failed.
    class UrlFailClient extends TestSlackClient {
      private urlCalls = 0;
      override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        if (method === 'files.getUploadURLExternal') {
          this.urlCalls += 1;
          if (this.urlCalls === 2) {
            this.calls.push({ method, params });
            const err = new Error('Slack API error: An API error occurred: file_upload_size_restricted');
            (err as any).slackData = { ok: false, error: 'file_upload_size_restricted' };
            throw err;
          }
        }
        return super.request(method, params);
      }
    }

    globalThis.fetch = (async (_input, _init) => new Response('', { status: 200 })) as typeof fetch;

    try {
      const client = new UrlFailClient();

      // The message names the file AND the step...
      const err = await client
        .uploadFilesExternal('C123', [a, b], { initial_comment: 'partial' })
        .then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
      expect((err as Error).message).toBe(
        'Upload URL request failed for second.txt: Slack API error: An API error occurred: file_upload_size_restricted',
      );
      // ...while the Slack error code is preserved on slackData, so --json still
      // reports the same `code` / `slack_error`.
      expect((err as any).slackData?.error).toBe('file_upload_size_restricted');

      // completeUploadExternal was never called: no partial message posted.
      expect(client.calls.map((c) => c.method)).toEqual([
        'files.getUploadURLExternal',
        'files.getUploadURLExternal',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty file list', async () => {
    const client = new TestSlackClient();
    await expect(client.uploadFilesExternal('C123', [])).rejects.toThrow('No files to upload');
    expect(client.calls).toEqual([]);
  });
});
});

describe('SlackClient.fetchFile', () => {
  it('uses bearer authentication for standard tokens', async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(new Uint8Array([0, 255, 1]), { status: 200 });
    }) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type: 'bot',
    });

    const response = await client.fetchFile('https://files.slack.com/files-pri/T123-F123/report.bin');

    expect(headers?.get('Authorization')).toBe('Bearer xoxb-test');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
  });

  it('uses the browser session cookie for browser authentication', async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response('report', { status: 200 });
    }) as typeof fetch;

    const client = new TestSlackClient();
    await client.fetchFile('https://files.slack.com/files-pri/T123-F123/report.txt');

    expect(headers?.get('Cookie')).toBe('d=xoxd-test');
    expect(headers?.get('Origin')).toBe('https://app.slack.com');
    expect(headers?.has('Authorization')).toBe(false);
  });

  it('does not send credentials to a non-Slack URL', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('unexpected');
    }) as unknown as typeof fetch;

    const client = new TestSlackClient();

    await expect(client.fetchFile('https://example.com/private-file')).rejects.toThrow(
      'URL is not hosted by Slack',
    );
    expect(fetched).toBe(false);
  });

  it('does not forward browser credentials to a redirected download host', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://downloads.example.com/signed/file.txt' },
        });
      }
      return new Response('report', { status: 200 });
    }) as typeof fetch;

    const client = new TestSlackClient();
    const response = await client.fetchFile('https://files.slack.com/files-pri/T123-F123/report.txt');

    expect(await response.text()).toBe('report');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.get('Cookie')).toBe('d=xoxd-test');
    expect(requests[1]!.url).toBe('https://downloads.example.com/signed/file.txt');
    expect(requests[1]!.headers.has('Cookie')).toBe(false);
    expect(requests[1]!.headers.has('Origin')).toBe(false);
    expect(requests[1]!.headers.has('Authorization')).toBe(false);
  });

  const FILE_URL = 'https://files.slack.com/files-pri/T123-F123/report.txt';

  function standardClient(): SlackClient {
    return new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type: 'bot',
    });
  }

  // Serves the scripted responses in order and records every request.
  function scriptFetch(responses: Array<() => Response>): Array<{ url: string; headers: Headers }> {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      const next = responses[requests.length - 1];
      if (!next) throw new Error(`Unexpected request #${requests.length}`);
      return next();
    }) as typeof fetch;
    return requests;
  }

  function redirectTo(location: string | null, status = 302): () => Response {
    return () => new Response(null, { status, headers: location === null ? {} : { location } });
  }

  const ok = (body = 'report') => () => new Response(body, { status: 200 });

  it.each([
    ['a non-HTTPS URL', 'http://files.slack.com/files-pri/T123-F123/report.txt', 'Download failed: URL is not hosted by Slack'],
    ['a look-alike host', 'https://files.slack.com.evil.com/report.txt', 'Download failed: URL is not hosted by Slack'],
    ['the bare slack.com apex', 'https://slack.com/report.txt', 'Download failed: URL is not hosted by Slack'],
    ['an unparseable URL', 'not a url', 'Download failed: invalid Slack file URL'],
  ])('rejects %s before any request', async (_label, url, message) => {
    const requests = scriptFetch([]);

    await expect(new TestSlackClient().fetchFile(url)).rejects.toThrow(message);
    expect(requests).toHaveLength(0);
  });

  it('accepts a Slack host regardless of case', async () => {
    const requests = scriptFetch([ok()]);

    await new TestSlackClient().fetchFile('https://FILES.Slack.COM/files-pri/T123-F123/report.txt');

    expect(requests[0]!.headers.get('Cookie')).toBe('d=xoxd-test');
  });

  it('URL-encodes the browser cookie value', async () => {
    const requests = scriptFetch([ok()]);
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-a/b+c=',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    await client.fetchFile(FILE_URL);

    expect(requests[0]!.headers.get('Cookie')).toBe('d=xoxd-a%2Fb%2Bc%3D');
  });

  it('drops bearer credentials on an off-Slack hop and restores them when a later hop returns to Slack', async () => {
    const requests = scriptFetch([
      redirectTo('https://downloads.example.com/signed/file.txt'),
      redirectTo('https://files-edge.slack.com/files-pri/T123-F123/report.txt'),
      ok(),
    ]);

    const response = await standardClient().fetchFile(FILE_URL);

    expect(await response.text()).toBe('report');
    expect(requests.map((r) => r.url)).toEqual([
      FILE_URL,
      'https://downloads.example.com/signed/file.txt',
      'https://files-edge.slack.com/files-pri/T123-F123/report.txt',
    ]);
    expect(requests.map((r) => r.headers.get('Authorization'))).toEqual([
      'Bearer xoxb-test',
      null,
      'Bearer xoxb-test',
    ]);
  });

  it('restores browser credentials when a later hop returns to Slack', async () => {
    const requests = scriptFetch([
      redirectTo('https://downloads.example.com/signed/file.txt'),
      redirectTo('https://files.slack.com/files-pri/T123-F123/final.txt'),
      ok(),
    ]);

    await new TestSlackClient().fetchFile(FILE_URL);

    expect(requests.map((r) => [r.headers.get('Cookie'), r.headers.get('Origin')])).toEqual([
      ['d=xoxd-test', 'https://app.slack.com'],
      [null, null],
      ['d=xoxd-test', 'https://app.slack.com'],
    ]);
  });

  it('does not forward credentials to a look-alike host reached by redirect', async () => {
    const requests = scriptFetch([redirectTo('https://files.slack.com.evil.com/report.txt'), ok()]);

    await standardClient().fetchFile(FILE_URL);

    expect(requests[1]!.url).toBe('https://files.slack.com.evil.com/report.txt');
    expect(requests[1]!.headers.has('Authorization')).toBe(false);
  });

  it.each([301, 302, 303, 307, 308])('follows a %i redirect', async (status) => {
    const requests = scriptFetch([redirectTo('https://files.slack.com/next.txt', status), ok()]);

    const response = await standardClient().fetchFile(FILE_URL);

    expect(await response.text()).toBe('report');
    expect(requests[1]!.url).toBe('https://files.slack.com/next.txt');
  });

  it('treats a non-redirect 3xx as a failed download', async () => {
    const requests = scriptFetch([redirectTo('https://files.slack.com/next.txt', 304)]);

    await expect(standardClient().fetchFile(FILE_URL)).rejects.toThrow('Download failed: HTTP 304');
    expect(requests).toHaveLength(1);
  });

  it('resolves a relative Location against the current URL', async () => {
    const requests = scriptFetch([redirectTo('../F999/other.txt'), ok()]);

    await standardClient().fetchFile(FILE_URL);

    expect(requests[1]!.url).toBe('https://files.slack.com/files-pri/F999/other.txt');
    expect(requests[1]!.headers.get('Authorization')).toBe('Bearer xoxb-test');
  });

  it('rejects a redirect with no Location and releases its body', async () => {
    let cancelled = false;
    scriptFetch([
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302 },
        ),
    ]);

    await expect(standardClient().fetchFile(FILE_URL)).rejects.toThrow(
      'Download failed: redirect had no destination',
    );
    expect(cancelled).toBe(true);
  });

  it('rejects a redirect to an unparseable destination', async () => {
    const requests = scriptFetch([redirectTo('https://[invalid')]);

    await expect(standardClient().fetchFile(FILE_URL)).rejects.toThrow(
      'Download failed: redirect destination is invalid',
    );
    expect(requests).toHaveLength(1);
  });

  it('rejects a redirect to a non-HTTPS destination without following it', async () => {
    const requests = scriptFetch([redirectTo('http://files.slack.com/report.txt')]);

    await expect(standardClient().fetchFile(FILE_URL)).rejects.toThrow(
      'Download failed: redirect destination is not secure',
    );
    expect(requests).toHaveLength(1);
  });

  it('fails on a non-OK final status', async () => {
    scriptFetch([
      redirectTo('https://downloads.example.com/signed/file.txt'),
      () => new Response('gone', { status: 404 }),
    ]);

    await expect(standardClient().fetchFile(FILE_URL)).rejects.toThrow('Download failed: HTTP 404');
  });

  it('follows at most five redirects', async () => {
    const hops = Array.from({ length: 5 }, (_, i) => redirectTo(`https://files.slack.com/hop-${i + 1}`));
    const requests = scriptFetch([...hops, ok()]);

    const response = await standardClient().fetchFile(FILE_URL);

    expect(await response.text()).toBe('report');
    expect(requests).toHaveLength(6);
  });

  it('fails on the sixth redirect without following it', async () => {
    const hops = Array.from({ length: 6 }, (_, i) => redirectTo(`https://files.slack.com/hop-${i + 1}`));
    const requests = scriptFetch(hops);

    await expect(standardClient().fetchFile(FILE_URL)).rejects.toThrow('Download failed: too many redirects');
    expect(requests).toHaveLength(6);
  });
});

describe('SlackClient.updateMessage', () => {
  it('calls chat.update with the channel, timestamp, and new text', async () => {
    const client = new TestSlackClient();

    const response = await client.updateMessage('C123', '1234567890.123456', 'Corrected message');

    expect(client.calls).toEqual([
      {
        method: 'chat.update',
        params: {
          channel: 'C123',
          ts: '1234567890.123456',
          text: 'Corrected message',
          parse: 'none',
        },
      },
    ]);
    expect(response.ts).toBe('1234567890.123456');
  });

  // Without this, Slack applies the chat.update default (`client`) and stores
  // `&lt;https://example.com|label&gt;`, which renders as literal text: every
  // link in an edited message dies, silently, on a call that returns ok.
  it('sends parse=none so link markup survives the edit', async () => {
    const client = new TestSlackClient();

    await client.updateMessage('C123', '1234567890.123456', 'A <https://example.com|label> B');

    expect(client.calls[0]!.params.parse).toBe('none');
  });
});

describe('SlackClient.getPermalink', () => {
  // Slack names this parameter `message_ts`, not `ts`; sending `ts` returns a
  // channel_not_found-style error rather than the link.
  it('calls chat.getPermalink with message_ts and returns the link', async () => {
    const client = new TestSlackClient();

    const response = await client.getPermalink('C123', '1234567890.123456');

    expect(client.calls).toEqual([
      {
        method: 'chat.getPermalink',
        params: { channel: 'C123', message_ts: '1234567890.123456' },
      },
    ]);
    expect(response.permalink).toBe(
      'https://example.slack.com/archives/C123/p1234567890123456',
    );
  });
});

describe('SlackClient.listDrafts', () => {
  it('calls the browser-only drafts.list method for active drafts with the requested limit', async () => {
    const client = new TestSlackClient();

    const response = await client.listDrafts({ limit: 25 });

    expect(client.calls).toEqual([{
      method: 'drafts.list',
      params: { is_active: true, limit: 25 },
    }]);
    expect(response).toEqual({ ok: true, drafts: [], files: [], has_more: false });
  });

  it('fails before making a request when the workspace uses standard authentication', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type: 'bot',
    });

    await expect(client.listDrafts({ limit: 100 }))
      .rejects.toThrow('Draft listing requires browser authentication');
  });
});

describe('SlackClient.getUnreadThreadView', () => {
  it('asks for the first page of the Threads view with no parameters', async () => {
    const client = new TestSlackClient();

    await client.getUnreadThreadView();

    expect(client.calls).toEqual([{ method: 'subscriptions.thread.getView', params: {} }]);
  });

  it('passes the page cursor as current_ts', async () => {
    const client = new TestSlackClient();

    await client.getUnreadThreadView({ current_ts: '1700000000.000100' });

    expect(client.calls).toEqual([{ method: 'subscriptions.thread.getView', params: { current_ts: '1700000000.000100' } }]);
  });

  it('fails before making a request when the workspace uses standard authentication', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type: 'bot',
    });

    await expect(client.getUnreadThreadView())
      .rejects.toThrow('Reading unread messages (--messages) requires browser authentication');
  });
});

describe('SlackClient.createDraft', () => {
  it('sends mentions and links as rich_text elements, not literal text', async () => {
    const client = new TestSlackClient();

    await client.createDraft('C123', 'hi <@U1|bob> see <https://x.test|docs>');

    expect(client.calls[0]?.method).toBe('drafts.create');
    const blocks = JSON.parse(String(client.calls[0]?.params.blocks));
    expect(blocks[0].elements[0].elements).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'user', user_id: 'U1' },
      { type: 'text', text: ' see ' },
      { type: 'link', url: 'https://x.test', text: 'docs' },
    ]);
  });
});

describe('SlackClient.deleteDraft', () => {
  it('sends the draft id and current timestamp to the browser-only endpoint', async () => {
    const client = new TestSlackClient();
    const before = Date.now() / 1000;
    await client.deleteDraft('Dr123');
    const after = Date.now() / 1000;
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe('drafts.delete');
    expect(client.calls[0]?.params.draft_id).toBe('Dr123');
    const timestamp = Number(client.calls[0]?.params.client_last_updated_ts);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('rejects standard authentication before making a request', async () => {
    const client = new SlackClient({
      workspace_id: 'T123', workspace_name: 'Test Workspace',
      auth_type: 'standard', token: 'xoxb-test', token_type: 'bot',
    });
    await expect(client.deleteDraft('Dr123'))
      .rejects.toThrow('Draft deletion requires browser authentication');
  });
});

describe('SlackClient.postMessage', () => {
  it('passes native table blocks with rich-text links to chat.postMessage', async () => {
    const client = new TestSlackClient();
    const blocks = [{
      type: 'table',
      column_settings: [{ is_wrapped: true }, { align: 'right' }],
      rows: [[
        { type: 'raw_text', text: 'Project' },
        {
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [{ type: 'link', text: 'Slack', url: 'https://slack.com' }],
          }],
        },
      ]],
    }];

    await client.postMessage('C123', 'Project status table', {
      thread_ts: '1234567890.000001',
      blocks,
    });

    expect(client.calls).toEqual([{
      method: 'chat.postMessage',
      params: {
        channel: 'C123',
        text: 'Project status table',
        thread_ts: '1234567890.000001',
        blocks,
      },
    }]);
  });

  it('passes native markdown blocks to chat.postMessage unchanged', async () => {
    const client = new TestSlackClient();
    const blocks = [{
      type: 'markdown',
      text: '# Release notes\n\nSee the [runbook](https://example.com/runbook).',
    }];

    await client.postMessage('C123', 'Release notes', { blocks });

    expect(client.calls[0]).toEqual({
      method: 'chat.postMessage',
      params: {
        channel: 'C123',
        text: 'Release notes',
        blocks,
      },
    });
  });

  it('JSON-encodes blocks for browser-session form requests', async () => {
    let body: URLSearchParams | undefined;
    globalThis.fetch = (async (_input, init) => {
      body = init?.body as URLSearchParams;
      return Response.json({ ok: true, ts: '1234567890.123456' });
    }) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });
    const blocks = [{ type: 'table', rows: [[{ type: 'raw_text', text: 'Status' }]] }];

    await client.postMessage('C123', 'Status table', { blocks });

    expect(body?.get('channel')).toBe('C123');
    expect(body?.get('text')).toBe('Status table');
    expect(body?.get('blocks')).toBe(JSON.stringify(blocks));
  });
});

describe('SlackClient.getUsersInfo', () => {
  class UsersClient extends SlackClient {
    constructor(private readonly respond: (user: string) => Promise<unknown>) {
      super({
        workspace_id: 'T123',
        workspace_name: 'Test Workspace',
        auth_type: 'browser',
        xoxd_token: 'xoxd-test',
        xoxc_token: 'xoxc-test',
        workspace_url: 'https://example.slack.com',
      });
    }

    override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      expect(method).toBe('users.info');
      return this.respond(String(params.user));
    }
  }

  it('returns users in request order even when lookups settle out of order', async () => {
    const delays: Record<string, number> = { U1: 30, U2: 0, U3: 10 };
    const client = new UsersClient(async (user) => {
      await new Promise((resolve) => setTimeout(resolve, delays[user]));
      return { ok: true, user: { id: user } };
    });

    const response = await client.getUsersInfo(['U1', 'U2', 'U3']);

    expect(response).toEqual({ ok: true, users: [{ id: 'U1' }, { id: 'U2' }, { id: 'U3' }] });
  });

  it('skips users that fail or come back without a user, and still resolves', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = new UsersClient(async (user) => {
        if (user === 'U2') throw new Error('user_not_found');
        if (user === 'U3') return { ok: false };
        return { ok: true, user: { id: user } };
      });

      const response = await client.getUsersInfo(['U1', 'U2', 'U3', 'U4']);

      expect(response).toEqual({ ok: true, users: [{ id: 'U1' }, { id: 'U4' }] });
      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch user U2');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns an empty list for no ids', async () => {
    const client = new UsersClient(async () => {
      throw new Error('should not be called');
    });
    expect(await client.getUsersInfo([])).toEqual({ ok: true, users: [] });
  });
});

describe('SlackClient.getConversationMembers', () => {
  it('calls conversations.members with the channel and returns member IDs', async () => {
    const client = new TestSlackClient();

    const response = await client.getConversationMembers('C123', { limit: 100 });

    expect(client.calls).toEqual([
      { method: 'conversations.members', params: { channel: 'C123', limit: 100 } },
    ]);
    expect(response.members).toEqual(['U1', 'U2', 'U3']);
  });

  it('passes the pagination cursor through when provided', async () => {
    const client = new TestSlackClient();

    await client.getConversationMembers('C123', { limit: 50, cursor: 'next-page' });

    expect(client.calls[0]).toEqual({
      method: 'conversations.members',
      params: { channel: 'C123', limit: 50, cursor: 'next-page' },
    });
  });

  // Honest degradation: on an enterprise grid Slack blocks member enumeration.
  // The wrapper must surface enterprise_is_restricted (via the request wrapper's
  // "Slack API error:" prefix) rather than swallowing it, so the command can
  // print a clear message and exit non-zero.
  it('surfaces enterprise_is_restricted from an enterprise grid', async () => {
    globalThis.fetch = (async (_input, _init) =>
      Response.json({ ok: false, error: 'enterprise_is_restricted' })) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    await expect(client.getConversationMembers('C123')).rejects.toThrow('enterprise_is_restricted');
  });
});

describe('SlackClient.markConversation', () => {
  it('sends conversations.mark with the channel and ts', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    const response = await client.markConversation('C123', '1712345678.123456');

    expect(response).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/api/conversations.mark');
    const body = new URLSearchParams(requests[0].body);
    expect(body.get('channel')).toBe('C123');
    expect(body.get('ts')).toBe('1712345678.123456');
  });

  it('throws on a Slack error and does not retry the write on a 5xx', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response('upstream', { status: 503 });
    }) as unknown as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    await expect(client.markConversation('C123', '1712345678.123456')).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe('SlackClient.leaveConversation', () => {
  // Slack's conversations.leave returns { ok: false, not_in_channel: true } with
  // NO `error` field when you were already out. request() throws on ok:false, so
  // the wrapper must recover the structured payload and return it as the no-op
  // success Slack intends — not surface it as a failure.
  it('returns the not_in_channel payload as a no-op success when already out', async () => {
    globalThis.fetch = (async (_input, _init) =>
      Response.json({ ok: false, not_in_channel: true })) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    const response = await client.leaveConversation('C123');
    expect(response.not_in_channel).toBe(true);
  });

  it('still throws on a genuine leave error (e.g. cant_leave_general)', async () => {
    globalThis.fetch = (async (_input, _init) =>
      Response.json({ ok: false, error: 'cant_leave_general' })) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    await expect(client.leaveConversation('C123')).rejects.toThrow('cant_leave_general');
  });

  it('re-throws an error that carries no Slack payload (e.g. a network failure)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });

    await expect(client.leaveConversation('C123')).rejects.toThrow('socket hang up');
  });
});

describe('SlackClient request throttling', () => {
  // A fast stand-in for the process-wide limiter: same shape, test-sized numbers.
  const testLimiter = () => new RateLimiter({ maxConcurrent: 2, minIntervalMs: 25 });

  it('paces browser-session requests and caps their concurrency', async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let peakConcurrent = 0;

    globalThis.fetch = (async (_input, _init) => {
      starts.push(Date.now());
      inFlight += 1;
      peakConcurrent = Math.max(peakConcurrent, inFlight);
      // Must outlive the limiter's interval, or requests never overlap and the
      // concurrency assertion below passes vacuously.
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight -= 1;
      return Response.json({ ok: true, user: { id: 'U1' } });
    }) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    }, { rateLimiter: testLimiter() });

    await Promise.all(['U1', 'U2', 'U3', 'U4'].map((id) => client.getUserInfo(id)));

    expect(starts).toHaveLength(4);
    expect(peakConcurrent).toBe(2);
    for (let i = 1; i < starts.length; i += 1) {
      // 5ms of slack for platform timer jitter.
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(20);
    }
  });

  it('paces standard-token requests too', async () => {
    const starts: number[] = [];

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type: 'bot',
    }, { rateLimiter: testLimiter() });

    // The WebClient talks to Slack over the network; swap its transport for a stub
    // so the test exercises the limiter around `standardRequest`, not the SDK.
    (client as unknown as { webClient: { apiCall: (method: string) => Promise<unknown> } }).webClient = {
      apiCall: async () => {
        starts.push(Date.now());
        return { ok: true };
      },
    };

    await Promise.all(['U1', 'U2', 'U3'].map((id) => client.getUserInfo(id)));

    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(20);
    }
  });

  // Slack counts API volume per session, not per client object, so two clients
  // must not be able to double the rate by each holding their own limiter.
  // This leans on the process-wide `slackRateLimiter`, which other tests in this
  // file also touch. Safe because it asserts the gap between its own two calls:
  // whatever advanced the singleton's clock earlier cannot shrink that gap.
  it('shares one limiter across clients when none is injected', async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (_input, _init) => {
      starts.push(Date.now());
      return Response.json({ ok: true, user: { id: 'U1' } });
    }) as typeof fetch;

    const config = {
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    } as const;

    const first = new SlackClient({ ...config });
    const second = new SlackClient({ ...config });

    await Promise.all([first.getUserInfo('U1'), second.getUserInfo('U2')]);

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(SLACK_MIN_REQUEST_INTERVAL_MS - 5);
  });

  it('releases the slot when a request fails, so later calls still run', async () => {
    let call = 0;
    globalThis.fetch = (async (_input, _init) => {
      call += 1;
      if (call === 1) throw new Error('network down');
      return Response.json({ ok: true, user: { id: 'U2' } });
    }) as typeof fetch;

    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    }, { rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }), retry: { maxRetries: 0 } });

    await expect(client.getUserInfo('U1')).rejects.toThrow('network down');
    await expect(client.getUserInfo('U2')).resolves.toMatchObject({ ok: true });
  });
});

describe('SlackClient request logging', () => {
  const browserConfig = {
    workspace_id: 'T123',
    workspace_name: 'Test Workspace',
    auth_type: 'browser',
    xoxd_token: 'xoxd-AbCdEf%2FGhIjKl%3D%3D',
    xoxc_token: 'xoxc-1234567890-1234567890-abcdef0123456789',
    workspace_url: 'https://example.slack.com',
  } as const;
  const noPacing = () => new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });

  let logDir: string;

  afterEach(async () => {
    resetSync();
    await rm(logDir, { recursive: true, force: true });
  });

  async function logTo(): Promise<string> {
    logDir = await mkdtemp(join(tmpdir(), 'slackcli-client-log-'));
    return configureLogging({ level: 'trace', verbose: false, dir: logDir }).logFile!;
  }

  function records(file: string): Array<Record<string, any>> {
    return readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  }

  it('logs a failing browser call with its Slack error and HTTP status, and no credential', async () => {
    const file = await logTo();
    globalThis.fetch = (async (_input, _init) => Response.json({ ok: false, error: 'channel_not_found' })) as typeof fetch;

    const client = new SlackClient({ ...browserConfig }, { rateLimiter: noPacing() });
    await expect(client.postMessage('C123', 'confidential message text')).rejects.toThrow('channel_not_found');

    const text = readFileSync(file, 'utf-8');
    expect(text).not.toContain('xoxc-');
    expect(text).not.toContain('xoxd-');
    expect(text).not.toContain('AbCdEf');
    expect(text).not.toContain('confidential message text');

    const failure = records(file).find((r) => r.level === 'WARN')!;
    expect(failure.properties).toMatchObject({
      method: 'chat.postMessage',
      auth_type: 'browser',
      ok: false,
      http_status: 200,
      slack_error: 'channel_not_found',
      reason: 'channel_not_found',
    });
    expect(typeof failure.properties.duration_ms).toBe('number');
  });

  it('logs the HTTP status of a non-2xx browser response', async () => {
    const file = await logTo();
    globalThis.fetch = (async (_input, _init) => new Response('slow down', { status: 429 })) as typeof fetch;

    const client = new SlackClient({ ...browserConfig }, { rateLimiter: noPacing(), retry: { maxRetries: 0 } });
    await expect(client.getUserInfo('U1')).rejects.toThrow('status: 429');

    const failure = records(file).find((r) => r.level === 'WARN')!;
    expect(failure.properties).toMatchObject({ method: 'users.info', http_status: 429, ok: false, reason: 'HTTP 429' });
    expect(failure.properties.slack_error).toBeUndefined();
    expect(failure.message).toBe('Slack API "users.info" failed: "HTTP 429"');
    expect(failure.message).not.toContain('undefined');
  });

  it('labels a transport failure with no HTTP status as a request error', async () => {
    const file = await logTo();
    globalThis.fetch = (async (_input, _init): Promise<Response> => {
      throw new TypeError('network down');
    }) as typeof fetch;

    const client = new SlackClient({ ...browserConfig }, { rateLimiter: noPacing(), retry: { maxRetries: 0 } });
    await expect(client.getUserInfo('U1')).rejects.toThrow('network down');

    const failure = records(file).find((r) => r.level === 'WARN')!;
    expect(failure.properties).toMatchObject({ method: 'users.info', ok: false, reason: 'request error' });
    expect(failure.properties.http_status).toBeUndefined();
    expect(failure.message).not.toContain('undefined');
  });

  it('logs a successful call at info with its duration, and only param names at trace', async () => {
    const file = await logTo();
    globalThis.fetch = (async (_input, _init) => Response.json({ ok: true, user: { id: 'U1' } })) as typeof fetch;

    const client = new SlackClient({ ...browserConfig }, { rateLimiter: noPacing() });
    await client.getUserInfo('U1');

    const all = records(file);
    const ok = all.find((r) => r.level === 'INFO')!;
    expect(ok.properties).toMatchObject({ method: 'users.info', auth_type: 'browser', ok: true, http_status: 200 });
    expect(typeof ok.properties.duration_ms).toBe('number');
    const trace = all.find((r) => r.level === 'TRACE')!;
    expect(trace.properties.param_names).toEqual(['user']);
    expect(JSON.stringify(trace)).not.toContain('"U1"');
  });

  it('logs the Slack error code of a failing standard-token call', async () => {
    const file = await logTo();
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-1234567890-abcdefghijkl',
      token_type: 'bot',
    }, { rateLimiter: noPacing() });
    (client as unknown as { webClient: { apiCall: () => Promise<unknown> } }).webClient = {
      apiCall: async () => {
        throw Object.assign(new Error('An API error occurred: not_authed'), { data: { ok: false, error: 'not_authed' } });
      },
    };

    await expect(client.testAuth()).rejects.toThrow('not_authed');

    const failure = records(file).find((r) => r.level === 'WARN')!;
    expect(failure.properties).toMatchObject({
      method: 'auth.test',
      auth_type: 'standard',
      ok: false,
      slack_error: 'not_authed',
    });
    expect(readFileSync(file, 'utf-8')).not.toContain('abcdefghijkl');
  });

  it('logs a file upload with its status, size and duration, but not the upload URL or file name', async () => {
    const file = await logTo();
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-upload-log-'));
    const filePath = join(dir, 'secret-plans.txt');
    await Bun.write(filePath, 'Quarterly report');
    globalThis.fetch = (async (_input, _init) => new Response('', { status: 200 })) as typeof fetch;

    try {
      await new TestSlackClient().uploadFileExternal('C123', filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const text = readFileSync(file, 'utf-8');
    expect(text).not.toContain('uploads.slack.test');
    expect(text).not.toContain('secret-plans');
    const upload = records(file).find((r) => r.message.startsWith('File upload'))!;
    expect(upload.properties).toMatchObject({ http_status: 200, bytes: 16 });
    expect(typeof upload.properties.duration_ms).toBe('number');
  });

  it('logs each file download hop by host only, never the path or file name', async () => {
    const file = await logTo();
    let call = 0;
    globalThis.fetch = (async (_input, _init) => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://downloads.slack-edge.com/F123/secret-plans.pdf?t=xyz' },
        });
      }
      return new Response('bytes', { status: 200 });
    }) as typeof fetch;

    await new TestSlackClient().fetchFile('https://files.slack.com/files-pri/T123-F123/secret-plans.pdf');

    const text = readFileSync(file, 'utf-8');
    expect(text).not.toContain('secret-plans');
    expect(text).not.toContain('files-pri');
    const hops = records(file).filter((r) => r.message.startsWith('File download'));
    expect(hops.map((r) => r.properties)).toEqual([
      expect.objectContaining({ host: 'files.slack.com', http_status: 302, redirects: 0 }),
      expect.objectContaining({ host: 'downloads.slack-edge.com', http_status: 200, redirects: 1 }),
    ]);
  });

  it('routes @slack/web-api warnings into the log but drops its debug output', async () => {
    const file = await logTo();
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-1234567890-abcdefghijkl',
      token_type: 'bot',
    });
    const sdkLogger = (client as unknown as { webClient: { logger: { debug: (m: string) => void; info: (m: string) => void } } })
      .webClient.logger;

    sdkLogger.debug('http request body: {"text":"private words"}');
    sdkLogger.info('API Call failed due to rate limiting. Will retry in 3 seconds.');

    const text = readFileSync(file, 'utf-8');
    expect(text).not.toContain('private words');
    const retry = records(file).find((r) => r.logger === 'slackcli.slack-web-api')!;
    expect(retry.properties.text).toContain('rate limiting');
  });
});

describe('SlackClient identity getters', () => {
  const standard = (token_type: 'bot' | 'user', user_id?: string) =>
    new SlackClient({
      workspace_id: 'T1',
      workspace_name: 'w',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type,
      ...(user_id ? { user_id } : {}),
    });

  it('exposes the stored user_id, or undefined on a legacy record', () => {
    expect(standard('user', 'U_ME').storedUserId).toBe('U_ME');
    expect(standard('user').storedUserId).toBeUndefined();
  });

  it('reports a bot token only for standard auth with token_type bot', () => {
    expect(standard('bot').isBotToken).toBe(true);
    expect(standard('user').isBotToken).toBe(false);
    const browser = new SlackClient({
      workspace_id: 'T1',
      workspace_name: 'w',
      workspace_url: 'https://w.slack.com',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      user_id: 'U_ME',
    });
    expect(browser.isBotToken).toBe(false);
    expect(browser.storedUserId).toBe('U_ME');
  });
});

describe('SlackClient dry-run helpers (#328)', () => {
  const standard = (profile?: string) => new SlackClient({
    workspace_id: 'T1',
    workspace_name: 'Acme Corp',
    auth_type: 'standard',
    token: 'xoxb-test',
    token_type: 'bot',
    ...(profile ? { profile } : {}),
  });
  const browser = new SlackClient({
    workspace_id: 'T2',
    workspace_name: 'Acme Browser',
    workspace_url: 'https://acme.slack.com',
    auth_type: 'browser',
    xoxd_token: 'xoxd-test',
    xoxc_token: 'xoxc-test',
    profile: 'work',
  });

  it('names the workspace and profile, falling back to the workspace ID, and never a token', () => {
    expect(standard('acme').workspaceIdentity).toEqual({ name: 'Acme Corp', id: 'T1', profile: 'acme' });
    expect(standard().workspaceIdentity).toEqual({ name: 'Acme Corp', id: 'T1', profile: 'T1' });
    expect(browser.workspaceIdentity).toEqual({ name: 'Acme Browser', id: 'T2', profile: 'work' });
    expect(JSON.stringify(browser.workspaceIdentity)).not.toContain('xox');
  });

  it('refuses a browser-only call on an app token with the error the call itself throws', async () => {
    expect(() => standard().requireBrowserAuth(DRAFT_CREATE_AUTH_MESSAGE)).toThrow(UnsupportedAuthTypeError);
    expect(() => standard().requireBrowserAuth(DRAFT_CREATE_AUTH_MESSAGE)).toThrow(DRAFT_CREATE_AUTH_MESSAGE);
    expect(() => browser.requireBrowserAuth(DRAFT_CREATE_AUTH_MESSAGE)).not.toThrow();
    // Same class and message as the real call, so a dry run fails identically.
    await expect(standard().createDraft('C1', 'hi')).rejects.toThrow(DRAFT_CREATE_AUTH_MESSAGE);
  });

  it('checks an upload file without calling Slack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-check-'));
    try {
      const filePath = join(dir, 'report.txt');
      await Bun.write(filePath, 'Quarterly report');
      expect(await checkUploadFile(filePath)).toEqual({ filename: 'report.txt', size: 16 });

      const empty = join(dir, 'empty.txt');
      await Bun.write(empty, '');
      await expect(checkUploadFile(empty)).rejects.toThrow(`Cannot upload empty file: ${empty}`);
      await expect(checkUploadFile(dir)).rejects.toThrow(`Cannot upload non-file path: ${dir}`);
      await expect(checkUploadFile(join(dir, 'missing.txt'))).rejects.toBeInstanceOf(InvalidInputError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SlackClient browser-auth retry', () => {
  const browserConfig = {
    workspace_id: 'T123',
    workspace_name: 'Test Workspace',
    auth_type: 'browser',
    xoxd_token: 'xoxd-test',
    xoxc_token: 'xoxc-test',
    workspace_url: 'https://example.slack.com',
  } as const;

  type Step = Response | Error | (() => Promise<Response>);

  // Replays `steps` one per fetch, recording the Slack method each hit.
  function scriptFetch(steps: Step[]): string[] {
    const methods: string[] = [];
    globalThis.fetch = (async (input, _init) => {
      methods.push(String(input).split('/api/')[1]!);
      const step = steps.shift();
      if (!step) throw new Error('fetch called more often than scripted');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    }) as typeof fetch;
    return methods;
  }

  const tooMany = (retryAfter?: string) =>
    new Response('slow down', { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });

  // Records every wait instead of sleeping.
  function client(options: { retry?: Record<string, number>; limiter?: RateLimiter } = {}) {
    const waits: number[] = [];
    const c = new SlackClient({ ...browserConfig }, {
      rateLimiter: options.limiter ?? new RateLimiter({ maxConcurrent: 2, minIntervalMs: 0 }),
      sleep: async (ms) => { waits.push(ms); },
      retry: { random: () => 0.5, ...options.retry },
    });
    return { c, waits };
  }

  it('retries a read after a 429, waiting Retry-After seconds', async () => {
    const methods = scriptFetch([tooMany('7'), Response.json({ ok: true, messages: [] })]);
    const { c, waits } = client();

    await expect(c.getConversationHistory('C123')).resolves.toMatchObject({ ok: true });
    expect(methods).toEqual(['conversations.history', 'conversations.history']);
    expect(waits).toEqual([7000]);
  });

  it('retries a write after a 429 — Slack rejected it, so it cannot post twice', async () => {
    const methods = scriptFetch([tooMany('2'), Response.json({ ok: true, ts: '1.2' })]);
    const { c, waits } = client();

    await expect(c.postMessage('C123', 'hello')).resolves.toMatchObject({ ok: true });
    expect(methods).toEqual(['chat.postMessage', 'chat.postMessage']);
    expect(waits).toEqual([2000]);
  });

  it('still retries a 429 whose body stream errors mid-read', async () => {
    const brokenBody = () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('ECONNRESET mid-body')); },
    }), { status: 429, headers: { 'Retry-After': '1' } });
    const methods = scriptFetch([brokenBody(), brokenBody()]);
    const { c, waits } = client({ retry: { maxRetries: 1 } });

    const error = await c.testAuth().catch((e) => e);
    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.message).toBe('Slack API error: HTTP error! status: 429');
    expect(methods).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it('backs off exponentially on a 429 with no or an unusable Retry-After, never 0', async () => {
    scriptFetch([tooMany(), tooMany('0'), tooMany('Wed, 21 Oct 2015 07:28:00 GMT'), Response.json({ ok: true })]);
    const { c, waits } = client();

    await expect(c.testAuth()).resolves.toMatchObject({ ok: true });
    // base 1000ms doubling, at 75% with random() = 0.5
    expect(waits).toEqual([750, 1500, 3000]);
  });

  it('caps a single wait at maxWaitMs', async () => {
    scriptFetch([tooMany('3600'), Response.json({ ok: true })]);
    const { c, waits } = client();

    await c.testAuth();
    expect(waits).toEqual([60_000]);
  });

  it('gives up after maxRetries and throws the last error unchanged', async () => {
    const methods = scriptFetch([tooMany('1'), tooMany('1'), tooMany('1'), tooMany('1'), tooMany('1')]);
    const { c, waits } = client();

    const error = await c.testAuth().catch((e) => e);
    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.message).toBe('Slack API error: HTTP error! status: 429');
    expect(error.httpStatus).toBe(429);
    expect(methods).toHaveLength(4);
    expect(waits).toEqual([1000, 1000, 1000]);
  });

  it('stops before a wait would overrun maxTotalWaitMs', async () => {
    const methods = scriptFetch([tooMany('50'), tooMany('50'), tooMany('50'), Response.json({ ok: true })]);
    const { c, waits } = client();

    await expect(c.testAuth()).rejects.toThrow('status: 429');
    // 50s + 50s fits in 120s; a third 50s would not.
    expect(waits).toEqual([50_000, 50_000]);
    expect(methods).toHaveLength(3);
  });

  it('retries a read on a 5xx with backoff', async () => {
    const methods = scriptFetch([new Response('oops', { status: 503 }), Response.json({ ok: true, user: { id: 'U1' } })]);
    const { c, waits } = client();

    await expect(c.getUserInfo('U1')).resolves.toMatchObject({ ok: true });
    expect(methods).toHaveLength(2);
    expect(waits).toEqual([750]);
  });

  it('retries a read on a network error', async () => {
    const methods = scriptFetch([new TypeError('network down'), Response.json({ ok: true, user: { id: 'U1' } })]);
    const { c } = client();

    await expect(c.getUserInfo('U1')).resolves.toMatchObject({ ok: true });
    expect(methods).toHaveLength(2);
  });

  it('never retries a write on a 5xx — it may already have been applied', async () => {
    const methods = scriptFetch([new Response('oops', { status: 502 }), Response.json({ ok: true })]);
    const { c, waits } = client();

    await expect(c.postMessage('C123', 'hello')).rejects.toThrow('status: 502');
    expect(methods).toEqual(['chat.postMessage']);
    expect(waits).toEqual([]);
  });

  it('never retries a write on a network error', async () => {
    const methods = scriptFetch([new TypeError('network down'), Response.json({ ok: true })]);
    const { c, waits } = client();

    await expect(c.postMessage('C123', 'hello')).rejects.toThrow('Slack API error: network down');
    expect(methods).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('never retries a Slack ok:false error, and keeps its slackData', async () => {
    const methods = scriptFetch([Response.json({ ok: false, error: 'ratelimited' }), Response.json({ ok: true })]);
    const { c, waits } = client();

    const error = await c.getUserInfo('U1').catch((e) => e);
    expect(error.message).toBe('Slack API error: ratelimited');
    expect(error.slackData).toEqual({ ok: false, error: 'ratelimited' });
    expect(methods).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('does not retry an unparseable 200 body', async () => {
    const methods = scriptFetch([new Response('<html>', { status: 200 }), Response.json({ ok: true })]);
    const { c } = client();

    await expect(c.getUserInfo('U1')).rejects.toThrow('Slack API error:');
    expect(methods).toHaveLength(1);
  });

  it('leaves standard-token calls to @slack/web-api', async () => {
    const waits: number[] = [];
    const c = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'standard',
      token: 'xoxb-test',
      token_type: 'bot',
    }, {
      rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }),
      sleep: async (ms) => { waits.push(ms); },
    });
    let calls = 0;
    (c as unknown as { webClient: { apiCall: () => Promise<unknown> } }).webClient = {
      apiCall: async () => {
        calls += 1;
        throw Object.assign(new Error('An HTTP protocol error occurred: statusCode = 503'), { statusCode: 503 });
      },
    };

    await expect(c.getUserInfo('U1')).rejects.toThrow('statusCode = 503');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('releases its limiter slot while waiting, so other calls keep flowing', async () => {
    const order: string[] = [];
    let fetchedU1 = 0;
    globalThis.fetch = (async (_input, init) => {
      const user = new URLSearchParams(String(init?.body)).get('user');
      order.push(`fetch ${user}`);
      if (user === 'U1' && ++fetchedU1 === 1) return tooMany('30');
      return Response.json({ ok: true, user: { id: user } });
    }) as typeof fetch;

    let releaseWait!: () => void;
    let waitStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { waitStarted = resolve; });
    const c = new SlackClient({ ...browserConfig }, {
      rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }),
      sleep: () => new Promise<void>((resolve) => {
        order.push('wait');
        releaseWait = resolve;
        waitStarted();
      }),
    });

    const first = c.getUserInfo('U1');
    await waiting;
    // Issued only once U1 is sitting out its Retry-After. Had U1 kept the only
    // slot through the wait, this call could not start until the wait ended.
    const second = c.getUserInfo('U2');
    const outcome = await Promise.race([
      second.then(() => 'U2 done'),
      new Promise((resolve) => setTimeout(() => resolve('U2 blocked'), 500)),
    ]);
    expect(outcome).toBe('U2 done');
    releaseWait();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(['fetch U1', 'wait', 'fetch U2', 'fetch U1']);
  });
});

describe('SlackClient retry logging', () => {
  let logDir: string;

  afterEach(async () => {
    resetSync();
    await rm(logDir, { recursive: true, force: true });
  });

  it('logs each retry with method, attempt, wait and status, and no params', async () => {
    logDir = await mkdtemp(join(tmpdir(), 'slackcli-retry-log-'));
    const file = configureLogging({ level: 'trace', verbose: false, dir: logDir }).logFile!;
    let call = 0;
    globalThis.fetch = (async (_input, _init) => {
      call += 1;
      return call === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } })
        : Response.json({ ok: true, ts: '1.2' });
    }) as typeof fetch;

    const c = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    }, { rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }), sleep: async () => {} });
    await c.postMessage('C123', 'confidential message text');

    const text = readFileSync(file, 'utf-8');
    expect(text).not.toContain('confidential message text');
    const all = text.trim().split('\n').map((line) => JSON.parse(line));
    const retry = all.find((r) => r.message.includes('retrying'))!;
    expect(Object.keys(retry.properties)).not.toContain('text');
    expect(retry.properties).toMatchObject({
      method: 'chat.postMessage',
      auth_type: 'browser',
      attempt: 1,
      wait_ms: 3000,
      http_status: 429,
    });
    const ok = all.find((r) => r.level === 'INFO' && r.properties.ok === true)!;
    expect(ok.properties.attempt).toBe(2);
  });
});

// Slack refusing the credentials must read the same whichever transport the
// profile uses: the profile, Slack's code, what it means and how to fix it.
describe('SlackClient authentication failures', () => {
  const noPacing = () => new RateLimiter({ minIntervalMs: 0, maxConcurrent: 8 });

  function browserClient(overrides: Record<string, unknown> = {}): SlackClient {
    return new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Acme Corp',
      auth_type: 'browser',
      xoxd_token: 'xoxd-secretcookie',
      xoxc_token: 'xoxc-secrettoken',
      workspace_url: 'https://acme.slack.com',
      ...overrides,
    } as ConstructorParameters<typeof SlackClient>[0], { rateLimiter: noPacing(), retry: { maxRetries: 0 } });
  }

  function standardClient(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): SlackClient {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Acme Corp',
      auth_type: 'standard',
      token: 'xoxb-1234567890-secrettoken',
      token_type: 'bot',
      ...overrides,
    } as ConstructorParameters<typeof SlackClient>[0], { rateLimiter: noPacing() });
    (client as unknown as { webClient: { apiCall: () => Promise<unknown> } }).webClient = {
      apiCall: async () => {
        throw Object.assign(new Error(`An API error occurred: ${payload.error}`), { data: payload });
      },
    };
    return client;
  }

  function slackReplies(payload: Record<string, unknown>): { calls: number } {
    const seen = { calls: 0 };
    globalThis.fetch = (async () => {
      seen.calls += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
    return seen;
  }

  it.each([...AUTH_ERROR_CODES])('explains %s on the browser path', async (code) => {
    const payload = { ok: false, error: code };
    slackReplies(payload);

    const error = await browserClient().getUserInfo('U1').catch((err) => err);

    expect(error).toBeInstanceOf(SlackAuthError);
    expect(error.code).toBe(code);
    expect(error.slackData).toEqual(payload);
    const lines = error.message.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`Authentication failed for profile "T123" (Acme Corp, browser auth): ${code}`);
    expect(lines[1]).toBe(`   ${error.meaning}`);
    expect(lines[2]).toBe(`   To fix: ${error.fix}`);
  });

  it.each([...AUTH_ERROR_CODES])('explains %s on the standard path', async (code) => {
    const payload = { ok: false, error: code };

    const error = await standardClient(payload).getUserInfo('U1').catch((err) => err);

    expect(error).toBeInstanceOf(SlackAuthError);
    expect(error.code).toBe(code);
    expect(error.slackData).toEqual(payload);
    const lines = error.message.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`Authentication failed for profile "T123" (Acme Corp, standard auth): ${code}`);
    expect(lines[1]).toBe(`   ${error.meaning}`);
    expect(lines[2]).toBe(`   To fix: ${error.fix}`);
  });

  it('points a browser profile at login-auto with its stored URL', async () => {
    slackReplies({ ok: false, error: 'invalid_auth' });
    const error = await browserClient().testAuth().catch((err) => err);
    expect(error.fix).toBe('slackcli auth login-auto --workspace-url https://acme.slack.com');
  });

  it('points a standard profile at auth login', async () => {
    const error = await standardClient({ ok: false, error: 'invalid_auth' }).testAuth().catch((err) => err);
    expect(error.fix).toBe('slackcli auth login --token <token> --workspace-name <name>');
  });

  it('tells an inactive account that logging in again will not help, on both paths', async () => {
    const payload = { ok: false, error: 'account_inactive' };
    slackReplies(payload);
    const errors = [
      await browserClient().testAuth().catch((err) => err),
      await standardClient(payload).testAuth().catch((err) => err),
    ];
    for (const error of errors) {
      expect(error.message).toContain('To fix: logging in again will not help; contact a workspace admin.');
      expect(error.message).not.toContain('slackcli auth login');
    }
  });

  it('names the profile by its profile name when it has one', async () => {
    slackReplies({ ok: false, error: 'token_revoked' });
    const fromBrowser = await browserClient({ profile: 'acme-me' }).testAuth().catch((err) => err);
    const fromStandard = await standardClient({ ok: false, error: 'token_revoked' }, { profile: 'acme-bot' })
      .testAuth().catch((err) => err);
    expect(fromBrowser.message).toStartWith('Authentication failed for profile "acme-me" (Acme Corp, browser auth): token_revoked');
    expect(fromStandard.message).toStartWith('Authentication failed for profile "acme-bot" (Acme Corp, standard auth): token_revoked');
  });

  it('never puts a credential in the message', async () => {
    slackReplies({ ok: false, error: 'invalid_auth' });
    const errors = [
      await browserClient().testAuth().catch((err) => err),
      await standardClient({ ok: false, error: 'invalid_auth' }).testAuth().catch((err) => err),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('xox');
    }
  });

  it('does not retry an authentication failure', async () => {
    const seen = slackReplies({ ok: false, error: 'invalid_auth' });
    const waits: number[] = [];
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Acme Corp',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://acme.slack.com',
    }, { rateLimiter: noPacing(), sleep: async (ms) => { waits.push(ms); } });

    await expect(client.getUserInfo('U1')).rejects.toBeInstanceOf(SlackAuthError);
    expect(seen.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it.each(['channel_not_found', 'enterprise_is_restricted', 'missing_scope'])(
    'leaves the non-auth code %s unchanged on both paths',
    async (code) => {
      const payload = { ok: false, error: code };
      slackReplies(payload);
      const errors = [
        await browserClient().getUserInfo('U1').catch((err) => err),
        await standardClient(payload).getUserInfo('U1').catch((err) => err),
      ];
      expect(errors[0].message).toBe(`Slack API error: ${code}`);
      expect(errors[1].message).toBe(`Slack API error: An API error occurred: ${code}`);
      for (const error of errors) {
        expect(error).not.toBeInstanceOf(SlackAuthError);
        expect(error.slackData).toEqual(payload);
      }
    },
  );

  it('still lets leaveConversation read not_in_channel from an ok:false payload with no error code', async () => {
    slackReplies({ ok: false, not_in_channel: true });
    expect(await browserClient().leaveConversation('C1')).toEqual({ ok: false, not_in_channel: true });
  });
});

// `auth whoami` has to tell "Slack could not be reached" from "Slack refused"
// on both auth types, so the SDK's transport failures carry the same type the
// browser path throws.
describe('SlackClient standard-path transport failures', () => {
  const noPacing = () => new RateLimiter({ minIntervalMs: 0, maxConcurrent: 8 });
  const config = {
    workspace_id: 'T123',
    workspace_name: 'Acme Corp',
    auth_type: 'standard',
    token: 'xoxb-test',
    token_type: 'bot',
  } as const;

  function failingWith(sdkError: Error): SlackClient {
    const client = new SlackClient(config, { rateLimiter: noPacing() });
    (client as unknown as { webClient: { apiCall: () => Promise<unknown> } }).webClient = {
      apiCall: async () => { throw sdkError; },
    };
    return client;
  }

  it('reports a request that got no response as a network transport error', async () => {
    const sdkError = Object.assign(new Error('A request error occurred: ECONNREFUSED'), {
      code: 'slack_webapi_request_error',
    });
    const error = await failingWith(sdkError).testAuth().catch((err) => err);
    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.networkError).toBe(true);
    expect(error.httpStatus).toBeUndefined();
    expect(error.message).toBe('Slack API error: A request error occurred: ECONNREFUSED');
  });

  it('reports a non-2xx response as a transport error with its status', async () => {
    const sdkError = Object.assign(new Error('An HTTP protocol error occurred: statusCode = 503'), {
      code: 'slack_webapi_http_error',
      statusCode: 503,
    });
    const error = await failingWith(sdkError).testAuth().catch((err) => err);
    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.networkError).toBe(false);
    expect(error.httpStatus).toBe(503);
  });

  it('reports a rate-limited call as a transport error with status 429 and the wait', async () => {
    const sdkError = Object.assign(new Error('A rate-limit has been reached, you may retry this request in 30 seconds'), {
      code: 'slack_webapi_rate_limited_error',
      retryAfter: 30,
    });
    const error = await failingWith(sdkError).testAuth().catch((err) => err);
    expect(error).toBeInstanceOf(SlackTransportError);
    expect(error.httpStatus).toBe(429);
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.networkError).toBe(false);
  });

  it('leaves a Slack ok:false answer as a plain error carrying the payload', async () => {
    const payload = { ok: false, error: 'missing_scope' };
    const sdkError = Object.assign(new Error('An API error occurred: missing_scope'), {
      code: 'slack_webapi_platform_error',
      data: payload,
    });
    const error = await failingWith(sdkError).testAuth().catch((err) => err);
    expect(error).not.toBeInstanceOf(SlackTransportError);
    expect(error.slackData).toEqual(payload);
  });

  it('still reports refused credentials as a SlackAuthError', async () => {
    const sdkError = Object.assign(new Error('An API error occurred: invalid_auth'), {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'invalid_auth' },
    });
    await expect(failingWith(sdkError).testAuth()).rejects.toBeInstanceOf(SlackAuthError);
  });

  type SdkInternals = { retryConfig: { retries?: number }; rejectRateLimitedCalls: boolean };
  const sdk = (client: SlackClient) => (client as unknown as { webClient: SdkInternals }).webClient;
  const sdkRetryConfig = (client: SlackClient) => sdk(client).retryConfig;

  it('fails a 429 at once only when the SDK retries are capped', () => {
    expect(sdk(new SlackClient(config, { sdkRetries: 3 })).rejectRateLimitedCalls).toBe(true);
    // Every other command keeps the SDK's wait-and-retry on a 429.
    expect(sdk(new SlackClient(config)).rejectRateLimitedCalls).toBe(false);
  });

  it('caps the SDK retries only when asked to', () => {
    expect(sdkRetryConfig(new SlackClient(config, { sdkRetries: 3 }))).toEqual({ retries: 3 });
    expect(sdkRetryConfig(new SlackClient(config, { sdkRetries: 0 }))).toEqual({ retries: 0 });
    // The SDK default (ten retries) stays in place for every other command.
    expect(sdkRetryConfig(new SlackClient(config)).retries).toBe(10);
  });
});

describe('SlackClient.lookupUserByEmail', () => {
  it('calls users.lookupByEmail with the address, through request()', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });
    const request = spyOn(client, 'request').mockResolvedValue({ ok: true, user: { id: 'U1' } });

    await expect(client.lookupUserByEmail('alice@example.com')).resolves.toEqual({ ok: true, user: { id: 'U1' } });
    expect(request).toHaveBeenCalledWith('users.lookupByEmail', { email: 'alice@example.com' });
  });

  it('is a read method, so a 5xx or network failure is retried', () => {
    expect(isReadMethod('users.lookupByEmail')).toBe(true);
  });
});
