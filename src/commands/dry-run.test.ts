// --dry-run on every Slack write (#328), in process. The client is a real
// SlackClient whose transport answers the read methods and fails the test on
// anything else, so "no write call" is checked at the one seam every call
// goes through. stdin is not a terminal and --yes is never passed: a dry run
// that tried to confirm would be refused instead of printing its preview.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as authLib from '../lib/auth.ts';
import { READ_METHODS } from '../lib/retry.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createConversationsCommand } from './conversations.ts';
import { createMessagesCommand } from './messages.ts';
import { createUsergroupsCommand } from './usergroups.ts';

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
  token: 'xoxb-fake',
  token_type: 'bot',
};

const DRAFT = {
  id: 'Dr0123456789',
  destinations: [{ channel_id: 'C0123456789', thread_ts: '1712345678.000100' }],
  blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Release notes' }] }] }],
};

const factories: Record<string, () => Command> = {
  conversations: createConversationsCommand,
  messages: createMessagesCommand,
  usergroups: createUsergroupsCommand,
};

let methods: string[];
let groupMembers: string[];
let stdout: string;
let stderr: string;

// Answers for the reads a dry run may make; any other method is a write.
function answer(method: string, params: Record<string, unknown>): unknown {
  methods.push(method);
  if (!READ_METHODS.has(method)) {
    throw new Error(`dry run made a write call: ${method}`);
  }
  switch (method) {
    case 'conversations.info':
      return { ok: true, channel: { id: params.channel, name: 'deploys' } };
    case 'users.info':
      return { ok: true, user: { id: params.user, name: 'alice' } };
    case 'usergroups.list':
      return { ok: true, usergroups: [{ id: 'S0123456789', name: 'Platform', handle: 'platform', date_delete: 0 }] };
    case 'usergroups.users.list':
      return { ok: true, users: groupMembers };
    case 'drafts.list':
      return { ok: true, drafts: [DRAFT] };
    case 'conversations.list':
      return { ok: true, channels: [{ id: 'C0123456789', name: 'deploys' }] };
    case 'users.list':
      return { ok: true, members: [{ id: 'U0123456789', name: 'alice' }] };
    case 'users.lookupByEmail':
      return { ok: true, user: { id: 'U0123456789' } };
    default:
      throw new Error(`unexpected read ${method}`);
  }
}

function clientFor(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method, params = {}) => answer(method, params));
  return client;
}

async function run(argv: string[], config: WorkspaceConfig = BROWSER): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(config));
  const [group, ...rest] = argv;
  await factories[group]().parseAsync(rest, { from: 'user' });
}

async function runJson(argv: string[], config: WorkspaceConfig = BROWSER) {
  await run([...argv, '--dry-run', '--json'], config);
  expect({ argv, exitCode: process.exitCode ?? 0, stderr: stderr.includes('"error"') }).toEqual({ argv, exitCode: 0, stderr: false });
  return JSON.parse(stdout);
}

// The failure a --json command reports: the last stderr line.
async function failJson(argv: string[], config: WorkspaceConfig = BROWSER) {
  await run([...argv, '--dry-run', '--json'], config);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe('');
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]).error;
}

