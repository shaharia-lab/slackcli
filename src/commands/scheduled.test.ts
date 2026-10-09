// messages schedule / list-scheduled / delete-scheduled (#379), in process.
// The client is a real SlackClient whose transport is replaced, so the guard,
// the parameters sent and the calls made are all checked at the one seam every
// Slack call goes through. stdin is not a terminal, as when an agent runs it.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
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

const WRITES = ['chat.scheduleMessage', 'chat.deleteScheduledMessage'];

type Call = { method: string; params: Record<string, any> };
type Answer = Record<string, unknown> | Error | ((params: Record<string, any>) => unknown);

const PENDING = [
  { id: 'Q0000000002', channel_id: 'D0123456789', post_at: 1791800000, date_created: 1791000000, text: 'Second' },
  { id: 'Q0000000001', channel_id: 'C0123456789', post_at: 1791791400, date_created: 1791000000, text: 'Standup in 10 minutes' },
];

function slackRefusal(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

let calls: Call[];
let answers: Record<string, Answer>;
let stdout: string;
let stderr: string;

function defaultAnswers(): Record<string, Answer> {
  return {
    'chat.scheduleMessage': (params) => ({
      ok: true,
      channel: params.channel,
      scheduled_message_id: 'Q0123ABCDEF',
      post_at: params.post_at,
    }),
    'chat.scheduledMessages.list': { ok: true, scheduled_messages: PENDING, response_metadata: { next_cursor: '' } },
    'chat.deleteScheduledMessage': { ok: true },
    'conversations.open': { ok: true, channel: { id: 'D0123456789' } },
    'conversations.info': (params) => ({ ok: true, channel: { id: params.channel, name: 'deploys' } }),
    'users.info': (params) => ({ ok: true, user: { id: params.user, name: 'alice' } }),
    'conversations.list': { ok: true, channels: [{ id: 'C0123456789', name: 'deploys' }] },
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

async function run(argv: string[], config: WorkspaceConfig = STANDARD): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(config));
  await createMessagesCommand().parseAsync(argv, { from: 'user' });
}

// A successful --json run: exit 0 and exactly one JSON object on stdout.
async function runJson(argv: string[], config: WorkspaceConfig = STANDARD): Promise<any> {
  await run([...argv, '--json'], config);
  expect({ exitCode: process.exitCode ?? 0, stderr: stderr.includes('"error"') ? stderr : '' })
    .toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout);
}

// A failing --json run: exit 1, nothing on stdout, the error object last on stderr.
async function failJson(argv: string[], config: WorkspaceConfig = STANDARD): Promise<any> {
  await run([...argv, '--json'], config);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe('');
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]).error;
}

