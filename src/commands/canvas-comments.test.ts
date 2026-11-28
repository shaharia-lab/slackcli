// canvas comments (#501), in process. The client is a real SlackClient whose
// transport is replaced, so the conversation read, the calls made and the
// output are all checked at the one seam every Slack call goes through.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createCanvasCommand } from './canvas.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

type Call = { method: string; params: Record<string, any> };

const USER = { id: 'U0123456789', name: 'alice', real_name: 'Alice' };

const ANSWERS: Record<string, unknown> = {
  'conversations.history': {
    ok: true,
    has_more: false,
    messages: [
      { type: 'message', ts: '1712345678.000200', user: 'U0123456789', text: 'second' },
      { type: 'message', ts: '1712345678.000100', user: 'U0123456789', text: 'first', reply_count: 1 },
    ],
  },
  'conversations.replies': {
    ok: true,
    messages: [
      { type: 'message', ts: '1712345678.000100', thread_ts: '1712345678.000100', user: 'U0123456789', text: 'first' },
      { type: 'message', ts: '1712345678.000110', thread_ts: '1712345678.000100', user: 'U0123456789', text: 'a reply' },
    ],
  },
  'users.info': { ok: true, user: USER },
};

let calls: Call[];
let failWith: string | undefined;
let stdout: string;
let stderr: string;
let getClient: ReturnType<typeof spyOn>;

function clientFor(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, any> = {}) => {
    calls.push({ method, params });
    if (failWith && method === 'conversations.history') {
      throw Object.assign(new Error(`Slack API error: ${failWith}`), { slackData: { ok: false, error: failWith } });
    }
    return ANSWERS[method] ?? { ok: true };
  });
  return client;
}

async function run(argv: string[]): Promise<void> {
  getClient = spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(BROWSER));
  await createCanvasCommand().parseAsync(['comments', ...argv], { from: 'user' });
}

async function runJson(argv: string[]): Promise<any> {
  await run([...argv, '--json']);
  expect(process.exitCode ?? 0).toBe(0);
  return JSON.parse(stdout);
}

async function failJson(argv: string[]): Promise<any> {
  await run([...argv, '--json']);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe('');
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]).error;
}

describe('canvas comments (#501)', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    calls = [];
    failWith = undefined;
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
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
  });

  it('reads the canvas\'s comment conversation and prints comments with replies under --json', async () => {
    const out = await runJson(['F0123456789', '--limit', '20']);

    expect(out).toEqual({
      canvas_id: 'F0123456789',
      channel_id: 'C0123456789',
      comment_count: 2,
      has_more: false,
      comments: [
        {
          ts: '1712345678.000100',
          user: 'U0123456789',
          text: 'first',
          reply_count: 1,
          replies: [{ ts: '1712345678.000110', user: 'U0123456789', text: 'a reply' }],
        },
        { ts: '1712345678.000200', user: 'U0123456789', text: 'second', reply_count: 0, replies: [] },
      ],
      users: [USER],
    });
    expect(calls.map((call) => call.method)).toEqual(['conversations.history', 'conversations.replies', 'users.info']);
    expect(calls[0].params).toEqual({ channel: 'C0123456789', limit: 20 });
    expect(calls[1].params).toMatchObject({ channel: 'C0123456789', ts: '1712345678.000100' });
  });

  it('takes a canvas URL', async () => {
    const out = await runJson(['https://acme.slack.com/docs/T0123456789/F0ABCDEF123']);

    expect(out.canvas_id).toBe('F0ABCDEF123');
    expect(calls[0].params.channel).toBe('C0ABCDEF123');
  });

  it('prints the comments and their replies as text', async () => {
    await run(['F0123456789']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('Canvas F0123456789 (2 comments)');
    expect(stdout.indexOf('first')).toBeLessThan(stdout.indexOf('a reply'));
    expect(stdout.indexOf('a reply')).toBeLessThan(stdout.indexOf('second'));
  });

  it('applies --fields to the comments and keeps the envelope', async () => {
    const out = await runJson(['F0123456789', '--fields', 'text']);

    expect(out.comments).toEqual([{ text: 'first' }, { text: 'second' }]);
    expect(out.comment_count).toBe(2);
  });

  it('reports a canvas with no comment conversation as not_found', async () => {
    failWith = 'channel_not_found';
    const error = await failJson(['F0123456789']);

    expect(error.code).toBe('not_found');
    expect(error.message).toContain('No comments found for canvas F0123456789');
  });

  it.each([
    [['C0123456789'], 'expects a file ID'],
    [['Fnot-an-id'], 'Invalid canvas ID'],
    [['F0123456789', '--limit', '0'], 'Limit must be'],
    [['F0123456789', '--limit', '1001'], 'Limit must be'],
    [['F0123456789', '--limit', 'ten'], 'Limit must be'],
  ])('rejects %p before any Slack call', async (argv, message) => {
    const error = await failJson(argv);

    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
    expect(calls).toEqual([]);
  });
});
