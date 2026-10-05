// `messages delete` end to end in process, with the Slack client stubbed: the
// confirmation gate, the --json shape, and the idempotent message_not_found
// path that lets a cleanup job retry safely.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { createMessagesCommand } from './messages.ts';

const TS = '1712345678.000100';

function client(deleteMessage: (channel: string, ts: string) => Promise<unknown>) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    stub: {
      workspaceHost: 'acme.slack.com',
      deleteMessage: (channel: string, ts: string) => {
        calls.push([channel, ts]);
        return deleteMessage(channel, ts);
      },
    },
  };
}

function refusal(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

describe('messages delete', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(stub: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);
    await createMessagesCommand().parseAsync(['delete', ...argv], { from: 'user' });
  }

  it('deletes the message and prints { channel_id, ts, deleted: true, already_deleted: false }', async () => {
    const { stub, calls } = client(async (channel, ts) => ({ ok: true, channel, ts }));

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['C0123456789', TS]]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, deleted: true, already_deleted: false });
  });

  it('takes the channel and timestamp from --permalink', async () => {
    const { stub, calls } = client(async (channel, ts) => ({ ok: true, channel, ts }));

    await run(stub, ['--permalink', 'https://acme.slack.com/archives/C0123456789/p1712345678000100', '--yes', '--json']);

    expect(calls).toEqual([['C0123456789', TS]]);
    expect(JSON.parse(stdout).ts).toBe(TS);
  });

  it('reports a message that is already gone as success, exit 0', async () => {
    const { stub } = client(async () => { throw refusal('message_not_found'); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, deleted: false, already_deleted: true });
    expect(stderr).not.toContain('"error"');
  });

  it('says "not found, may already be deleted" in text mode, never that it deleted', async () => {
    const { stub } = client(async () => { throw refusal('message_not_found'); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--yes']);

    expect(process.exitCode).toBe(0);
    expect(stdout + stderr).toContain('not found');
    expect(stdout + stderr).toContain('may already be deleted');
    expect(stdout + stderr).not.toContain('Message deleted');
  });

  it('keeps the workspace-mismatch warning off stdout under --json', async () => {
    const { stub, calls } = client(async (channel, ts) => ({ ok: true, channel, ts }));

    await run(stub, ['--permalink', 'https://other.slack.com/archives/C0123456789/p1712345678000100', '--yes', '--json']);

    expect(calls).toEqual([['C0123456789', TS]]);
    expect(stderr).toContain('belongs to the "other" workspace');
    expect(stdout).not.toContain('workspace');
    // All of stdout is the one JSON object.
    expect(JSON.parse(stdout)).toMatchObject({ channel_id: 'C0123456789', deleted: true });
  });

  it.each([
    ['cant_delete_message', 'permission_denied'],
    ['channel_not_found', 'not_found'],
  ])('fails %s with exit 1 and the Slack code', async (slackError, code) => {
    const { stub } = client(async () => { throw refusal(slackError); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--yes', '--json']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).error).toMatchObject({ code, slack_error: slackError });
  });

  it('refuses unattended without --yes and deletes nothing', async () => {
    const { stub, calls } = client(async (channel, ts) => ({ ok: true, channel, ts }));

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS]);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).toContain('Message was not deleted');
  });
});
