// A message link to a thread reply, without ?thread_ts= (#482), in process.
// The client is a real SlackClient whose transport is replaced, so the calls
// made and the parameters sent are checked at the one seam every Slack call
// goes through. stdin is not a terminal, as when an agent runs it.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createConversationsCommand } from './conversations.ts';
import { createMessagesCommand } from './messages.ts';

const STANDARD: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  profile: 'acme',
  auth_type: 'standard',
  token: 'xoxb-fake',
  token_type: 'bot',
};

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

const CHANNEL = 'C0123456789';
const PARENT = '1712345678.000100';
const REPLY = '1712345699.000200';
const LONE = '1712345700.000300';
const LINK = `https://acme.slack.com/archives/${CHANNEL}/p`;
const REPLY_LINK = `${LINK}1712345699000200`;
const PARENT_LINK = `${LINK}1712345678000100`;
const LONE_LINK = `${LINK}1712345700000300`;
const REPLY_LINK_WITH_QUERY = `${REPLY_LINK}?thread_ts=${PARENT}&cid=${CHANNEL}`;

// conversations.replies as Slack answers it: a parent's ts gives the whole
// thread, a reply's ts only that reply, a message with no thread only itself.
const THREAD = [
  { type: 'message', ts: PARENT, thread_ts: PARENT, text: 'parent', reply_count: 2 },
  { type: 'message', ts: REPLY, thread_ts: PARENT, text: 'first reply' },
  { type: 'message', ts: '1712345699.000300', thread_ts: PARENT, text: 'second reply' },
];
const REPLIES_BY_TS: Record<string, unknown[]> = {
  [PARENT]: THREAD,
  [REPLY]: [THREAD[1]],
  [LONE]: [{ type: 'message', ts: LONE, text: 'lone' }],
};

type Call = { method: string; params: Record<string, any> };
type Answer = Record<string, unknown> | Error | ((params: Record<string, any>) => unknown);

let calls: Call[];
let answers: Record<string, Answer>;
let stdout: string;
let stderr: string;

function defaultAnswers(): Record<string, Answer> {
  return {
    'conversations.replies': (params) => ({ ok: true, messages: REPLIES_BY_TS[params.ts] ?? [], has_more: false }),
    'conversations.info': (params) => ({ ok: true, channel: { id: params.channel, name: 'deploys' } }),
    'chat.postMessage': (params) => ({ ok: true, channel: params.channel, ts: '1712345800.000100' }),
    'chat.getPermalink': { ok: true, permalink: `${LINK}1712345800000100` },
    'chat.scheduleMessage': (params) => ({
      ok: true,
      channel: params.channel,
      scheduled_message_id: 'Q0123ABCDEF',
      post_at: params.post_at,
    }),
    'drafts.create': (params) => ({ ok: true, draft: { id: 'Dr0123ABCDEF', ...params } }),
  };
}

function clientFor(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, any> = {}) => {
    calls.push({ method, params });
    if (!(method in answers)) throw new Error(`unexpected Slack call ${method}`);
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(params) : answer;
  });
  return client;
}

async function runJson(
  create: () => { parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown> },
  argv: string[],
  config: WorkspaceConfig = STANDARD,
): Promise<any> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(config));
  await create().parseAsync([...argv, '--json'], { from: 'user' });
  expect({ exitCode: process.exitCode ?? 0, stderr: stderr.includes('"error"') ? stderr : '' })
    .toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout);
}

const read = (argv: string[], config?: WorkspaceConfig) =>
  runJson(createConversationsCommand, ['read', ...argv], config);
const messages = (argv: string[], config?: WorkspaceConfig) => runJson(createMessagesCommand, argv, config);
const repliesAsked = () => calls.filter((call) => call.method === 'conversations.replies').map((call) => call.params.ts);
const methods = () => calls.map((call) => call.method);

