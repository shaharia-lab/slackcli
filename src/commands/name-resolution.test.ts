// Channel names and user handles/emails resolve to IDs in every command that
// takes an ID (#327). In-process, with the Slack client stubbed and every call
// recorded, so a test can prove which ID a write used — and that an ID or a
// link makes no lookup call at all.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Command } from 'commander';
import * as authLib from '../lib/auth.ts';
import { createCanvasCommand } from './canvas.ts';
import { createConversationsCommand } from './conversations.ts';
import { createMessagesCommand } from './messages.ts';
import { createUsergroupsCommand } from './usergroups.ts';
import { createUsersCommand } from './users.ts';

const GENERAL = { id: 'C0000000001', name: 'general' };
const ALICE = { id: 'U0000000001', name: 'alice' };
const DEPLOY_CHANNEL = { id: 'C0000000005', name: 'deploy' };
const DEPLOY_BOT = { id: 'U0000000005', name: 'deploy' };

type Call = { method: string; args: unknown[] };

// Answers for the methods these commands use; anything else returns { ok: true }.
function recordingClient(overrides: { channels?: any[]; users?: any[]; groupUsers?: string[] } = {}) {
  const calls: Call[] = [];
  const answers: Record<string, (...args: any[]) => unknown> = {
    listConversations: () => ({ ok: true, channels: overrides.channels ?? [GENERAL, DEPLOY_CHANNEL] }),
    listUsers: () => ({ ok: true, members: overrides.users ?? [ALICE, DEPLOY_BOT] }),
    lookupUserByEmail: (email: string) => {
      if (email === 'alice@example.com') return { ok: true, user: ALICE };
      throw Object.assign(new Error('Slack API error: users_not_found'), {
        slackData: { ok: false, error: 'users_not_found' },
      });
    },
    openConversation: () => ({ ok: true, channel: { id: 'D0000000001' } }),
    postMessage: () => ({ ok: true, ts: '1712345678.000100' }),
    getPermalink: () => ({ ok: true, permalink: 'https://acme.slack.com/archives/C0000000001/p1712345678000100' }),
    updateMessage: () => ({ ok: true, ts: '1712345678.000100' }),
    createDraft: () => ({ ok: true, draft: { id: 'Dr0000000001' } }),
    getConversationHistory: () => ({ ok: true, messages: [] }),
    getConversationMembers: () => ({ ok: true, members: ['U0000000001'] }),
    leaveConversation: () => ({ ok: true }),
    joinConversation: () => ({ ok: true, channel: { id: 'C0000000001' } }),
    listCanvases: () => ({ ok: true, files: [] }),
    getChannelCanvasId: () => null,
    getUserInfo: (id: string) => ({ ok: true, user: { id, name: 'alice' } }),
    listUsergroups: () => ({ ok: true, usergroups: [{ id: 'S0000000001', name: 'Platform', handle: 'platform' }] }),
    listUsergroupUsers: () => ({ ok: true, users: overrides.groupUsers ?? ['U0000000009'] }),
    setUsergroupUsers: () => ({ ok: true, usergroup: { id: 'S0000000001' } }),
  };
  const client = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'workspaceHost') return 'acme.slack.com';
      return async (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        const answer = answers[String(prop)];
        return answer ? answer(...args) : { ok: true };
      };
    },
  });
  return { client, calls, methods: () => calls.map((c) => c.method) };
}

const factories: Record<string, () => Command> = {
  canvas: createCanvasCommand,
  conversations: createConversationsCommand,
  messages: createMessagesCommand,
  usergroups: createUsergroupsCommand,
  users: createUsersCommand,
};

