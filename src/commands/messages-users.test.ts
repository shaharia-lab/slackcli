// Tests for `messages send --users` (multi-person DM / MPIM). The flag opens a
// group DM via conversations.open and posts once. A --dry-run never opens the
// MPIM, so these tests run against a client whose transport answers reads and
// FAILS on any write — the same "no write call" seam dry-run.test.ts uses —
// plus parse-level checks for the flag and its rejections. The conflict and the
// 1-8 count flow through failCommand(InvalidInputError), so --json callers get
// the structured `invalid_input` object (not Commander's plain-text conflict).
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { READ_METHODS } from '../lib/retry.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createMessagesCommand } from './messages.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

let stdout: string;
let stderr: string;

function answer(method: string, _params: Record<string, unknown>): unknown {
  if (!READ_METHODS.has(method)) {
    throw new Error(`send --users --dry-run made a write call: ${method}`);
  }
  throw new Error(`unexpected read ${method}`);
}

function clientFor(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method, params = {}) => answer(method, params));
  return client;
}

async function run(argv: string[]): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(BROWSER));
  await createMessagesCommand().parseAsync(argv, { from: 'user' });
}

// The structured error a --json send reports: the last stderr line's `error`.
async function failJson(argv: string[]) {
  await run([...argv, '--json']);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe('');
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]).error;
}

describe('messages send --users', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
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

  it('exposes a --users option on messages send', () => {
    const send = createMessagesCommand().commands.find((c) => c.name() === 'send')!;
    const longs = send.options.map((o) => o.long);
    expect(longs).toContain('--users');
  });

  it('previews the user set as a group_dm target in --dry-run WITHOUT opening the MPIM', async () => {
    await run(['send', '--users', 'U1111111111,U2222222222', '--message', 'hi', '--dry-run', '--json']);
    expect(process.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.dry_run).toBe(true);
    // The preview is a dedicated group_dm kind carrying the resolved user set;
    // no conversations.open happened (the client throws on that write), and
    // there is no comma-string `id` / name lookup.
    expect(payload.target).toMatchObject({ kind: 'group_dm', ids: ['U1111111111', 'U2222222222'] });
    expect(payload.target.id).toBeUndefined();
  });

  it('previews a single user as a group_dm target in --dry-run', async () => {
    await run(['send', '--users', 'U1111111111', '--message', 'hi', '--dry-run', '--json']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout).target).toMatchObject({ kind: 'group_dm', ids: ['U1111111111'] });
  });

  it('rejects --users with --recipient-id as invalid_input (structured --json)', async () => {
    const error = await failJson(['send', '--users', 'U1111111111', '--recipient-id', 'C123', '--message', 'x', '--dry-run']);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('--users cannot be combined');
  });

  it('rejects --users with --permalink as invalid_input', async () => {
    const error = await failJson([
      'send', '--users', 'U1111111111',
      '--permalink', 'https://acme.slack.com/archives/C123/p1712345678000100',
      '--message', 'x', '--dry-run',
    ]);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('--users cannot be combined');
  });

  it('rejects more than 8 users as invalid_input', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `U${String(i).repeat(10)}`).join(',');
    const error = await failJson(['send', '--users', nine, '--message', 'x', '--dry-run']);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('at most 8 users');
  });

  it('rejects an empty --users list as invalid_input', async () => {
    const error = await failJson(['send', '--users', '  ,  ', '--message', 'x', '--dry-run']);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('at least one user');
  });
});

describe('messages send --users real send path', () => {
  let savedExitCode: typeof process.exitCode;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;

  // A client that records every call and answers the MPIM open + post, so the
  // real (non-dry-run) path can be exercised without touching Slack.
  function recordingClient(): SlackClient {
    const client = new SlackClient(BROWSER);
    spyOn(client, 'request').mockImplementation(async (method, params = {}) => {
      calls.push({ method, params });
      switch (method) {
        case 'conversations.open':
          return { ok: true, channel: { id: 'G0GROUPDM01' } };
        case 'chat.postMessage':
          return { ok: true, ts: '1700000000.000100', channel: params.channel };
        case 'chat.getPermalink':
          return { ok: true, permalink: 'https://acme.slack.com/archives/G0GROUPDM01/p1700000000000100' };
        default:
          return { ok: true };
      }
    });
    return client;
  }

  async function send(argv: string[]): Promise<void> {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(recordingClient());
    await createMessagesCommand().parseAsync(argv, { from: 'user' });
  }

  beforeEach(() => {
    calls = [];
    stdout = '';
    stderr = '';
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

  it('opens the MPIM with the joined ids and posts to the returned channel', async () => {
    await send(['send', '--users', 'U1111111111,U2222222222,U3333333333', '--message', 'hi all']);
    expect(process.exitCode ?? 0).toBe(0);

    const open = calls.find((c) => c.method === 'conversations.open');
    expect(open).toBeDefined();
    expect(open!.params.users).toBe('U1111111111,U2222222222,U3333333333');

    const post = calls.find((c) => c.method === 'chat.postMessage');
    expect(post).toBeDefined();
    expect(post!.params.channel).toBe('G0GROUPDM01');
    expect(post!.params.text).toBe('hi all');
  });

  it('posts to the opened MPIM channel as a thread reply when --thread-ts is given', async () => {
    await send(['send', '--users', 'U1111111111,U2222222222', '--message', 'reply', '--thread-ts', '1699999999.000200']);
    expect(process.exitCode ?? 0).toBe(0);

    const post = calls.find((c) => c.method === 'chat.postMessage');
    expect(post).toBeDefined();
    expect(post!.params.channel).toBe('G0GROUPDM01');
    expect(post!.params.thread_ts).toBe('1699999999.000200');
  });
});