describe('--dry-run', () => {
  const realIsTTY = process.stdin.isTTY;
  let savedExitCode: typeof process.exitCode;
  let dir: string;

  beforeEach(async () => {
    methods = [];
    groupMembers = ['U0000000001', 'U0000000002'];
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    dir = await mkdtemp(join(tmpdir(), 'slackcli-dry-run-'));
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

  afterEach(async () => {
    mock.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  // All 16 writes: a preview, exit 0, no prompt, reads only.
  it.each([
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'Deploy done'], 'send message'],
    [['messages', 'edit', '--channel-id', 'C0123456789', '--timestamp', '1712345678.000100', '--message', 'Fixed'], 'edit message'],
    [['messages', 'draft', '--recipient-id', 'C0123456789', '--message', 'Notes'], 'create draft'],
    [['messages', 'send-draft', 'Dr0123456789'], 'send draft'],
    [['messages', 'delete-draft', 'Dr0123456789'], 'delete draft'],
    [['conversations', 'members', 'add', 'C0123456789', 'U0123456789'], 'add channel members'],
    [['conversations', 'members', 'remove', 'C0123456789', 'U0123456789'], 'remove channel members'],
    [['conversations', 'join', 'C0123456789'], 'join channel'],
    [['conversations', 'leave', 'C0123456789'], 'leave channel'],
    [['usergroups', 'create', 'Platform'], 'create user group'],
    [['usergroups', 'update', 'S0123456789', '--name', 'Platform'], 'update user group'],
    [['usergroups', 'add', 'S0123456789', 'U0123456789'], 'add user group members'],
    [['usergroups', 'remove', 'S0123456789', 'U0000000001'], 'remove user group members'],
    [['usergroups', 'enable', 'S0123456789'], 'enable user group'],
    [['usergroups', 'disable', 'S0123456789'], 'disable user group'],
  ])('%j previews without writing', async (argv, action) => {
    const preview = await runJson(argv);
    expect(preview).toMatchObject({
      dry_run: true,
      action,
      workspace: { name: 'Acme Corp', id: 'T0123456789', profile: 'acme' },
    });
    expect(Object.keys(preview).sort()).toEqual(['action', 'dry_run', 'payload', 'target', 'workspace']);
    expect(methods.every((method) => READ_METHODS.has(method))).toBe(true);
    expect(stderr).not.toContain('[y/N]');
  });

  // react has no --json: its preview is text only.
  it('previews messages react as text without adding the reaction', async () => {
    await run(['messages', 'react', '--channel-id', 'C0123456789', '--timestamp', '1712345678.000100', '--emoji', 'eyes', '--dry-run']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('Dry run: nothing was sent.');
    expect(stdout).toContain('add reaction');
    expect(stdout).toContain('C0123456789 (#deploys), message 1712345678.000100');
    expect(stdout).toContain('Emoji:');
    expect(methods).toEqual(['conversations.info']);
  });

  it('renders the text preview of a send', async () => {
    await run(['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'Deploy done', '--dry-run']);
    const text = stdout.replace(/\u001b\[[0-9;]*m/g, '');
    expect(text).toContain('Dry run: nothing was sent.\n  Workspace: Acme Corp (acme)\n  Action:    send message');
    expect(text).toContain('  Target:    C0123456789 (#deploys)');
    expect(text).toContain('  Text:      Deploy done');
  });

  it('shows the text read from --message-file and the parsed --blocks', async () => {
    const note = join(dir, 'note.md');
    await Bun.write(note, '*Deploy* done\nsecond line');
    const preview = await runJson([
      'messages', 'send', '--recipient-id', 'C0123456789', '--thread-ts', 'p1712345678000100',
      '--message-file', note, '--blocks', '[{"type":"divider"}]',
    ]);
    expect(preview.target).toEqual({ kind: 'channel', id: 'C0123456789', name: '#deploys', thread_ts: '1712345678.000100' });
    expect(preview.payload).toEqual({ text: '*Deploy* done\nsecond line', blocks: [{ type: 'divider' }] });
  });

  it('previews a file upload with its size and comment', async () => {
    const file = join(dir, 'report.txt');
    await Bun.write(file, 'Quarterly report');
    const preview = await runJson(['messages', 'send', '--recipient-id', 'C0123456789', '--file', file, '--message', 'Here']);
    expect(preview.payload).toEqual({ file, file_size: 16, comment: 'Here' });
  });

  it('previews a send to a user without opening the DM', async () => {
    const preview = await runJson(['messages', 'send', '--recipient-id', 'U0123456789', '--message', 'hi']);
    expect(preview.target).toEqual({ kind: 'user', id: 'U0123456789', name: '@alice' });
    expect(methods).toEqual(['users.info']);
  });

  // Names (#327) are resolved before the dry-run branch, so the preview shows
  // the ID the write would use. Resolving is a read; opening a DM is not done.
  it.each([
    [['messages', 'send', '--recipient-id', '#deploys', '--message', 'hi'], { kind: 'channel', id: 'C0123456789', name: '#deploys' }],
    [['messages', 'send', '--recipient-id', '@alice', '--message', 'hi'], { kind: 'user', id: 'U0123456789', name: '@alice' }],
    [['messages', 'draft', '--recipient-id', 'alice@example.com', '--message', 'hi'], { kind: 'user', id: 'U0123456789', name: '@alice' }],
    [['messages', 'edit', '--channel-id', 'deploys', '--timestamp', '1712345678.000100', '--message', 'hi'],
      { kind: 'message', id: 'C0123456789', name: '#deploys', ts: '1712345678.000100' }],
    [['conversations', 'members', 'add', '#deploys', '@alice'], { kind: 'channel', id: 'C0123456789', name: '#deploys' }],
    [['conversations', 'leave', 'deploys'], { kind: 'channel', id: 'C0123456789', name: '#deploys' }],
  ])('%j previews the resolved ID', async (argv, target) => {
    const preview = await runJson(argv);
    expect(preview.target).toEqual(target);
    expect(methods).not.toContain('conversations.open');
    expect(methods.every((method) => READ_METHODS.has(method))).toBe(true);
  });

  it('previews user group members given as handles and emails by ID', async () => {
    const preview = await runJson(['usergroups', 'add', '@platform', '@alice', 'alice@example.com']);
    expect(preview.payload).toMatchObject({ added: ['U0123456789'] });
  });

  it('fails the dry run on an unknown name, as the real command does', async () => {
    const error = await failJson(['messages', 'send', '--recipient-id', '#nope', '--message', 'hi']);
    expect(error.code).toBe('not_found');
  });

  it('works on an app token, and keeps the preview when the name lookup fails', async () => {
    const client = new SlackClient(STANDARD);
    spyOn(client, 'request').mockImplementation(async (method) => {
      methods.push(method);
      throw new Error('Slack API error: missing_scope');
    });
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client);
    await createMessagesCommand().parseAsync(
      ['send', '--recipient-id', 'C0123456789', '--message', 'hi', '--dry-run', '--json'],
      { from: 'user' },
    );
    const preview = JSON.parse(stdout);
    expect(preview.workspace).toEqual({ name: 'Acme Corp', id: 'T0123456789', profile: 'T0123456789' });
    expect(preview.target).toEqual({ kind: 'channel', id: 'C0123456789' });
    expect(methods).toEqual(['conversations.info']);
  });

  it('shows a draft to send with its thread and text', async () => {
    const preview = await runJson(['messages', 'send-draft', 'Dr0123456789']);
    expect(preview.target).toEqual({ kind: 'channel', id: 'C0123456789', name: '#deploys', thread_ts: '1712345678.000100' });
    expect(preview.payload).toMatchObject({ draft_id: 'Dr0123456789', text: 'Release notes' });
    expect(methods).toEqual(['drafts.list', 'conversations.info']);
  });

  it('shows the users a channel change would add or remove', async () => {
    expect((await runJson(['conversations', 'members', 'add', 'C0123456789', 'U0000000003,@U0000000004', '--team', 'T0000000009'])).payload)
      .toEqual({ add: ['U0000000003', 'U0000000004'], team: 'T0000000009' });
    stdout = '';
    expect((await runJson(['conversations', 'members', 'remove', 'C0123456789', 'U0000000003', 'U0000000004'])).payload)
      .toEqual({ remove: ['U0000000003', 'U0000000004'] });
  });

  it('shows the member list a user group change would write', async () => {
    const add = await runJson(['usergroups', 'add', '@platform', 'U0000000003', 'U0000000001']);
    expect(add.target).toEqual({ kind: 'usergroup', id: 'S0123456789', name: 'Platform (@platform)' });
    expect(add.payload).toEqual({
      added: ['U0000000003'],
      removed: [],
      next: ['U0000000001', 'U0000000002', 'U0000000003'],
      noop: false,
    });

    stdout = '';
    const remove = await runJson(['usergroups', 'remove', 'S0123456789', 'U0000000002', '--team', 'T0000000009']);
    expect(remove.payload).toEqual({
      added: [],
      removed: ['U0000000002'],
      next: ['U0000000001'],
      noop: false,
      team: 'T0000000009',
    });

    stdout = '';
    const noop = await runJson(['usergroups', 'add', 'S0123456789', 'U0000000001']);
    expect(noop.payload).toMatchObject({ added: [], noop: true });
  });

  it('shows the fields a create or update would send', async () => {
    expect((await runJson([
      'usergroups', 'create', 'Platform Team', '--handle', 'platform', '--description', 'Owns it', '--channels', 'C0123456789',
    ])).payload).toEqual({ name: 'Platform Team', handle: 'platform', description: 'Owns it', channels: 'C0123456789' });
    expect(methods).toEqual([]);

    // Empty values are not sent by the write, so the preview leaves them out.
    stdout = '';
    expect((await runJson(['usergroups', 'create', 'Platform', '--handle', '', '--description', '', '--channels', '', '--team', ''])).payload)
      .toEqual({ name: 'Platform' });

    stdout = '';
    expect((await runJson(['usergroups', 'update', 'S0123456789', '--description', 'New'])).payload)
      .toEqual({ description: 'New' });
  });

  // Validation runs exactly as on the real command: same error, exit 1.
  it.each([
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi', '--blocks', '{nope'], 'invalid_input'],
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi', '--blocks', '[{"type":""}]'], 'invalid_input'],
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message-file', '/nonexistent/slackcli-note.md'], 'invalid_input'],
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi', '--file', '/nonexistent/slackcli-file.txt'], 'invalid_input'],
    [['messages', 'send', '--message', 'hi'], 'invalid_input'],
    [['messages', 'edit', '--channel-id', 'C0123456789', '--message', 'hi'], 'invalid_input'],
    [['messages', 'draft', '--recipient-id', 'C0123456789'], 'invalid_input'],
    [['messages', 'send-draft', 'Dr_missing'], 'not_found'],
    [['messages', 'delete-draft', ' '], 'invalid_input'],
    [['conversations', 'members', 'add', 'C0123456789', ','], 'invalid_input'],
    [['usergroups', 'update', 'S0123456789'], 'invalid_input'],
    [['usergroups', 'remove', 'S0123456789', 'U0000000001', 'U0000000002'], 'invalid_input'],
    [['usergroups', 'enable', '@nobody'], 'not_found'],
  ])('%j fails the dry run like the real command', async (argv, code) => {
    const error = await failJson(argv);
    expect(error.code).toBe(code);
    expect(methods.every((method) => READ_METHODS.has(method))).toBe(true);
  });

  it.each([
    [['messages', 'draft', '--recipient-id', 'C0123456789', '--message', 'hi']],
    [['messages', 'send-draft', 'Dr0123456789']],
    [['messages', 'delete-draft', 'Dr0123456789']],
  ])('%j on an app token fails as browser-only', async (argv) => {
    const error = await failJson(argv, STANDARD);
    expect(error.code).toBe('unsupported_auth_type');
    expect(error.message).toContain('requires browser authentication');
    expect(methods).toEqual([]);
  });

  it('reports the same validation failure in text mode with exit 1', async () => {
    await run(['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi', '--blocks', '{nope', '--dry-run']);
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toContain('Dry run');
    expect(stderr).toContain('Invalid blocks JSON');
  });

  it('still refuses the real write unattended without --yes', async () => {
    await run(['usergroups', 'disable', 'S0123456789', '--json']);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('confirmation_required');
    expect(methods).toEqual([]);
  });
});