describe('name resolution in commands', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;
  let getClient: ReturnType<typeof spyOn>;

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

  async function run(argv: string[], stub = recordingClient()) {
    getClient = spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub.client as any);
    const [group, ...rest] = argv;
    await factories[group]().parseAsync(rest, { from: 'user' });
    return stub;
  }

  function json(): any {
    return JSON.parse(stdout);
  }

  function lastError(): any {
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).error;
  }

  describe('messages send', () => {
    it.each([['--recipient-id=#general'], ['--recipient-id=general']])(
      '%s posts to the channel ID and reports it',
      async (flag) => {
        const stub = await run(['messages', 'send', flag, '--message', 'Deploy done', '--json']);
        const post = stub.calls.find((c) => c.method === 'postMessage');
        expect(post?.args[0]).toBe('C0000000001');
        expect(json()).toMatchObject({ channel_id: 'C0000000001', ts: '1712345678.000100' });
        expect(process.exitCode).toBe(0);
      },
    );

    it.each([['@alice'], ['alice@example.com']])('%s opens a DM with the resolved user', async (recipient) => {
      const stub = await run(['messages', 'send', '--recipient-id', recipient, '--message', 'ping', '--json']);
      expect(stub.calls.find((c) => c.method === 'openConversation')?.args[0]).toBe('U0000000001');
      expect(stub.calls.find((c) => c.method === 'postMessage')?.args[0]).toBe('D0000000001');
      expect(json().channel_id).toBe('D0000000001');
    });

    it('makes no lookup call for an ID or a link, exactly as before', async () => {
      const byId = await run(['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi', '--json']);
      expect(byId.methods()).toEqual(['postMessage', 'getPermalink']);
      mock.restore();
      stdout = '';
      const byLink = await run([
        'messages', 'send', '--recipient-id', 'https://acme.slack.com/archives/C0123456789', '--message', 'hi', '--json',
      ]);
      expect(byLink.methods()).toEqual(['postMessage', 'getPermalink']);
    });

    it('sends nothing and exits 1 for an unknown name', async () => {
      const stub = await run(['messages', 'send', '--recipient-id=#nope', '--message', 'hi', '--json']);
      expect(process.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(lastError()).toMatchObject({ code: 'not_found' });
      expect(lastError().hint).toContain('slackcli search channels');
      expect(stub.methods()).not.toContain('postMessage');
    });

    it('sends nothing for a bare name that is both a channel and a user', async () => {
      const stub = await run(['messages', 'send', '--recipient-id', 'deploy', '--message', 'hi', '--json']);
      expect(process.exitCode).toBe(1);
      const error = lastError();
      expect(error.code).toBe('invalid_input');
      expect(error.message).toContain('C0000000005');
      expect(error.message).toContain('U0000000005');
      expect(stub.methods()).not.toContain('postMessage');
      expect(stub.methods()).not.toContain('openConversation');
    });
  });

  it('messages draft resolves --recipient-id', async () => {
    const stub = await run(['messages', 'draft', '--recipient-id=#general', '--message', 'hi', '--json']);
    expect(stub.calls.find((c) => c.method === 'createDraft')?.args[0]).toBe('C0000000001');
    expect(json().channel_id).toBe('C0000000001');
  });

  it('messages edit resolves --channel-id and reports the ID', async () => {
    const stub = await run([
      'messages', 'edit', '--channel-id', 'general', '--timestamp', '1712345678.000100', '--message', 'fixed', '--json',
    ]);
    expect(stub.calls.find((c) => c.method === 'updateMessage')?.args[0]).toBe('C0000000001');
    expect(json().channel_id).toBe('C0000000001');
  });

  it('messages react resolves --channel-id', async () => {
    const stub = await run([
      'messages', 'react', '--channel-id=#general', '--timestamp', '1712345678.000100', '--emoji', 'eyes',
    ]);
    expect(stub.calls.find((c) => c.method === 'addReaction')?.args[0]).toBe('C0000000001');
  });

  it('conversations read <name> reads the channel ID and reports it', async () => {
    const stub = await run(['conversations', 'read', 'general', '--limit', '20', '--json']);
    expect(stub.calls.find((c) => c.method === 'getConversationHistory')?.args[0]).toBe('C0000000001');
    expect(json().channel_id).toBe('C0000000001');
  });

  it('conversations read <ID> makes no lookup call', async () => {
    const stub = await run(['conversations', 'read', 'C0123456789', '--json']);
    expect(stub.methods()).toEqual(['getConversationHistory']);
  });

  it('conversations get resolves <channel-id>', async () => {
    const stub = await run(['conversations', 'get', '#general', '1712345678.000100', '--json']);
    expect(stub.methods()).toContain('listConversations');
    expect(stub.calls.find((c) => c.method !== 'listConversations')?.args[0]).toBe('C0000000001');
  });

  it('conversations members list resolves <channel>', async () => {
    const stub = await run(['conversations', 'members', 'list', 'general', '--json']);
    expect(stub.calls.find((c) => c.method === 'getConversationMembers')?.args[0]).toBe('C0000000001');
    expect(json().channel_id).toBe('C0000000001');
  });

  it('conversations members add resolves the channel and every user before writing', async () => {
    const stub = await run([
      'conversations', 'members', 'add', '#general', '@alice,U0123456789', 'alice@example.com', '--yes', '--json',
    ]);
    const invite = stub.calls.find((c) => c.method === 'inviteToConversation');
    expect(invite?.args.slice(0, 2)).toEqual(['C0000000001', 'U0000000001,U0123456789,U0000000001']);
    expect(json()).toEqual({ channel_id: 'C0000000001', added: ['U0000000001', 'U0123456789', 'U0000000001'] });
    expect(getClient).toHaveBeenCalledTimes(1);
  });

  it('conversations members add with IDs refuses unconfirmed writes without authenticating, as before', async () => {
    const stub = await run(['conversations', 'members', 'add', 'C0123456789', 'U0123456789', '--json']);
    expect(lastError().code).toBe('confirmation_required');
    expect(getClient).not.toHaveBeenCalled();
    expect(stub.calls).toEqual([]);
  });

  it('conversations members add with a name resolves, then still refuses an unconfirmed write', async () => {
    const stub = await run(['conversations', 'members', 'add', 'general', '@alice', '--json']);
    expect(lastError().code).toBe('confirmation_required');
    expect(stub.methods()).not.toContain('inviteToConversation');
  });

  it('conversations members add stops before any write when a user is unknown', async () => {
    const stub = await run(['conversations', 'members', 'add', 'general', '@ghost', '--yes', '--json']);
    expect(process.exitCode).toBe(1);
    expect(lastError().code).toBe('not_found');
    expect(stub.methods()).not.toContain('inviteToConversation');
  });

  it('conversations members remove resolves the channel and users', async () => {
    const stub = await run(['conversations', 'members', 'remove', 'general', '@alice', '--yes', '--json']);
    const kick = stub.calls.find((c) => c.method === 'kickFromConversation');
    expect(kick?.args.slice(0, 2)).toEqual(['C0000000001', 'U0000000001']);
    expect(json()).toMatchObject({ channel_id: 'C0000000001', removed: ['U0000000001'] });
  });

  it('conversations join resolves <channel>', async () => {
    const stub = await run(['conversations', 'join', '#general', '--json']);
    expect(stub.calls.find((c) => c.method === 'joinConversation')?.args[0]).toBe('C0000000001');
  });

  it('conversations join reports an unknown name', async () => {
    const stub = await run(['conversations', 'join', '#nope', '--json']);
    expect(lastError().code).toBe('not_found');
    expect(stub.methods()).not.toContain('joinConversation');
  });

  it('conversations leave resolves <channel> before its confirmation', async () => {
    const stub = await run(['conversations', 'leave', 'general', '--yes', '--json']);
    expect(stub.calls.find((c) => c.method === 'leaveConversation')?.args[0]).toBe('C0000000001');
    expect(json().channel_id).toBe('C0000000001');
  });

  it('conversations leave reports an unknown name without leaving anything', async () => {
    const stub = await run(['conversations', 'leave', 'nope', '--yes', '--json']);
    expect(lastError().code).toBe('not_found');
    expect(stub.methods()).not.toContain('leaveConversation');
  });

  it('canvas list resolves --channel', async () => {
    const stub = await run(['canvas', 'list', '--channel', 'general', '--json']);
    expect(stub.calls.find((c) => c.method === 'listCanvases')?.args[0]).toMatchObject({ channel: 'C0000000001' });
  });

  it('canvas read resolves --channel', async () => {
    const stub = await run(['canvas', 'read', '--channel=#general', '--json']);
    expect(stub.calls.find((c) => c.method === 'getChannelCanvasId')?.args[0]).toBe('C0000000001');
  });

  it('canvas list with a channel ID makes no lookup call', async () => {
    const stub = await run(['canvas', 'list', '--channel', 'C0123456789', '--json']);
    expect(stub.methods()).toEqual(['listCanvases']);
  });

  it.each([['@alice'], ['alice'], ['alice@example.com']])('users info %s fetches the resolved user', async (ref) => {
    const stub = await run(['users', 'info', ref, '--json']);
    expect(stub.calls.find((c) => c.method === 'getUserInfo')?.args[0]).toBe('U0000000001');
    expect(json().id).toBe('U0000000001');
  });

  it('users info <ID> makes no lookup call', async () => {
    const stub = await run(['users', 'info', 'U0123456789', '--json']);
    expect(stub.methods()).toEqual(['getUserInfo']);
  });

  it('users info @<ID> fetches the ID without the @ and without a lookup', async () => {
    const stub = await run(['users', 'info', '@U0123456789', '--json']);
    expect(stub.calls).toEqual([{ method: 'getUserInfo', args: ['U0123456789'] }]);
  });

  it('messages send --recipient-id=@<ID> opens the DM with the bare ID and no lookup', async () => {
    const stub = await run(['messages', 'send', '--recipient-id=@U0123456789', '--message', 'hi', '--json']);
    expect(stub.methods()).toEqual(['openConversation', 'postMessage', 'getPermalink']);
    expect(stub.calls[0].args[0]).toBe('U0123456789');
  });

  it('conversations read #<ID> reads the bare ID', async () => {
    const stub = await run(['conversations', 'read', '#C0123456789', '--json']);
    expect(stub.calls).toEqual([expect.objectContaining({ method: 'getConversationHistory', args: ['C0123456789', expect.anything()] })]);
  });

  it('users info reports an unknown email as not found', async () => {
    await run(['users', 'info', 'ghost@example.com', '--json']);
    expect(lastError().code).toBe('not_found');
  });

  it('usergroups add resolves handles and emails to IDs', async () => {
    const stub = await run(['usergroups', 'add', 'S0000000001', '@alice', '--yes', '--json']);
    const set = stub.calls.find((c) => c.method === 'setUsergroupUsers');
    expect(set?.args.slice(0, 2)).toEqual(['S0000000001', 'U0000000009,U0000000001']);
    expect(getClient).toHaveBeenCalledTimes(1);
  });

  it('usergroups remove resolves an email to the user ID it removes', async () => {
    const stub = await run(
      ['usergroups', 'remove', 'S0000000001', 'alice@example.com', '--yes', '--json'],
      recordingClient({ groupUsers: ['U0000000009', 'U0000000001'] }),
    );
    expect(stub.calls.find((c) => c.method === 'setUsergroupUsers')?.args.slice(0, 2))
      .toEqual(['S0000000001', 'U0000000009']);
    expect(json()).toMatchObject({ usergroup: 'S0000000001', removed: ['U0000000001'] });
  });

  it('usergroups add with IDs refuses an unconfirmed write without authenticating', async () => {
    await run(['usergroups', 'add', 'S0000000001', 'U0123456789', '--json']);
    expect(lastError().code).toBe('confirmation_required');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('usergroups add stops before any write when a user is unknown', async () => {
    const stub = await run(['usergroups', 'add', 'S0000000001', '@ghost', '--yes', '--json']);
    expect(lastError().code).toBe('not_found');
    expect(stub.methods()).not.toContain('setUsergroupUsers');
  });
});
