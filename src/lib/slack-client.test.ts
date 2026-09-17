import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlackClient } from './slack-client.ts';
import { RateLimiter, SLACK_MIN_REQUEST_INTERVAL_MS } from './rate-limiter.ts';

class TestSlackClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

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
      return {
        ok: true,
        upload_url: 'https://uploads.slack.test/file',
        file_id: 'F123',
      };
    }

    if (method === 'files.completeUploadExternal') {
      return {
        ok: true,
        files: [{ id: 'F123' }],
      };
    }

    if (method === 'chat.update') {
      return { ok: true, channel: params.channel, ts: params.ts, text: params.text };
    }

    if (method === 'chat.postMessage') {
      return { ok: true, channel: params.channel, ts: '1234567890.123456' };
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
            files: JSON.stringify([{ id: 'F123', title: 'report.txt' }]),
            channel_id: 'C123',
            initial_comment: 'Here is the file',
          },
        },
      ]);
      expect(uploadRequest).toEqual({
        url: 'https://uploads.slack.test/file',
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
    }, { rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }) });

    await expect(client.getUserInfo('U1')).rejects.toThrow('network down');
    await expect(client.getUserInfo('U2')).resolves.toMatchObject({ ok: true });
  });
});
