// Every command with --json reports a failure as one JSON error object on
// stderr, with nothing on stdout and exit code 1 (#326). In-process, with the
// Slack client stubbed, so each command's own failure branches are exercised.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as authLib from '../lib/auth.ts';
import { NotFoundError } from '../lib/cli-errors.ts';
import { createCanvasCommand } from './canvas.ts';
import { createConversationsCommand } from './conversations.ts';
import { createEmojiCommand } from './emoji.ts';
import { createLogsCommand } from './logs.ts';
import { createMessagesCommand } from './messages.ts';
import { createSavedCommand } from './saved.ts';
import { createSearchCommand } from './search.ts';
import { createTeamCommand } from './team.ts';
import { createUsergroupsCommand } from './usergroups.ts';
import { createUsersCommand } from './users.ts';

// A client whose every Slack call fails the way both transports fail on an
// ok:false answer: Slack's code in the message and on `slackData`.
function refusingClient(code: string): unknown {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'workspaceHost') return 'acme.slack.com';
      return async () => {
        throw Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
      };
    },
  });
}

// A client whose every call succeeds with nothing in it.
function emptyClient(): unknown {
  const empty = { ok: true, messages: [], channels: [], members: [], usergroups: [], users: [], emoji: {}, drafts: [] };
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'workspaceHost') return 'acme.slack.com';
      return async () => empty;
    },
  });
}

const factories: Record<string, () => Command> = {
  canvas: createCanvasCommand,
  conversations: createConversationsCommand,
  emoji: createEmojiCommand,
  logs: createLogsCommand,
  messages: createMessagesCommand,
  saved: createSavedCommand,
  search: createSearchCommand,
  team: createTeamCommand,
  usergroups: createUsergroupsCommand,
  users: createUsersCommand,
};

