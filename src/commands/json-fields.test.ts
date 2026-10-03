// `--fields` on the read commands (#330), in process with the Slack client
// stubbed: the projection reaches stdout, the envelope survives, output
// without --fields is untouched, and a bad --fields fails before any call.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Command } from 'commander';
import * as authLib from '../lib/auth.ts';
import { FIELDS_LIST_KEYS } from '../lib/json-fields.ts';
import { createCanvasCommand } from './canvas.ts';
import { createConversationsCommand } from './conversations.ts';
import { createEmojiCommand } from './emoji.ts';
import { createFilesCommand } from './files.ts';
import { createMessagesCommand } from './messages.ts';
import { createSavedCommand } from './saved.ts';
import { createSearchCommand } from './search.ts';
import { createTeamCommand } from './team.ts';
import { createUsergroupsCommand } from './usergroups.ts';
import { createUsersCommand } from './users.ts';

const factories: Record<string, () => Command> = {
  canvas: createCanvasCommand,
  conversations: createConversationsCommand,
  emoji: createEmojiCommand,
  files: createFilesCommand,
  messages: createMessagesCommand,
  saved: createSavedCommand,
  search: createSearchCommand,
  team: createTeamCommand,
  usergroups: createUsergroupsCommand,
  users: createUsersCommand,
};

const USER = {
  id: 'U0123456789',
  name: 'alice',
  real_name: 'Alice',
  tz: 'Europe/Berlin',
  deleted: false,
  profile: { email: 'alice@example.com', title: 'Engineer', phone: '' },
};

const MESSAGES = [
  { ts: '1712345678.000300', user: 'U0123456789', text: 'third', type: 'message', blocks: [{ type: 'rich_text' }] },
  { ts: '1712345678.000200', user: 'U0123456789', text: 'second', type: 'message', reactions: [{ name: 'tada', count: 1 }] },
  { ts: '1712345678.000100', bot_id: 'B0123456789', text: 'first', type: 'message' },
];

// Canned answers per client method; anything else answers `{ ok: true }`.
const ANSWERS: Record<string, unknown> = {
  getConversationHistory: { ok: true, messages: MESSAGES, has_more: false },
  getConversationReplies: { ok: true, messages: MESSAGES, has_more: false },
  listMessages: { ok: true, messages: { C0123456789: [MESSAGES[1]] } },
  getUsersInfo: { ok: true, users: [USER] },
  getUserInfo: { ok: true, user: USER },
  listConversations: {
    ok: true,
    channels: [
      { id: 'C0123456789', name: 'general', is_channel: true, is_member: true, num_members: 3, topic: { value: 't' } },
      { id: 'D0123456789', is_im: true, user: 'U0123456789' },
    ],
    response_metadata: { next_cursor: 'dXNlcjpVMDYxTkZUVDI=' },
  },
  listUsers: { ok: true, members: [USER], response_metadata: { next_cursor: '' } },
  getTeamInfo: { ok: true, team: { id: 'T0123456789', name: 'Acme', domain: 'acme', icon: { image_34: 'x' } } },
  listUsergroups: {
    ok: true,
    usergroups: [{ id: 'S0123456789', handle: 'platform', name: 'Platform', user_count: 2, prefs: { channels: [] } }],
  },
  getConversationInfo: { ok: true, channel: { id: 'C0123456789', name: 'general' } },
  getFileInfo: {
    ok: true,
    file: {
      id: 'F0123456789',
      name: 'notes.txt',
      title: 'Notes',
      mimetype: 'text/plain',
      filetype: 'text',
      size: 5,
      url_private: 'https://files.slack.com/files-pri/T0123456789-F0123456789/notes.txt',
      permalink: 'https://acme.slack.com/files/U0123456789/F0123456789/notes.txt',
    },
  },
  downloadFile: '<h1>Notes</h1><p>hello</p>',
  listCanvases: { ok: true, files: [{ id: 'F0123456789', title: 'Notes', created: 1712345678, size: 5, permalink: 'p' }] },
  listEmoji: { ok: true, emoji: { party: 'https://emoji.example.com/party.png', fiesta: 'alias:party' } },
  getUnreadCounts: { ok: true, channels: [{ id: 'C0123456789', has_unreads: true, mention_count: 2 }] },
  listSavedItems: {
    ok: true,
    items: [{ type: 'message', channel: 'C0123456789', message: { ts: '1712345678.000100', user: 'U0123456789', text: 'saved' } }],
  },
  listDrafts: {
    ok: true,
    drafts: [{
      id: 'Dr0123456789',
      date_created: 1712345678,
      destinations: [{ channel_id: 'C0123456789' }],
      blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hi' }] }] }],
    }],
  },
  searchModules: {
    ok: true,
    items: [{ id: 'U0123456789', name: 'alice', real_name: 'Alice', profile: { email: 'alice@example.com' } }],
    pagination: { total_count: 1 },
  },
  listUsergroupUsers: { ok: true, users: ['U0123456789'] },
  searchMessages: {
    ok: true,
    messages: {
      total: 1,
      pagination: { page: 1, page_count: 1 },
      matches: [{ ts: '1712345678.000100', user: 'U0123456789', text: 'deploy', channel: { id: 'C0123456789', name: 'general' }, permalink: 'p' }],
    },
  },
};

