// Pins the real-send output of `messages send`: the Slack call each path makes
// (text post, one or several files, a --users group DM) and what it prints, as
// text and under --json. The dry-run, conflict and parse paths are covered by
// dry-run.test.ts, messages-users.test.ts and messages.test.ts; this file holds
// the delivered-message paths those leave out (#459).
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createMessagesCommand } from './messages.ts';

const STANDARD: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  auth_type: 'standard',
  token: 'xoxb-fake',
  token_type: 'bot',
};

interface Call {
  method: string;
  args: unknown[];
}

let stdout: string;
let stderr: string;
let calls: Call[];

// A client whose write methods record their arguments and answer like Slack.
// `files` is what files.completeUploadExternal reports back (undefined: none).
function fakeClient(files: Array<{ id: string }> | undefined, permalink?: string): SlackClient {
  const client = new SlackClient(STANDARD);
  spyOn(client, 'request').mockImplementation(async (method) => {
    throw new Error(`unexpected request ${method}`);
  });
  spyOn(client, 'postMessage').mockImplementation(async (...args: unknown[]) => {
    calls.push({ method: 'postMessage', args });
    return { ok: true, ts: '1712345678.000100' } as any;
  });
  spyOn(client, 'uploadFilesExternal').mockImplementation(async (...args: unknown[]) => {
    calls.push({ method: 'uploadFilesExternal', args });
    return { ok: true, files } as any;
  });
  spyOn(client, 'openConversation').mockImplementation(async (...args: unknown[]) => {
    calls.push({ method: 'openConversation', args });
    return { ok: true, channel: { id: 'G0123456789' } } as any;
  });
  spyOn(client, 'getPermalink').mockImplementation(async (...args: unknown[]) => {
    calls.push({ method: 'getPermalink', args });
    if (!permalink) throw new Error('missing_scope');
    return { ok: true, permalink } as any;
  });
  return client;
}

async function send(argv: string[], files?: Array<{ id: string }>, permalink?: string): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(fakeClient(files, permalink));
  await createMessagesCommand().parseAsync(['send', ...argv], { from: 'user' });
}

describe('messages send delivered-message output', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    calls = [];
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('posts text to a channel and prints the timestamp', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'hi', '--thread-ts', '1712345678.000001']);

    expect(process.exitCode).toBe(0);
    expect(calls).toStrictEqual([
      { method: 'postMessage', args: ['C0123456789', 'hi', { thread_ts: '1712345678.000001', blocks: undefined }] },
    ]);
    expect(stdout).toContain('Message timestamp: 1712345678.000100\n');
  });

  it('opens the DM of a user recipient before posting', async () => {
    await send(['--recipient-id', 'U0123456789', '--message', 'hi']);

    expect(calls.map((c) => c.method)).toStrictEqual(['openConversation', 'postMessage']);
    expect(calls[0].args).toStrictEqual(['U0123456789']);
    expect(calls[1].args[0]).toBe('G0123456789');
  });

  it('posts blocks and emits channel_id, ts and permalink under --json', async () => {
    await send(
      ['--recipient-id', 'C0123456789', '--message', 'hi', '--blocks', '[{"type":"divider"}]', '--json'],
      undefined,
      'https://acme.slack.com/archives/C0123456789/p1712345678000100',
    );

    expect(calls[0]).toStrictEqual({
      method: 'postMessage',
      args: ['C0123456789', 'hi', { thread_ts: undefined, blocks: [{ type: 'divider' }] }],
    });
    expect(stdout).toBe(
      JSON.stringify({
        channel_id: 'C0123456789',
        ts: '1712345678.000100',
        permalink: 'https://acme.slack.com/archives/C0123456789/p1712345678000100',
      }, null, 2) + '\n',
    );
  });

  it('omits the permalink key under --json when the lookup fails', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'hi', '--json']);

    expect(JSON.parse(stdout)).toStrictEqual({ channel_id: 'C0123456789', ts: '1712345678.000100' });
  });

  it('uploads one file with the message as its comment', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'see', '--file', 'a.png', '--thread-ts', '1712345678.000001'], [{ id: 'F1' }]);

    expect(calls).toStrictEqual([
      { method: 'uploadFilesExternal', args: ['C0123456789', ['a.png'], { initial_comment: 'see', thread_ts: '1712345678.000001' }] },
    ]);
    expect(stdout).toContain('File uploaded successfully\n');
  });

  it('counts the uploaded files in the text output', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'see', '--file', 'a.png', '--file', 'b.csv'], [{ id: 'F1' }, { id: 'F2' }]);

    expect(calls[0].args[1]).toStrictEqual(['a.png', 'b.csv']);
    expect(stdout).toContain('2 files uploaded successfully\n');
  });

  it('falls back to the --file count when Slack reports no files', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'see', '--file', 'a.png', '--file', 'b.csv'], undefined);

    expect(stdout).toContain('2 files uploaded successfully\n');
  });

  it('emits file_id and file_ids under --json for several files', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'see', '--file', 'a.png', '--file', 'b.csv', '--json'], [{ id: 'F1' }, { id: 'F2' }]);

    expect(stdout).toBe(
      JSON.stringify({ channel_id: 'C0123456789', file_id: 'F1', file_ids: ['F1', 'F2'] }, null, 2) + '\n',
    );
  });

  it('emits an empty file_ids and no file_id under --json when Slack reports no files', async () => {
    await send(['--recipient-id', 'C0123456789', '--message', 'see', '--file', 'a.png', '--json'], undefined);

    expect(JSON.parse(stdout)).toStrictEqual({ channel_id: 'C0123456789', file_ids: [] });
  });

  it('opens the group DM for --users and posts in its thread', async () => {
    await send(['--users', 'U1111111111,U2222222222', '--message', 'hi', '--thread-ts', '1712345678.000001', '--json']);

    expect(calls.map((c) => c.method)).toStrictEqual(['openConversation', 'postMessage', 'getPermalink']);
    expect(calls[0].args).toStrictEqual(['U1111111111,U2222222222']);
    expect(calls[1].args).toStrictEqual(['G0123456789', 'hi', { thread_ts: '1712345678.000001', blocks: undefined }]);
    expect(JSON.parse(stdout)).toStrictEqual({ channel_id: 'G0123456789', ts: '1712345678.000100' });
  });

  it('uploads files to the group DM for --users', async () => {
    await send(['--users', 'U1111111111', '--message', 'see', '--file', 'a.png'], [{ id: 'F1' }]);

    expect(calls.map((c) => c.method)).toStrictEqual(['openConversation', 'uploadFilesExternal']);
    expect(calls[1].args[0]).toBe('G0123456789');
    expect(stdout).toContain('File uploaded successfully\n');
  });
});