describe('message links to a thread reply (#482)', () => {
  const realIsTTY = process.stdin.isTTY;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    calls = [];
    answers = defaultAnswers();
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

  describe('conversations read', () => {
    it('reads the whole thread from a reply link without ?thread_ts=', async () => {
      const out = await read(['--permalink', REPLY_LINK]);
      expect(out.messages.map((m: any) => m.ts)).toEqual(THREAD.map((m) => m.ts));
      expect(repliesAsked()).toEqual([REPLY, PARENT]);
    });

    it('reads the whole thread from --thread-ts <reply ts>, keeping --limit and the bounds', async () => {
      const out = await read([CHANNEL, '--thread-ts', REPLY, '--limit', '50', '--latest', '1712345900.000000']);
      expect(out.message_count).toBe(3);
      const replies = calls.filter((call) => call.method === 'conversations.replies');
      expect(replies.map((call) => call.params)).toEqual([
        { channel: CHANNEL, ts: REPLY, limit: 50, latest: '1712345900.000000' },
        { channel: CHANNEL, ts: PARENT, limit: 50, latest: '1712345900.000000' },
      ]);
    });

    it('reads a reply link with browser auth too', async () => {
      const out = await read(['--permalink', REPLY_LINK], BROWSER);
      expect(out.message_count).toBe(3);
      expect(repliesAsked()).toEqual([REPLY, PARENT]);
    });

    it('makes one call for a link that carries ?thread_ts=', async () => {
      const out = await read(['--permalink', REPLY_LINK_WITH_QUERY]);
      expect(out.message_count).toBe(3);
      expect(repliesAsked()).toEqual([PARENT]);
    });

    it('makes one call for a parent link', async () => {
      const out = await read(['--permalink', PARENT_LINK]);
      expect(out.message_count).toBe(3);
      expect(repliesAsked()).toEqual([PARENT]);
    });

    it('makes one call for a message with no thread and returns that message', async () => {
      const out = await read(['--permalink', LONE_LINK]);
      expect(out.messages.map((m: any) => m.ts)).toEqual([LONE]);
      expect(repliesAsked()).toEqual([LONE]);
    });
  });

  describe('messages send', () => {
    it('replies under the parent for a reply link without ?thread_ts=', async () => {
      await messages(['send', '--permalink', REPLY_LINK, '--message', 'Fixed']);
      const post = calls.find((call) => call.method === 'chat.postMessage');
      expect(post?.params).toMatchObject({ channel: CHANNEL, thread_ts: PARENT });
      expect(calls[0]).toEqual({ method: 'conversations.replies', params: { channel: CHANNEL, ts: REPLY, limit: 1 } });
    });

    it('makes no lookup for a link that carries ?thread_ts=', async () => {
      await messages(['send', '--permalink', REPLY_LINK_WITH_QUERY, '--message', 'Fixed']);
      expect(repliesAsked()).toEqual([]);
      expect(calls.find((call) => call.method === 'chat.postMessage')?.params.thread_ts).toBe(PARENT);
    });

    it('takes --thread-ts as given, with no lookup', async () => {
      await messages(['send', '--recipient-id', CHANNEL, '--thread-ts', REPLY, '--message', 'Fixed']);
      expect(repliesAsked()).toEqual([]);
      expect(calls.find((call) => call.method === 'chat.postMessage')?.params.thread_ts).toBe(REPLY);
    });

    it('replies under a message with no thread, after one lookup', async () => {
      await messages(['send', '--permalink', LONE_LINK, '--message', 'Fixed']);
      expect(repliesAsked()).toEqual([LONE]);
      expect(calls.find((call) => call.method === 'chat.postMessage')?.params.thread_ts).toBe(LONE);
    });

    it('falls back to the link timestamp when the lookup fails, and still posts', async () => {
      answers['conversations.replies'] = Object.assign(new Error('Slack API error: missing_scope'), {
        slackData: { ok: false, error: 'missing_scope' },
      });
      const out = await messages(['send', '--permalink', REPLY_LINK, '--message', 'Fixed']);
      expect(out.channel_id).toBe(CHANNEL);
      expect(calls.find((call) => call.method === 'chat.postMessage')?.params.thread_ts).toBe(REPLY);
    });

    it('previews the parent on --dry-run without posting', async () => {
      const preview = await messages(['send', '--permalink', REPLY_LINK, '--message', 'Fixed', '--dry-run']);
      expect(preview.target).toMatchObject({ kind: 'channel', id: CHANNEL, thread_ts: PARENT });
      expect(methods()).not.toContain('chat.postMessage');
    });
  });

  describe('messages draft and schedule', () => {
    it('drafts under the parent for a reply link', async () => {
      const out = await messages(['draft', '--permalink', REPLY_LINK, '--message', 'Fixed'], BROWSER);
      expect(out.thread_ts).toBe(PARENT);
      expect(repliesAsked()).toEqual([REPLY]);
    });

    it('schedules under the parent for a reply link', async () => {
      const out = await messages(['schedule', '--permalink', REPLY_LINK, '--message', 'Fixed', '--in', '2h']);
      expect(out.thread_ts).toBe(PARENT);
      expect(calls.find((call) => call.method === 'chat.scheduleMessage')?.params.thread_ts).toBe(PARENT);
    });
  });
});