function stubClient(): unknown {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'workspaceHost') return 'acme.slack.com';
      if (prop === 'authType') return 'browser';
      return async () => structuredClone(ANSWERS[prop as string] ?? { ok: true });
    },
  });
}

describe('--fields, in process', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;
  let getClient: ReturnType<typeof spyOn>;

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
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
    getClient = spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stubClient() as any);
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(argv: string[]): Promise<any> {
    const [group, ...rest] = argv;
    await factories[group]().parseAsync(rest, { from: 'user' });
    expect({ exitCode: process.exitCode, stderr: process.exitCode ? stderr : '' }).toEqual({ exitCode: 0, stderr: '' });
    return JSON.parse(stdout);
  }

  it('conversations read keeps only the requested message fields, in order and count', async () => {
    const full = await run(['conversations', 'read', 'C0123456789', '--json']);
    stdout = '';
    const out = await run(['conversations', 'read', 'C0123456789', '--json', '--fields', 'ts,user,text']);

    expect(out.messages).toEqual([
      { ts: '1712345678.000100', text: 'first' },
      { ts: '1712345678.000200', user: 'U0123456789', text: 'second' },
      { ts: '1712345678.000300', user: 'U0123456789', text: 'third' },
    ]);
    expect(out.messages.map((m: any) => m.ts)).toEqual(full.messages.map((m: any) => m.ts));
    // The envelope is unchanged.
    const { messages: _a, ...envelope } = out;
    const { messages: _b, ...fullEnvelope } = full;
    expect(envelope).toEqual(fullEnvelope);
    expect(Object.keys(out)).toEqual(Object.keys(full));
  });

  it('without --fields prints the full payload, pretty-printed as before', async () => {
    await run(['conversations', 'read', 'C0123456789', '--json']);
    const parsed = JSON.parse(stdout);
    expect(stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(parsed.messages[2]).toEqual({
      ts: '1712345678.000300',
      user: 'U0123456789',
      text: 'third',
      type: 'message',
      blocks: [{ type: 'rich_text' }],
    });
  });

  it('users info projects the record itself, keeping nesting for dot paths', async () => {
    const out = await run(['users', 'info', 'U0123456789', '--json', '--fields', 'id,profile.email,nope']);
    expect(out).toEqual({ id: 'U0123456789', profile: { email: 'alice@example.com' } });
  });

  it('conversations get projects the message and keeps channel_id and users', async () => {
    const out = await run(['conversations', 'get', 'C0123456789', '1712345678.000200', '--json', '--fields', 'text']);
    expect(out.channel_id).toBe('C0123456789');
    expect(out.message).toEqual({ text: expect.any(String) });
    expect(Array.isArray(out.users)).toBe(true);
  });

  it.each([
    [['conversations', 'list'], 'id,name', ['conversation_count', 'conversations', 'users', 'next_cursor']],
    [['users', 'list'], 'id,email', ['total', 'status', 'users']],
    [['usergroups', 'list'], 'id,handle', ['usergroup_count', 'usergroups']],
    [['search', 'messages', 'deploy'], 'ts,channel.name', ['query', 'total', 'page', 'pages', 'matches']],
  ])('%j keeps the envelope and projects its list', async (argv, fields, keys) => {
    const out = await run([...argv, '--json', '--fields', fields]);
    expect(Object.keys(out)).toEqual(keys);
    const listKey = FIELDS_LIST_KEYS[argv.slice(0, 2).join(' ') as keyof typeof FIELDS_LIST_KEYS] as string;
    const allowed = new Set(fields.split(',').map((f) => f.split('.')[0]));
    expect(out[listKey].length).toBeGreaterThan(0);
    for (const item of out[listKey]) {
      for (const key of Object.keys(item)) expect(allowed.has(key)).toBe(true);
    }
  });

  it('keeps next_cursor on conversations list', async () => {
    const out = await run(['conversations', 'list', '--json', '--fields', 'id']);
    expect(out.next_cursor).toBe('dXNlcjpVMDYxTkZUVDI=');
    expect(out.conversations).toEqual([{ id: 'C0123456789' }, { id: 'D0123456789' }]);
  });

  it('team info projects the record', async () => {
    const out = await run(['team', 'info', '--json', '--fields', 'name,icon.image_34']);
    expect(out).toEqual({ name: 'Acme', icon: { image_34: 'x' } });
  });

  // Every --fields command, with the argument it needs.
  const COMMAND_ARGS: Record<string, string[]> = {
    'canvas read': ['F0123456789'],
    'conversations get': ['C0123456789', '1712345678.000100'],
    'conversations read': ['C0123456789'],
    'emoji get': ['party'],
    'files info': ['F0123456789'],
    'files read': ['F0123456789'],
    'search channels': ['deploy'],
    'search messages': ['deploy'],
    'search people': ['alice'],
    'usergroups read': ['S0123456789'],
    'users info': ['U0123456789'],
  };
  const commands = Object.keys(FIELDS_LIST_KEYS).map((path) => [path, [...path.split(' '), ...(COMMAND_ARGS[path] ?? [])]] as const);

  // One real field of each command's items (or record). A list key in
  // FIELDS_LIST_KEYS that does not match what the command prints would leave
  // the payload unprojected, and fail here.
  const PROBE: Record<keyof typeof FIELDS_LIST_KEYS, string> = {
    'canvas list': 'id',
    'canvas read': 'markdown',
    'conversations get': 'ts',
    'conversations list': 'id',
    'conversations read': 'ts',
    'conversations unread': 'id',
    'emoji get': 'name',
    'emoji list': 'name',
    'files info': 'id',
    'files read': 'content',
    'messages list-drafts': 'draft_id',
    'saved list': 'type',
    'search channels': 'id',
    'search messages': 'ts',
    'search people': 'id',
    'team info': 'id',
    'usergroups list': 'id',
    'usergroups read': 'id',
    'users info': 'id',
    'users list': 'id',
  };

  it.each(commands)('%s prints only the requested field of its items', async (path, argv) => {
    const field = PROBE[path as keyof typeof FIELDS_LIST_KEYS];
    const full = await run([...argv, '--json']);
    stdout = '';
    const out = await run([...argv, '--json', '--fields', field]);

    const listKey = FIELDS_LIST_KEYS[path as keyof typeof FIELDS_LIST_KEYS];
    if (listKey === null) {
      expect(Object.keys(full).length).toBeGreaterThan(1);
      expect(Object.keys(out)).toEqual([field]);
      expect(out[field]).toEqual(full[field]);
      return;
    }
    expect(Object.keys(out)).toEqual(Object.keys(full));
    const items = [out[listKey]].flat();
    const fullItems = [full[listKey]].flat();
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBe(fullItems.length);
    items.forEach((item: Record<string, unknown>, i: number) => {
      expect(Object.keys(fullItems[i]).length).toBeGreaterThan(1);
      expect(item).toEqual({ [field]: fullItems[i][field] });
    });
    // Everything outside the list is what it was.
    for (const key of Object.keys(full)) {
      if (key !== listKey) expect(out[key]).toEqual(full[key]);
    }
  });

  async function runFailing(argv: string[], extra: string[]) {
    const [group, ...rest] = argv;
    await factories[group]().parseAsync([...rest, ...extra], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(getClient).not.toHaveBeenCalled();
  }

  it.each(commands)('%s refuses --fields without --json before any Slack call', async (_path, argv) => {
    await runFailing([...argv], ['--fields', 'id']);
    expect(stderr).toContain('--fields only applies to --json output; add --json');
  });

  it.each(commands)('%s reports a malformed --fields as invalid_input under --json', async (_path, argv) => {
    await runFailing([...argv], ['--json', '--fields', 'id,,name']);
    const lines = stderr.trimEnd().split('\n');
    const error = JSON.parse(lines[lines.length - 1]).error;
    expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect(error.message).toContain('Invalid --fields entry');
  });

  it('reports an empty --fields value', async () => {
    await runFailing(['team', 'info'], ['--json', '--fields', '']);
    expect(stderr).toContain('--fields needs at least one field name');
  });
});
