import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlackClient } from './slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';

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

const browserConfig: WorkspaceConfig = {
  workspace_id: 'T1',
  workspace_name: 'browser-ws',
  workspace_url: 'https://example.slack.com',
  auth_type: 'browser',
  xoxc_token: 'xoxc-test',
  xoxd_token: 'xoxd-test',
};

const standardConfig: WorkspaceConfig = {
  workspace_id: 'T2',
  workspace_name: 'std-ws',
  auth_type: 'standard',
  token: 'xoxb-test',
  token_type: 'bot',
};

// Helper: create a SlackClient and stub out `request` to capture calls.
function createBrowserClient(stubResponse: any = { ok: true }): {
  client: SlackClient;
  calls: Array<{ method: string; params: Record<string, any> }>;
} {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const client = new SlackClient(browserConfig);
  (client as any).request = async (method: string, params: Record<string, any>) => {
    calls.push({ method, params });
    return stubResponse;
  };
  return { client, calls };
}

describe('SlackClient.executeSlashCommand', () => {
  it('throws on standard auth', async () => {
    const client = new SlackClient(standardConfig);
    await expect(
      client.executeSlashCommand('C123', '/genie', 'help'),
    ).rejects.toThrow('requires browser authentication');
  });

  it('calls chat.command with required params', async () => {
    const { client, calls } = createBrowserClient();
    await client.executeSlashCommand('C123', '/genie', 'help', 'fixed-token');

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('chat.command');
    expect(calls[0].params).toEqual({
      channel: 'C123',
      command: '/genie',
      text: 'help',
      disp: '/genie',
      client_token: 'fixed-token',
    });
  });

  it('defaults text to empty string', async () => {
    const { client, calls } = createBrowserClient();
    await client.executeSlashCommand('C123', '/genie', undefined as any, 'tok');
    expect(calls[0].params.text).toBe('');
  });

  it('generates a UUID-shaped client_token when none supplied', async () => {
    const { client, calls } = createBrowserClient();
    await client.executeSlashCommand('C123', '/genie', '');
    const ct = calls[0].params.client_token;
    expect(typeof ct).toBe('string');
    // RFC 4122-ish: 8-4-4-4-12 hex
    expect(ct).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('returns the underlying request response unchanged', async () => {
    const { client } = createBrowserClient({ ok: true, response: { text: 'hi' } });
    const resp = await client.executeSlashCommand('C123', '/genie', '', 't');
    expect(resp).toEqual({ ok: true, response: { text: 'hi' } });
  });
});

describe('SlackClient.rtmConnect', () => {
  it('throws on standard auth', async () => {
    const client = new SlackClient(standardConfig);
    await expect(client.rtmConnect()).rejects.toThrow('rtm.connect');
  });

  it('builds wss url containing the xoxc token', async () => {
    const { client } = createBrowserClient({
      ok: true,
      user_id: 'U999',
      user: 'me',
    });
    const resp = await client.rtmConnect();
    expect(resp.url.startsWith('wss://wss-primary.slack.com/?token=')).toBe(true);
    expect(resp.url).toContain(encodeURIComponent('xoxc-test'));
  });

  it('returns headers with Cookie carrying the xoxd token', async () => {
    const { client } = createBrowserClient({ ok: true, user_id: 'U1', user: 'me' });
    const resp = await client.rtmConnect();
    expect(resp.headers.Cookie).toBe(`d=${encodeURIComponent('xoxd-test')}`);
    expect(resp.headers.Origin).toBe('https://app.slack.com');
  });

  it('extracts self from auth.test response', async () => {
    const { client } = createBrowserClient({ ok: true, user_id: 'U777', user: 'eduard' });
    const resp = await client.rtmConnect();
    expect(resp.self).toEqual({ id: 'U777', name: 'eduard' });
  });

  it('calls auth.test (not rtm.connect) under the hood', async () => {
    const { client, calls } = createBrowserClient({ ok: true, user_id: 'U1', user: 'me' });
    await client.rtmConnect();
    const methods = calls.map(c => c.method);
    expect(methods).toContain('auth.test');
    expect(methods).not.toContain('rtm.connect');
  });
});