const methods = () => calls.map((call) => call.method);
const madeWrite = () => methods().some((method) => WRITES.includes(method));
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('scheduled messages (#379)', () => {
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

  describe('messages schedule', () => {
    const base = ['schedule', '--recipient-id', 'C0123456789', '--message', 'Standup in 10 minutes'];

    it('schedules at a Unix time and prints channel_id, scheduled_message_id and post_at', async () => {
      const postAt = nowSeconds() + 3600;
      const out = await runJson([...base, '--at', String(postAt)]);

      expect(out).toEqual({ channel_id: 'C0123456789', scheduled_message_id: 'Q0123ABCDEF', post_at: postAt });
      expect(Object.keys(out)).toEqual(['channel_id', 'scheduled_message_id', 'post_at']);
      expect(calls).toEqual([{
        method: 'chat.scheduleMessage',
        params: { channel: 'C0123456789', text: 'Standup in 10 minutes', post_at: postAt },
      }]);
    });

    it('reads a bare local time in the machine timezone', async () => {
      const saved = process.env.TZ;
      try {
        process.env.TZ = 'Europe/Berlin';
        // Noon tomorrow in Berlin, written the way a person types it.
        const tomorrow = new Date(Date.now() + 86_400_000);
        const pad = (n: number) => String(n).padStart(2, '0');
        const typed = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 12:00`;
        const expected = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 12, 0, 0).getTime() / 1000;

        const out = await runJson([...base, '--at', typed]);

        expect(out.post_at).toBe(expected);
        expect(calls[0].params.post_at).toBe(expected);
      } finally {
        // Deleting TZ does not undo the change; `bun test` runs in UTC.
        process.env.TZ = saved ?? 'UTC';
      }
    });

    it('schedules --in from now', async () => {
      const before = nowSeconds();
      const out = await runJson([...base, '--in', '1h30m']);
      const after = nowSeconds();

      expect(out.post_at).toBeGreaterThanOrEqual(before + 5400);
      expect(out.post_at).toBeLessThanOrEqual(after + 5400);
      expect(calls[0].params.post_at).toBe(out.post_at);
    });

    it('reports the post_at Slack answered with when it differs', async () => {
      answers['chat.scheduleMessage'] = { ok: true, scheduled_message_id: 'Q0123ABCDEF', post_at: 1791791400 };
      const out = await runJson([...base, '--in', '1h']);
      expect(out.post_at).toBe(1791791400);
    });

    it('sends thread_ts and blocks, and reports thread_ts for a threaded reply', async () => {
      const out = await runJson([
        ...base, '--thread-ts', 'p1712345678000100', '--blocks', '[{"type":"divider"}]', '--in', '2h',
      ]);

      expect(out).toMatchObject({ channel_id: 'C0123456789', thread_ts: '1712345678.000100' });
      expect(Object.keys(out)).toEqual(['channel_id', 'scheduled_message_id', 'post_at', 'thread_ts']);
      expect(calls[0].params).toMatchObject({ thread_ts: '1712345678.000100', blocks: [{ type: 'divider' }] });
    });

    it('takes the channel and thread from a message --permalink', async () => {
      const out = await runJson([
        'schedule', '--permalink', 'https://acme.slack.com/archives/C0123456789/p1712345678000100',
        '--message', 'Fixed', '--in', '2h',
      ]);
      expect(out).toMatchObject({ channel_id: 'C0123456789', thread_ts: '1712345678.000100' });
      expect(calls[0].params).toMatchObject({ channel: 'C0123456789', thread_ts: '1712345678.000100' });
    });

    it('opens the DM for a user and schedules into it', async () => {
      const out = await runJson(['schedule', '--recipient-id', 'U0123456789', '--message', 'Reminder', '--in', '1h']);

      expect(methods()).toEqual(['conversations.open', 'chat.scheduleMessage']);
      expect(out.channel_id).toBe('D0123456789');
      expect(calls[1].params.channel).toBe('D0123456789');
    });

    it('resolves a channel name before scheduling', async () => {
      const out = await runJson(['schedule', '--recipient-id', '#deploys', '--message', 'Deploy', '--in', '1h']);
      expect(methods()).toEqual(['conversations.list', 'chat.scheduleMessage']);
      expect(out.channel_id).toBe('C0123456789');
    });

    it('echoes the resolved time with its timezone, the target and the ID in text mode', async () => {
      await run([...base, '--at', String(nowSeconds() + 3600)]);

      expect(process.exitCode ?? 0).toBe(0);
      const lines = plain(stdout).trimEnd().split('\n');
      // Weekday, date, time and a timezone name, e.g. "Mon 12 Oct 2026, 09:50 UTC".
      expect(lines[0]).toMatch(/^Scheduled for [A-Z][a-z]{2} \d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}(:\d{2})? \S+$/);
      expect(lines.slice(1)).toEqual(['  Target: C0123456789', '  ID:     Q0123ABCDEF']);
    });

    it.each([
      [['--at', '2020-01-01T00:00:00Z'], 'must be in the future'],
      [['--at', '1'], 'must be in the future'],
      [['--at', '2099-01-01T00:00:00Z'], 'at most 120 days ahead'],
      [['--in', '121d'], 'at most 120 days ahead'],
      [['--at', 'tomorrow'], 'Cannot read --at'],
      [['--at', '2026-02-30 09:50'], 'is not a real date and time'],
      [['--in', '45'], 'Cannot read --in'],
      [['--in', '0m'], 'must be longer than zero'],
      [['--at', '2099-01-01T00:00:00Z', '--in', '1h'], '--at and --in cannot be used together'],
      [[], 'Pass --at <time> or --in <duration>'],
    ])('refuses %j as invalid_input before any Slack call', async (time, message) => {
      const getClient = spyOn(authLib, 'getAuthenticatedClient');
      const error = await failJson([...base, ...time]);

      expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
      expect(error.message).toContain(message);
      expect(calls).toEqual([]);
      expect(getClient).not.toHaveBeenCalled();
    });

    it('refuses a missing message before any Slack call', async () => {
      const error = await failJson(['schedule', '--recipient-id', 'C0123456789', '--in', '1h']);
      expect(error.code).toBe('invalid_input');
      expect(error.message).toContain('Either --message or --message-file is required');
      expect(calls).toEqual([]);
    });

    it('offers no --file', () => {
      const schedule = createMessagesCommand().commands.find((cmd) => cmd.name() === 'schedule')!;
      expect(schedule.options.map((option) => option.long)).toEqual([
        '--recipient-id', '--message', '--message-file', '--thread-ts', '--permalink', '--blocks',
        '--at', '--in', '--workspace', '--json', '--dry-run',
      ]);
    });

    it('prints the failure in text mode and exits 1', async () => {
      await run([...base, '--at', 'tomorrow']);
      expect(process.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('Cannot read --at "tomorrow" as a time');
    });

    it.each([
      ['time_in_past', 'invalid_input', false],
      ['time_too_far', 'invalid_input', false],
      ['restricted_too_many', 'rate_limited', true],
      ['channel_not_found', 'not_found', false],
      ['not_allowed_token_type', 'unsupported_auth_type', false],
    ])('reports Slack\'s %s as %s', async (slackCode, code, retryable) => {
      answers['chat.scheduleMessage'] = slackRefusal(slackCode);
      const error = await failJson([...base, '--in', '1h']);
      expect(error).toMatchObject({ code, retryable, slack_error: slackCode });
    });

    describe('--dry-run', () => {
      it('previews the target, the resolved post_at and the payload without writing or prompting', async () => {
        const postAt = nowSeconds() + 7200;
        const preview = await runJson([
          ...base, '--thread-ts', '1712345678.000100', '--blocks', '[{"type":"divider"}]',
          '--at', String(postAt), '--dry-run',
        ]);

        expect(preview).toEqual({
          dry_run: true,
          action: 'schedule message',
          workspace: { name: 'Acme Corp', id: 'T0123456789', profile: 'acme' },
          target: { kind: 'channel', id: 'C0123456789', name: '#deploys', thread_ts: '1712345678.000100' },
          payload: { post_at: postAt, text: 'Standup in 10 minutes', blocks: [{ type: 'divider' }] },
        });
        expect(methods()).toEqual(['conversations.info']);
        expect(stderr).not.toContain('[y/N]');
      });

      it('previews a user as the target without opening the DM', async () => {
        const preview = await runJson(['schedule', '--recipient-id', 'U0123456789', '--message', 'Reminder', '--in', '1h', '--dry-run']);
        expect(preview.target).toEqual({ kind: 'user', id: 'U0123456789', name: '@alice' });
        expect(methods()).toEqual(['users.info']);
      });

      it('shows the time the post_at stands for in the text preview', async () => {
        const postAt = nowSeconds() + 7200;
        await run([...base, '--at', String(postAt), '--dry-run']);

        const text = plain(stdout);
        expect(process.exitCode ?? 0).toBe(0);
        expect(text).toContain('Dry run: nothing was sent.');
        expect(text).toContain('  Action:    schedule message');
        expect(text).toContain('  Target:    C0123456789 (#deploys)');
        expect(text).toMatch(new RegExp(`  Post at:   ${postAt} \\([A-Z][a-z]{2} \\d{2} [A-Z][a-z]{2} \\d{4}, \\d{2}:\\d{2}(:\\d{2})? \\S+\\)`));
        expect(madeWrite()).toBe(false);
      });

      it('still refuses a bad time', async () => {
        const error = await failJson([...base, '--at', '2020-01-01T00:00:00Z', '--dry-run']);
        expect(error.code).toBe('invalid_input');
        expect(calls).toEqual([]);
      });
    });
  });

  describe('messages list-scheduled', () => {
    it('prints scheduled_count and the pending messages, soonest first', async () => {
      const out = await runJson(['list-scheduled']);

      expect(out).toEqual({
        scheduled_count: 2,
        scheduled_messages: [
          { scheduled_message_id: 'Q0000000001', channel_id: 'C0123456789', post_at: 1791791400, date_created: 1791000000, text: 'Standup in 10 minutes' },
          { scheduled_message_id: 'Q0000000002', channel_id: 'D0123456789', post_at: 1791800000, date_created: 1791000000, text: 'Second' },
        ],
      });
      expect(calls).toEqual([{ method: 'chat.scheduledMessages.list', params: { limit: 100 } }]);
    });

    it('prints the same bytes on every run without --fields', async () => {
      await runJson(['list-scheduled']);
      const first = stdout;
      stdout = '';
      await runJson(['list-scheduled']);
      expect(stdout).toBe(first);
      expect(first).toBe(`${JSON.stringify(JSON.parse(first), null, 2)}\n`);
    });

    it('keeps the envelope and projects each item with --fields', async () => {
      const out = await runJson(['list-scheduled', '--fields', 'scheduled_message_id,post_at']);
      expect(out).toEqual({
        scheduled_count: 2,
        scheduled_messages: [
          { scheduled_message_id: 'Q0000000001', post_at: 1791791400 },
          { scheduled_message_id: 'Q0000000002', post_at: 1791800000 },
        ],
      });
    });

    it('prints an empty list, not nothing, when none are pending', async () => {
      answers['chat.scheduledMessages.list'] = { ok: true, scheduled_messages: [] };
      expect(await runJson(['list-scheduled'])).toEqual({ scheduled_count: 0, scheduled_messages: [] });
    });

    it('filters by a channel given as --recipient-id', async () => {
      await runJson(['list-scheduled', '--recipient-id', 'C0123456789']);
      expect(calls).toEqual([{ method: 'chat.scheduledMessages.list', params: { limit: 100, channel: 'C0123456789' } }]);
    });

    it('filters by a user\'s DM, and by a channel name', async () => {
      await runJson(['list-scheduled', '--recipient-id', 'U0123456789']);
      expect(methods()).toEqual(['conversations.open', 'chat.scheduledMessages.list']);
      expect(calls[1].params.channel).toBe('D0123456789');

      calls = [];
      stdout = '';
      await runJson(['list-scheduled', '--recipient-id', '#deploys']);
      expect(methods()).toEqual(['conversations.list', 'chat.scheduledMessages.list']);
      expect(calls[1].params.channel).toBe('C0123456789');
    });

    it('returns no more than --limit', async () => {
      const out = await runJson(['list-scheduled', '--limit', '1']);
      expect(out.scheduled_count).toBe(1);
      expect(out.scheduled_messages.map((message: any) => message.scheduled_message_id)).toEqual(['Q0000000001']);
    });

    it.each(['0', '-1', 'abc', '1.5'])('refuses --limit %s before any Slack call', async (limit) => {
      const error = await failJson(['list-scheduled', '--limit', limit]);
      expect(error).toMatchObject({ code: 'invalid_input', message: '--limit must be a positive integer' });
      expect(calls).toEqual([]);
    });

    it('lists as text, and writes nothing to stdout when none are pending', async () => {
      await run(['list-scheduled']);
      const text = plain(stdout);
      expect(text).toContain('Scheduled Messages (2)');
      expect(text).toContain('     Standup in 10 minutes\n     id: Q0000000001\n');
      expect(text.indexOf('Q0000000001')).toBeLessThan(text.indexOf('Q0000000002'));

      stdout = '';
      answers['chat.scheduledMessages.list'] = { ok: true, scheduled_messages: [] };
      await run(['list-scheduled']);
      expect(stdout).toBe('');
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('reports a Slack refusal as its code', async () => {
      answers['chat.scheduledMessages.list'] = slackRefusal('missing_scope');
      const error = await failJson(['list-scheduled']);
      expect(error).toMatchObject({ code: 'permission_denied', slack_error: 'missing_scope' });
    });
  });

  describe('messages delete-scheduled', () => {
    it('finds the channel in the pending list, cancels and prints the result', async () => {
      const out = await runJson(['delete-scheduled', 'Q0000000001', '--yes']);

      expect(out).toEqual({ scheduled_message_id: 'Q0000000001', channel_id: 'C0123456789', deleted: true });
      expect(calls).toEqual([
        { method: 'chat.scheduledMessages.list', params: { limit: 100 } },
        { method: 'chat.deleteScheduledMessage', params: { channel: 'C0123456789', scheduled_message_id: 'Q0000000001' } },
      ]);
    });

    it('trims the ID it was given', async () => {
      const out = await runJson(['delete-scheduled', ' Q0000000002 ', '--yes']);
      expect(out).toEqual({ scheduled_message_id: 'Q0000000002', channel_id: 'D0123456789', deleted: true });
    });

    it('finds a message on a later page', async () => {
      let page = 0;
      answers['chat.scheduledMessages.list'] = () => {
        page += 1;
        return page === 1
          ? { ok: true, scheduled_messages: [PENDING[0]], response_metadata: { next_cursor: 'c1' } }
          : { ok: true, scheduled_messages: [PENDING[1]] };
      };
      const out = await runJson(['delete-scheduled', 'Q0000000001', '--yes']);
      expect(out.channel_id).toBe('C0123456789');
      expect(methods()).toEqual(['chat.scheduledMessages.list', 'chat.scheduledMessages.list', 'chat.deleteScheduledMessage']);
    });

    it('reports not_found for an ID that is not pending, and cancels nothing', async () => {
      const error = await failJson(['delete-scheduled', 'Q9999999999', '--yes']);

      expect(error).toMatchObject({
        code: 'not_found',
        message: 'Scheduled message Q9999999999 is not pending',
        retryable: false,
      });
      expect(error.hint).toContain('slackcli messages list-scheduled');
      expect(madeWrite()).toBe(false);
    });

    it('refuses without --yes when stdin is not a terminal, and cancels nothing', async () => {
      const error = await failJson(['delete-scheduled', 'Q0000000001']);

      expect(error).toMatchObject({ code: 'confirmation_required', hint: 'Re-run with --yes to confirm the write.' });
      expect(stderr).not.toContain('Scheduled message was not cancelled');
      expect(methods()).toEqual(['chat.scheduledMessages.list']);
    });

    it('says the message was not cancelled when refusing in text mode', async () => {
      await run(['delete-scheduled', 'Q0000000001']);
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('Scheduled message was not cancelled');
      expect(madeWrite()).toBe(false);
    });

    it('confirms in text mode', async () => {
      await run(['delete-scheduled', 'Q0000000001', '--yes']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(stdout).toContain('Cancelled scheduled message Q0000000001');
    });

    it('refuses an empty ID before any Slack call', async () => {
      const error = await failJson(['delete-scheduled', ' ', '--yes']);
      expect(error).toMatchObject({ code: 'invalid_input', message: 'Scheduled message ID cannot be empty' });
      expect(calls).toEqual([]);
    });

    it('reports Slack refusing the cancel, such as inside the last 60 seconds', async () => {
      answers['chat.deleteScheduledMessage'] = slackRefusal('invalid_scheduled_message_id');
      const error = await failJson(['delete-scheduled', 'Q0000000001', '--yes']);
      expect(error).toMatchObject({ code: 'not_found', slack_error: 'invalid_scheduled_message_id' });
    });

    describe('--dry-run', () => {
      it('previews the message without cancelling, prompting or needing --yes', async () => {
        const preview = await runJson(['delete-scheduled', 'Q0000000001', '--dry-run']);

        expect(preview).toEqual({
          dry_run: true,
          action: 'delete scheduled message',
          workspace: { name: 'Acme Corp', id: 'T0123456789', profile: 'acme' },
          target: { kind: 'scheduled_message', id: 'Q0000000001' },
          payload: { channel_id: 'C0123456789', post_at: 1791791400 },
        });
        expect(methods()).toEqual(['chat.scheduledMessages.list']);
        expect(stderr).not.toContain('[y/N]');
      });

      it('renders the text preview', async () => {
        await run(['delete-scheduled', 'Q0000000001', '--dry-run']);
        const text = plain(stdout);
        expect(text).toContain('  Action:     delete scheduled message');
        expect(text).toContain('  Target:     scheduled message Q0000000001');
        expect(text).toContain('  Channel id: C0123456789');
        expect(madeWrite()).toBe(false);
      });

      it('reports not_found for an ID that is not pending', async () => {
        const error = await failJson(['delete-scheduled', 'Q9999999999', '--dry-run']);
        expect(error.code).toBe('not_found');
      });
    });
  });

  // Slack answers these methods with not_allowed_token_type on a browser
  // session, so the commands refuse first: no lookup, no DM opened, no call.
  describe('with a browser-auth workspace', () => {
    it.each([
      [['schedule', '--recipient-id', 'C0123456789', '--message', 'hi', '--in', '1h']],
      [['schedule', '--recipient-id', '#deploys', '--message', 'hi', '--in', '1h']],
      [['schedule', '--recipient-id', 'U0123456789', '--message', 'hi', '--in', '1h']],
      [['schedule', '--recipient-id', 'C0123456789', '--message', 'hi', '--in', '1h', '--dry-run']],
      [['list-scheduled']],
      [['list-scheduled', '--recipient-id', '#deploys']],
      [['list-scheduled', '--recipient-id', 'U0123456789']],
      [['delete-scheduled', 'Q0000000001', '--yes']],
      [['delete-scheduled', 'Q0000000001']],
      [['delete-scheduled', 'Q0000000001', '--dry-run']],
    ])('%j fails with unsupported_auth_type before any Slack call', async (argv) => {
      const error = await failJson(argv, BROWSER);

      expect(error).toMatchObject({ code: 'unsupported_auth_type', retryable: false });
      expect(error.message).toContain('standard Slack app token (xoxb or xoxp)');
      expect(calls).toEqual([]);
    });

    it('says so in text mode', async () => {
      await run(['list-scheduled'], BROWSER);
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('Scheduled messages require a standard Slack app token');
      expect(calls).toEqual([]);
    });
  });
});
