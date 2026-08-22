import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlackClient } from './slack-client.ts';

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