describe('--json failures, in process', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    // Unattended, as an agent runs it: a write without --yes is refused.
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

  async function run(client: unknown, argv: string[]) {
    if (client instanceof Error) spyOn(authLib, 'getAuthenticatedClient').mockRejectedValue(client);
    else spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client as any);
    const [group, ...rest] = argv;
    await factories[group]().parseAsync([...rest, '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).error;
  }

  // Slack refuses the first call: the command's catch block reports it.
  it.each([
    [['canvas', 'list']],
    [['canvas', 'read', 'F0123456789']],
    [['conversations', 'list']],
    [['conversations', 'read', 'C0123456789']],
    [['conversations', 'get', 'C0123456789', '1712345678.000100']],
    [['conversations', 'unread']],
    [['conversations', 'members', 'list', 'C0123456789']],
    [['conversations', 'members', 'add', 'C0123456789', 'U0123456789', '--yes']],
    [['conversations', 'join', 'C0123456789']],
    [['conversations', 'leave', 'C0123456789', '--yes']],
    [['emoji', 'list']],
    [['emoji', 'get', 'party']],
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi']],
    [['messages', 'edit', '--channel-id', 'C0123456789', '--timestamp', '1712345678.000100', '--message', 'hi']],
    [['messages', 'list-drafts']],
    [['messages', 'draft', '--recipient-id', 'C0123456789', '--message', 'hi']],
    [['messages', 'send-draft', 'Dr0123456789', '--yes']],
    [['messages', 'delete-draft', 'Dr0123456789', '--yes']],
    [['saved', 'list']],
    [['search', 'messages', 'deploy']],
    [['search', 'channels', 'deploy']],
    [['search', 'people', 'alice']],
    [['team', 'info']],
    [['usergroups', 'list']],
    [['usergroups', 'read', 'S0123456789']],
    [['usergroups', 'create', 'Platform', '--yes']],
    [['usergroups', 'update', 'S0123456789', '--name', 'Platform', '--yes']],
    [['usergroups', 'add', 'S0123456789', 'U0123456789', '--yes']],
    [['usergroups', 'remove', 'S0123456789', 'U0123456789', '--yes']],
    [['usergroups', 'enable', 'S0123456789', '--yes']],
    [['usergroups', 'disable', 'S0123456789', '--yes']],
    [['users', 'info', 'U0123456789']],
    [['users', 'list']],
  ])('%j reports a Slack refusal as its code', async (argv) => {
    const error = await run(refusingClient('missing_scope'), argv);
    expect(error).toMatchObject({
      code: 'permission_denied',
      message: 'Slack API error: missing_scope',
      retryable: false,
      slack_error: 'missing_scope',
    });
  });

  // Per-user refusals are a partial result on stdout; a failure before any
  // removal is an error object.
  it('reports members remove failing before any removal', async () => {
    const error = await run(
      new NotFoundError('Workspace not found: nope'),
      ['conversations', 'members', 'remove', 'C0123456789', 'U0123456789', '--yes'],
    );
    expect(error).toMatchObject({ code: 'not_found', message: 'Workspace not found: nope', retryable: false });
  });

  it('keeps the enterprise member-enumeration explanation under --json', async () => {
    const error = await run(refusingClient('enterprise_is_restricted'), ['conversations', 'members', 'list', 'C0123456789']);
    expect(error).toMatchObject({ code: 'permission_denied', slack_error: 'enterprise_is_restricted' });
    expect(error.message).toContain('blocked by this Enterprise Grid');
    expect(error.hint).toContain('Ask a workspace admin');
  });

  // Every write gate refuses without --yes when stdin is not a terminal.
  it.each([
    [['conversations', 'members', 'add', 'C0123456789', 'U0123456789']],
    [['conversations', 'members', 'remove', 'C0123456789', 'U0123456789']],
    [['conversations', 'leave', 'C0123456789']],
    [['usergroups', 'create', 'Platform']],
    [['usergroups', 'update', 'S0123456789', '--name', 'Platform']],
    [['usergroups', 'add', 'S0123456789', 'U0123456789']],
    [['usergroups', 'remove', 'S0123456789', 'U0123456789']],
    [['usergroups', 'enable', 'S0123456789']],
    [['usergroups', 'disable', 'S0123456789']],
  ])('%j without --yes reports confirmation_required and calls nothing', async (argv) => {
    const error = await run(refusingClient('should_not_be_called'), argv);
    expect(error).toMatchObject({ code: 'confirmation_required', hint: 'Re-run with --yes to confirm the write.' });
  });

  it.each([
    [['messages', 'send-draft', 'Dr0123456789'], 'Draft was not sent'],
    [['messages', 'delete-draft', 'Dr0123456789'], 'Draft was not deleted'],
  ])('%j without --yes reports confirmation_required and no text line', async (argv, text) => {
    const client = emptyClient() as Record<string, unknown>;
    // send-draft loads the draft before asking; give it one it could send.
    const draft = {
      id: 'Dr0123456789',
      destinations: [{ channel_id: 'C0123456789' }],
      blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hi' }] }] }],
    };
    const withDraft = new Proxy(client, {
      get: (target, prop) => (prop === 'listDrafts' ? async () => ({ ok: true, drafts: [draft] }) : target[prop as string]),
    });
    const error = await run(withDraft, argv);
    expect(error.code).toBe('confirmation_required');
    expect(stderr).not.toContain(text);
  });

  // Failures the command detects itself, before or after a successful call.
  it.each([
    [['canvas', 'list', '--limit', '0'], 'invalid_input', 'Limit must be a number between 1 and 1000'],
    [['canvas', 'read', 'Xbad'], 'invalid_input', 'Invalid canvas ID. Canvas ID must start with F'],
    [['conversations', 'get', 'C0123456789', '1712345678.000100'], 'not_found', 'Message not found'],
    [['conversations', 'members', 'list', 'C0123456789', '--limit', '0'], 'invalid_input', '--limit must be a positive integer'],
    [['conversations', 'members', 'add', 'C0123456789', ','], 'invalid_input', 'No user IDs given'],
    [['conversations', 'members', 'remove', 'C0123456789', ','], 'invalid_input', 'No user IDs given'],
    [['emoji', 'list', '--limit', 'abc'], 'invalid_input', ''],
    [['emoji', 'get', 'party'], 'not_found', 'No custom emoji named :party:'],
    [['messages', 'send', '--recipient-id', 'C0123456789'], 'invalid_input', 'Either --message or --message-file is required'],
    [['messages', 'delete-draft', ' ', '--yes'], 'invalid_input', 'Draft ID cannot be empty'],
    [['messages', 'send-draft', 'Dr0123456789', '--yes'], 'not_found', 'Active draft Dr0123456789 was not found'],
    [['usergroups', 'read', '@nobody'], 'not_found', 'No user group matching "@nobody"'],
    [['usergroups', 'update', 'S0123456789', '--yes'], 'invalid_input', 'Nothing to update'],
    [['users', 'info', 'U0123456789'], 'not_found', ''],
    [['users', 'list', '--limit', '0'], 'invalid_input', '--limit must be a positive integer'],
    [['users', 'list', '--status', 'gone'], 'invalid_input', '--status must be one of'],
  ])('%j reports %p', async (argv, code, message) => {
    const error = await run(emptyClient(), argv);
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
    expect(error.retryable).toBe(false);
  });

  describe('logs show', () => {
    let dir: string;
    const savedLogDir = process.env.SLACKCLI_LOG_DIR;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'slackcli-json-errors-'));
      process.env.SLACKCLI_LOG_DIR = dir;
    });

    afterEach(async () => {
      if (savedLogDir === undefined) delete process.env.SLACKCLI_LOG_DIR;
      else process.env.SLACKCLI_LOG_DIR = savedLogDir;
      await rm(dir, { recursive: true, force: true });
    });

    it.each([
      [['logs', 'show', '--last', '1', '--run', 'x'], 'invalid_input', 'Use either --last or --run, not both.'],
      [['logs', 'show', '--last', '0'], 'invalid_input', '--last must be a positive integer'],
      [['logs', 'show', '--run', 'nope'], 'not_found', 'No run with run_id "nope" in the log.'],
    ])('%j reports %p', async (argv, code, message) => {
      const error = await run(emptyClient(), argv);
      expect(error.code).toBe(code);
      expect(error.message).toContain(message);
    });
  });
});
