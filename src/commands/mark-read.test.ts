// `conversations mark-read` (#362), in process. The client is a real
// SlackClient whose transport is replaced, so every Slack call the command
// makes, and its order, is visible at the one seam all calls go through.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createConversationsCommand } from './conversations.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

const STANDARD: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  auth_type: 'standard',
  token: 'xoxp-fake',
  token_type: 'user',
};

const PERMALINK = 'https://acme.slack.com/archives/C0123456789/p1712345678123456';

type Call = [method: string, params: Record<string, unknown>];
type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

function slackError(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

const DEFAULT_ANSWERS: Answers = {
  'conversations.info': (params) => ({ ok: true, channel: { id: params.channel, name: 'general', last_read: '1712345600.000200' } }),
  'conversations.list': () => ({ ok: true, channels: [{ id: 'C0123456789', name: 'general' }] }),
  'conversations.mark': () => ({ ok: true }),
};

describe('conversations mark-read, in process', () => {
  const realIsTTY = process.stdin.isTTY;
  let calls: Call[];
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;
  let clientRequests: number;

  beforeEach(() => {
    calls = [];
    stdout = '';
    stderr = '';
    clientRequests = 0;
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

  async function run(args: string[], options: { config?: WorkspaceConfig; answers?: Answers } = {}): Promise<void> {
    const answers = { ...DEFAULT_ANSWERS, ...options.answers };
    const client = new SlackClient(options.config ?? BROWSER);
    spyOn(client, 'request').mockImplementation(async (method, params = {}) => {
      calls.push([method, params]);
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected Slack call ${method}`);
      return answer(params);
    });
    spyOn(authLib, 'getAuthenticatedClient').mockImplementation(async () => {
      clientRequests += 1;
      return client;
    });
    await createConversationsCommand().parseAsync(['mark-read', ...args], { from: 'user' });
  }

  const marks = () => calls.filter(([method]) => method === 'conversations.mark');

  // The failure a --json command reports: the last stderr line.
  function jsonError(): Record<string, unknown> {
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).error;
  }

  describe('the write', () => {
    it.each([
      ['browser auth', BROWSER],
      ['an app token', STANDARD],
    ])('marks once with <channel> and --ts on %s, and prints one JSON object', async (_name, config) => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes', '--json'], { config });

      expect(process.exitCode).toBe(0);
      expect(marks()).toEqual([['conversations.mark', { channel: 'C0123456789', ts: '1712345678.123456' }]]);
      expect(JSON.parse(stdout)).toEqual({
        channel_id: 'C0123456789',
        ts: '1712345678.123456',
        previous_last_read: '1712345600.000200',
      });
    });

    it('reads the cursor before it writes', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes', '--json']);

      expect(calls.map(([method]) => method)).toEqual(['conversations.info', 'conversations.mark']);
    });

    it('takes channel and ts from --permalink', async () => {
      await run(['--permalink', PERMALINK, '--yes', '--json']);

      expect(marks()).toEqual([['conversations.mark', { channel: 'C0123456789', ts: '1712345678.123456' }]]);
      expect(JSON.parse(stdout).ts).toBe('1712345678.123456');
    });

    it('marks up to the linked reply itself, not its thread parent, for a reply link', async () => {
      await run(['--permalink', `${PERMALINK}?thread_ts=1712340000.000100&cid=C0123456789`, '--yes', '--json']);

      expect(marks()).toEqual([['conversations.mark', { channel: 'C0123456789', ts: '1712345678.123456' }]]);
      expect(JSON.parse(stdout).ts).toBe('1712345678.123456');
    });

    it('accepts the p-prefixed timestamp form for --ts', async () => {
      await run(['C0123456789', '--ts', 'p1712345678123456', '--yes', '--json']);

      expect(marks()).toEqual([['conversations.mark', { channel: 'C0123456789', ts: '1712345678.123456' }]]);
    });

    it('accepts a channel link as <channel>', async () => {
      await run(['https://acme.slack.com/archives/C0123456789', '--ts', '1712345678.123456', '--yes', '--json']);

      expect(marks()).toEqual([['conversations.mark', { channel: 'C0123456789', ts: '1712345678.123456' }]]);
      expect(stderr).not.toContain('belongs to the');
    });

    it('accepts a DM ID', async () => {
      await run(['D0123456789', '--ts', '1712345678.123456', '--yes', '--json']);

      expect(marks()).toEqual([['conversations.mark', { channel: 'D0123456789', ts: '1712345678.123456' }]]);
      expect(JSON.parse(stdout).channel_id).toBe('D0123456789');
    });

    it('resolves a channel name to its ID, with one client', async () => {
      await run(['#general', '--ts', '1712345678.123456', '--yes', '--json']);

      expect(calls[0][0]).toBe('conversations.list');
      expect(marks()).toEqual([['conversations.mark', { channel: 'C0123456789', ts: '1712345678.123456' }]]);
      expect(clientRequests).toBe(1);
    });

    it('reports previous_last_read null when Slack returns no cursor', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes', '--json'], {
        answers: { 'conversations.info': (params) => ({ ok: true, channel: { id: params.channel } }) },
      });

      expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: '1712345678.123456', previous_last_read: null });
    });

    it('still writes when the cursor read fails, and reports null', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes', '--json'], {
        answers: { 'conversations.info': () => { throw slackError('missing_scope'); } },
      });

      expect(process.exitCode).toBe(0);
      expect(marks()).toHaveLength(1);
      expect(JSON.parse(stdout).previous_last_read).toBeNull();
    });

    it('prints the previous cursor on stderr and nothing on stdout without --json', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes']);

      expect(process.exitCode).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('Marked C0123456789 as read up to 1712345678.123456 (previous read cursor: 1712345600.000200)');
    });

    it('says so in text when Slack reported no previous cursor', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes'], {
        answers: { 'conversations.info': (params) => ({ ok: true, channel: { id: params.channel } }) },
      });

      expect(stderr).toContain('(previous read cursor: not reported by Slack)');
    });

    it('warns when a pasted link names another workspace, and still writes', async () => {
      await run(['--permalink', 'https://other.slack.com/archives/C0123456789/p1712345678123456', '--yes', '--json']);

      expect(stderr).toContain('belongs to the "other" workspace');
      expect(marks()).toHaveLength(1);
    });

    it('reports a Slack failure of the write as a structured error', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes', '--json'], {
        answers: { 'conversations.mark': () => { throw slackError('invalid_timestamp'); } },
      });

      expect(jsonError()).toMatchObject({ code: 'invalid_input', slack_error: 'invalid_timestamp' });
    });

    it('reports a missing write scope as permission_denied', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--yes', '--json'], {
        config: STANDARD,
        answers: { 'conversations.mark': () => { throw slackError('missing_scope'); } },
      });

      expect(jsonError()).toMatchObject({ code: 'permission_denied', slack_error: 'missing_scope' });
    });
  });

  describe('input that is refused before any Slack call', () => {
    it.each([
      ['--permalink with <channel>', ['C0123456789', '--permalink', PERMALINK]],
      ['--permalink with --ts', ['--permalink', PERMALINK, '--ts', '1712345678.123456']],
      ['--permalink with both', ['C0123456789', '--ts', '1712345678.123456', '--permalink', PERMALINK]],
      ['a channel with neither --ts nor --permalink', ['C0123456789']],
      ['--ts without a channel', ['--ts', '1712345678.123456']],
      ['nothing at all', []],
      ['a --ts that is not a timestamp', ['C0123456789', '--ts', 'yesterday']],
      ['a --permalink that names no message', ['--permalink', 'https://acme.slack.com/archives/C0123456789']],
    ])('%s fails with invalid_input', async (_name, args) => {
      await run([...args, '--yes', '--json']);

      expect(jsonError().code).toBe('invalid_input');
      expect(calls).toEqual([]);
      expect(clientRequests).toBe(0);
    });

    it('fails with not_found for an unknown channel name, without writing', async () => {
      await run(['#nope', '--ts', '1712345678.123456', '--yes', '--json']);

      expect(jsonError().code).toBe('not_found');
      expect(marks()).toEqual([]);
    });
  });

  describe('confirmation', () => {
    it('refuses without --yes when stdin is not a terminal, and makes no Slack call', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--json']);

      expect(jsonError().code).toBe('confirmation_required');
      expect(calls).toEqual([]);
    });

    it('refuses in text mode too, with exit code 1', async () => {
      await run(['--permalink', PERMALINK]);

      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('--yes');
      expect(calls).toEqual([]);
    });
  });

  describe('--dry-run', () => {
    it('previews channel, name, ts and previous_last_read without writing or --yes', async () => {
      await run(['C0123456789', '--ts', '1712345678.123456', '--dry-run', '--json']);

      expect(process.exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        dry_run: true,
        action: 'mark conversation read',
        workspace: { name: 'Acme Corp', id: 'T0123456789', profile: 'acme' },
        target: { kind: 'channel', id: 'C0123456789', name: '#general' },
        payload: { ts: '1712345678.123456', previous_last_read: '1712345600.000200' },
      });
      expect(marks()).toEqual([]);
      expect(stderr).not.toContain('[y/N]');
    });

    it('keeps a null previous_last_read in the preview', async () => {
      await run(['--permalink', PERMALINK, '--dry-run', '--json'], {
        answers: { 'conversations.info': (params) => ({ ok: true, channel: { id: params.channel, name: 'general' } }) },
      });

      expect(JSON.parse(stdout).payload).toEqual({ ts: '1712345678.123456', previous_last_read: null });
      expect(marks()).toEqual([]);
    });

    it('prints a text preview and makes no write', async () => {
      await run(['#general', '--ts', '1712345678.123456', '--dry-run']);

      expect(process.exitCode).toBe(0);
      expect(stdout).toContain('Dry run: nothing was sent.');
      expect(stdout).toContain('mark conversation read');
      expect(stdout).toContain('C0123456789 (#general)');
      expect(stdout).toContain('1712345600.000200');
      expect(marks()).toEqual([]);
    });

    it('still validates: conflicting input fails the dry run', async () => {
      await run(['C0123456789', '--permalink', PERMALINK, '--dry-run', '--json']);

      expect(jsonError().code).toBe('invalid_input');
      expect(calls).toEqual([]);
    });
  });
});
