import { describe, expect, it } from 'bun:test';
import { InvalidInputError, NotFoundError } from './cli-errors.ts';
import { classifyError } from './command-errors.ts';
import {
  type NameLookupClient,
  parseNameReference,
  lazyClient,
  resolveIdentifier,
  resolveUserList,
} from './name-resolver.ts';
import { SlackUrlParseError } from './slack-url-parser.ts';

interface StubData {
  channelPages?: any[][];
  userPages?: any[][];
  emails?: Record<string, string>;
  emailError?: string;
}

// A lookup client over fixed pages, recording every call it receives.
function stubClient(data: StubData = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const page = (pages: any[][], key: string, params: any) => {
    const index = params.cursor ? Number(params.cursor.replace('c', '')) : 0;
    const next = index + 1 < pages.length ? `c${index + 1}` : '';
    return { ok: true, [key]: pages[index] ?? [], response_metadata: { next_cursor: next } };
  };
  const client: NameLookupClient = {
    async listConversations(params) {
      calls.push({ method: 'conversations.list', params });
      return page(data.channelPages ?? [[]], 'channels', params);
    },
    async listUsers(params) {
      calls.push({ method: 'users.list', params });
      return page(data.userPages ?? [[]], 'members', params);
    },
    async lookupUserByEmail(email) {
      calls.push({ method: 'users.lookupByEmail', params: { email } });
      if (data.emailError) {
        throw Object.assign(new Error(`Slack API error: ${data.emailError}`), {
          slackData: { ok: false, error: data.emailError },
        });
      }
      const id = data.emails?.[email];
      if (!id) {
        throw Object.assign(new Error('Slack API error: users_not_found'), {
          slackData: { ok: false, error: 'users_not_found' },
        });
      }
      return { ok: true, user: { id } };
    },
  };
  return { client, calls };
}

const GENERAL = { id: 'C0000000001', name: 'general' };
const RANDOM = { id: 'C0000000002', name: 'random' };
const ALICE = { id: 'U0000000001', name: 'alice' };
const BOB = { id: 'U0000000002', name: 'bob' };

describe('parseNameReference', () => {
  it.each([
    ['#general', 'channel', { kind: 'channel', name: 'general' }],
    ['general', 'channel', { kind: 'channel', name: 'general' }],
    ['  <#general>  ', 'channel', { kind: 'channel', name: 'general' }],
    ['@alice', 'user', { kind: 'user', handle: 'alice' }],
    ['alice', 'user', { kind: 'user', handle: 'alice' }],
    ['alice@example.com', 'user', { kind: 'email', email: 'alice@example.com' }],
    ['general', 'channel-or-user', { kind: 'channel-or-user', name: 'general' }],
    ['#general', 'channel-or-user', { kind: 'channel', name: 'general' }],
    ['@alice', 'channel-or-user', { kind: 'user', handle: 'alice' }],
    ['alice@example.com', 'channel-or-user', { kind: 'email', email: 'alice@example.com' }],
    // Whitespace between the prefix and the name is dropped.
    ['# general', 'channel', { kind: 'channel', name: 'general' }],
    ['@ alice', 'user', { kind: 'user', handle: 'alice' }],
    ['<@alice>', 'channel-or-user', { kind: 'user', handle: 'alice' }],
  ] as const)('%p as %s -> %j', (input, expected, result) => {
    expect(parseNameReference(input, expected)).toEqual(result as any);
  });

  it.each([
    ['C0123456789', 'channel'],
    ['G0123456789', 'channel'],
    ['D0123456789', 'channel-or-user'],
    ['U0123456789', 'user'],
    ['W0123456789', 'channel-or-user'],
    ['@U0123456789', 'user'],
    ['#C0123456789', 'channel'],
    // Upper-case ID shapes identifierKind() does not classify (app, bot IDs).
    ['A0123456789', 'user'],
    ['B0123456789', 'user'],
    ['https://acme.slack.com/archives/C0123456789', 'channel'],
    ['https://acme.slack.com/archives/general', 'channel'],
    ['<https://acme.slack.com/team/U0123456789>', 'user'],
    ['', 'channel'],
    ['   ', 'channel'],
    ['#', 'channel'],
    ['@', 'user'],
    ['report', 'file'],
    // A prefix the argument does not take is not a name for it.
    ['#general', 'user'],
    ['@alice', 'channel'],
    ['alice@example.com', 'channel'],
    // An ID stays an ID with whitespace after its prefix, and for either kind.
    ['@ U0123456789', 'user'],
    ['#C0123456789', 'channel-or-user'],
    ['@U0123456789', 'channel-or-user'],
    ['#   ', 'channel-or-user'],
    // File arguments never take a name, whatever the form.
    ['#general', 'file'],
    ['@alice', 'file'],
    ['alice@example.com', 'file'],
  ] as const)('%p as %s is not a name', (input, expected) => {
    expect(parseNameReference(input, expected)).toBeNull();
  });
});

describe('resolveIdentifier: channels', () => {
  it('resolves an exact name with or without #, case-insensitively', async () => {
    for (const input of ['#general', 'general', 'General', '#General']) {
      const { client } = stubClient({ channelPages: [[RANDOM, GENERAL]] });
      expect(await resolveIdentifier(client, input, input, 'channel', '--channel')).toBe('C0000000001');
    }
  });

  it('asks for public and private, non-archived channels in large pages', async () => {
    const { client, calls } = stubClient({ channelPages: [[GENERAL]] });
    await resolveIdentifier(client, 'general', 'general', 'channel', '--channel');
    expect(calls).toEqual([{
      method: 'conversations.list',
      params: { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000 },
    }]);
  });

  it('never matches a partial name', async () => {
    const { client } = stubClient({ channelPages: [[{ id: 'C0000000003', name: 'general-chat' }]] });
    await expect(resolveIdentifier(client, 'general', 'general', 'channel', '--channel')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads every page, following the cursor, and finds a match on a later page', async () => {
    const { client, calls } = stubClient({ channelPages: [[RANDOM], [], [GENERAL]] });
    expect(await resolveIdentifier(client, '#general', '#general', 'channel', '--channel')).toBe('C0000000001');
    expect(calls.map((c) => c.params.cursor)).toEqual([undefined, 'c1', 'c2']);
  });

  it('reports an ambiguous name with every candidate ID, even across pages', async () => {
    const twin = { id: 'C0000000009', name: 'General' };
    const { client } = stubClient({ channelPages: [[GENERAL], [twin]] });
    const err = await resolveIdentifier(client, 'general', 'general', 'channel', '--channel').catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain('C0000000001');
    expect(err.message).toContain('C0000000009');
    expect(classifyError(err).code).toBe('invalid_input');
  });

  it('reports an unknown name, naming the input and suggesting search channels', async () => {
    const { client } = stubClient({ channelPages: [[RANDOM]] });
    const err = await resolveIdentifier(client, '#nope', '#nope', 'channel', '--recipient-id').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('--recipient-id');
    expect(err.message).toContain('"#nope"');
    expect(err.hint).toContain('slackcli search channels');
    expect(classifyError(err).code).toBe('not_found');
  });

  it('stops when Slack hands back a cursor it already gave', async () => {
    let calls = 0;
    const client = {
      async listConversations() {
        calls += 1;
        return { channels: [], response_metadata: { next_cursor: 'same' } };
      },
    } as unknown as NameLookupClient;
    await expect(resolveIdentifier(client, 'general', 'general', 'channel', '--channel')).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toBe(2);
  });

  it('copes with pages missing channels or metadata', async () => {
    const client = { async listConversations() { return {}; } } as unknown as NameLookupClient;
    await expect(resolveIdentifier(client, 'general', 'general', 'channel', '--channel')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports progress per page', async () => {
    const { client } = stubClient({ channelPages: [[RANDOM], [GENERAL]] });
    const seen: string[] = [];
    await resolveIdentifier(client, 'general', 'general', 'channel', '--channel', { onProgress: (m) => seen.push(m) });
    expect(seen).toEqual(['Looking up channel name (page 1)...', 'Looking up channel name (page 2)...']);
  });

  it('returns an ID or URL as given, and an ID without its # or @, with no call', async () => {
    const { client, calls } = stubClient();
    expect(await resolveIdentifier(client, 'C0123456789', 'C0123456789', 'channel', '--channel')).toBe('C0123456789');
    expect(await resolveIdentifier(client, '#C0123456789', '#C0123456789', 'channel', '--channel')).toBe('C0123456789');
    expect(await resolveIdentifier(client, ' <#C0123456789> ', '#C0123456789', 'channel', '--channel')).toBe('C0123456789');
    expect(await resolveIdentifier(
      client, 'https://acme.slack.com/archives/C0123456789', 'C0123456789', 'channel', '--channel',
    )).toBe('C0123456789');
    expect(calls).toEqual([]);
    // A prefixed ID of the wrong kind is reported, not sent.
    await expect(resolveIdentifier(client, '@U0123456789', '@U0123456789', 'channel', '--channel'))
      .rejects.toBeInstanceOf(SlackUrlParseError);
  });
});

describe('resolveIdentifier: users', () => {
  it('resolves an exact handle with or without @, case-insensitively', async () => {
    for (const input of ['@alice', 'alice', '@Alice']) {
      const { client } = stubClient({ userPages: [[BOB, ALICE]] });
      expect(await resolveIdentifier(client, input, input, 'user', '<user>')).toBe('U0000000001');
    }
  });

  it('does not match a display or real name', async () => {
    const { client } = stubClient({
      userPages: [[{ id: 'U0000000003', name: 'asmith', real_name: 'alice', profile: { display_name: 'alice' } }]],
    });
    await expect(resolveIdentifier(client, '@alice', '@alice', 'user', '<user>')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('prefers the active account when a handle survives on a deactivated one', async () => {
    const gone = { id: 'U0000000009', name: 'alice', deleted: true };
    const { client } = stubClient({ userPages: [[gone], [ALICE]] });
    expect(await resolveIdentifier(client, '@alice', '@alice', 'user', '<user>')).toBe('U0000000001');
  });

  it('still resolves a handle held only by a deactivated account', async () => {
    const gone = { id: 'U0000000009', name: 'alice', deleted: true };
    const { client } = stubClient({ userPages: [[gone]] });
    expect(await resolveIdentifier(client, '@alice', '@alice', 'user', '<user>')).toBe('U0000000009');
  });

  it('reports two active accounts with one handle as ambiguous', async () => {
    const twin = { id: 'U0000000008', name: 'alice' };
    const { client } = stubClient({ userPages: [[ALICE, twin]] });
    const err = await resolveIdentifier(client, '@alice', '@alice', 'user', '<user>').catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain('U0000000001');
    expect(err.message).toContain('U0000000008');
  });

  it('reports an unknown handle suggesting search people', async () => {
    const { client } = stubClient({ userPages: [[BOB]] });
    const err = await resolveIdentifier(client, '@nobody', '@nobody', 'user', '<user>').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('"@nobody"');
    expect(err.hint).toContain('slackcli search people');
  });

  it('looks an email up with one users.lookupByEmail call', async () => {
    const { client, calls } = stubClient({ emails: { 'alice@example.com': 'U0000000001' } });
    expect(await resolveIdentifier(client, 'alice@example.com', 'alice@example.com', 'user', '<user>')).toBe('U0000000001');
    expect(calls).toEqual([{ method: 'users.lookupByEmail', params: { email: 'alice@example.com' } }]);
  });

  it('reports an unknown email as not found', async () => {
    const { client } = stubClient();
    const err = await resolveIdentifier(client, 'ghost@example.com', 'ghost@example.com', 'user', '<user>').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('ghost@example.com');
  });

  it('reports a lookup that returns no user as not found', async () => {
    const client = { async lookupUserByEmail() { return { ok: true }; } } as unknown as NameLookupClient;
    await expect(resolveIdentifier(client, 'ghost@example.com', 'ghost@example.com', 'user', '<user>')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names the users:read.email scope when an app token lacks it, keeping the Slack code', async () => {
    const { client } = stubClient({ emailError: 'missing_scope' });
    const err = await resolveIdentifier(client, 'alice@example.com', 'alice@example.com', 'user', '<user>').catch((e) => e);
    expect(err.message).toContain('users:read.email');
    expect(classifyError(err)).toMatchObject({ code: 'permission_denied', slack_error: 'missing_scope' });
  });

  it('passes any other Slack failure through unchanged', async () => {
    const { client } = stubClient({ emailError: 'ratelimited' });
    const err = await resolveIdentifier(client, 'alice@example.com', 'alice@example.com', 'user', '<user>').catch((e) => e);
    expect(err.message).toBe('Slack API error: ratelimited');
  });
});

describe('resolveIdentifier', () => {
  it('returns the parsed ID untouched for an ID, URL or missing raw input, making no call', async () => {
    const { client, calls } = stubClient();
    let created = 0;
    const lazy = async () => { created += 1; return client; };
    expect(await resolveIdentifier(lazy, 'C0123456789', 'C0123456789', 'channel', '--channel')).toBe('C0123456789');
    expect(await resolveIdentifier(lazy, 'https://acme.slack.com/archives/C0123456789', 'C0123456789', 'channel', '--channel')).toBe('C0123456789');
    expect(await resolveIdentifier(lazy, undefined, 'C0123456789', 'channel-or-user', '--recipient-id')).toBe('C0123456789');
    expect(await resolveIdentifier(lazy, '@U0123456789', '@U0123456789', 'channel-or-user', '--recipient-id')).toBe('U0123456789');
    expect(await resolveIdentifier(lazy, '@U0123456789', '@U0123456789', 'user', '<user>')).toBe('U0123456789');
    expect(calls).toEqual([]);
    expect(created).toBe(0);
  });

  it('creates a lazy client only when a name is given', async () => {
    const { client } = stubClient({ channelPages: [[GENERAL]] });
    let created = 0;
    const lazy = async () => { created += 1; return client; };
    expect(await resolveIdentifier(lazy, '#general', '#general', 'channel', '--channel')).toBe('C0000000001');
    expect(created).toBe(1);
  });

  describe('channel-or-user', () => {
    it('resolves a bare name that is only a channel', async () => {
      const { client } = stubClient({ channelPages: [[GENERAL]], userPages: [[ALICE]] });
      expect(await resolveIdentifier(client, 'general', 'general', 'channel-or-user', '--recipient-id')).toBe('C0000000001');
    });

    it('resolves a bare name that is only a user', async () => {
      const { client } = stubClient({ channelPages: [[GENERAL]], userPages: [[ALICE]] });
      expect(await resolveIdentifier(client, 'alice', 'alice', 'channel-or-user', '--recipient-id')).toBe('U0000000001');
    });

    it('refuses a bare name that is both, asking for # or @', async () => {
      const deploy = { id: 'C0000000005', name: 'deploy' };
      const bot = { id: 'U0000000005', name: 'deploy' };
      const { client } = stubClient({ channelPages: [[deploy]], userPages: [[bot]] });
      const err = await resolveIdentifier(client, 'deploy', 'deploy', 'channel-or-user', '--recipient-id').catch((e) => e);
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err.message).toContain('C0000000005');
      expect(err.message).toContain('U0000000005');
      expect(err.hint).toBe('Write "#deploy" for the channel or "@deploy" for the user.');
    });

    it('uses only the channel list for #name and only the user list for @name', async () => {
      const deploy = { id: 'C0000000005', name: 'deploy' };
      const bot = { id: 'U0000000005', name: 'deploy' };
      const a = stubClient({ channelPages: [[deploy]], userPages: [[bot]] });
      expect(await resolveIdentifier(a.client, '#deploy', '#deploy', 'channel-or-user', '--recipient-id')).toBe('C0000000005');
      expect(a.calls.map((c) => c.method)).toEqual(['conversations.list']);
      const b = stubClient({ channelPages: [[deploy]], userPages: [[bot]] });
      expect(await resolveIdentifier(b.client, '@deploy', '@deploy', 'channel-or-user', '--recipient-id')).toBe('U0000000005');
      expect(b.calls.map((c) => c.method)).toEqual(['users.list']);
    });

    it('reports a bare name that is neither as not found', async () => {
      const { client } = stubClient({ channelPages: [[GENERAL]], userPages: [[ALICE]] });
      const err = await resolveIdentifier(client, 'nobody', 'nobody', 'channel-or-user', '--recipient-id').catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.message).toContain('no channel or user named "nobody"');
      expect(err.hint).toContain('slackcli search channels');
      expect(err.hint).toContain('slackcli search people');
    });

    it('reports two users with one bare name as ambiguous', async () => {
      const twin = { id: 'U0000000008', name: 'alice' };
      const { client } = stubClient({ channelPages: [[]], userPages: [[ALICE, twin]] });
      await expect(
        resolveIdentifier(client, 'alice', 'alice', 'channel-or-user', '--recipient-id'),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });
  });
});

describe('resolveUserList', () => {
  it('returns IDs with no call, dropping a leading @ as before', async () => {
    let created = 0;
    const lazy = async () => { created += 1; return stubClient().client; };
    expect(await resolveUserList(lazy, ['U0123456789', '@U0123456780', 'B0123456789'], '<users...>'))
      .toEqual(['U0123456789', 'U0123456780', 'B0123456789']);
    expect(created).toBe(0);
  });

  it('resolves handles in one users.list scan and emails individually, in input order', async () => {
    const { client, calls } = stubClient({
      userPages: [[BOB], [ALICE]],
      emails: { 'carol@example.com': 'U0000000003' },
    });
    const ids = await resolveUserList(
      client,
      ['@alice', 'U0123456789', 'carol@example.com', 'bob'],
      '<users...>',
    );
    expect(ids).toEqual(['U0000000001', 'U0123456789', 'U0000000003', 'U0000000002']);
    expect(calls.map((c) => c.method)).toEqual(['users.list', 'users.list', 'users.lookupByEmail']);
  });

  it('makes no users.list call for a list of IDs and emails', async () => {
    const { client, calls } = stubClient({ emails: { 'carol@example.com': 'U0000000003' } });
    expect(await resolveUserList(client, ['carol@example.com'], '<users...>')).toEqual(['U0000000003']);
    expect(calls.map((c) => c.method)).toEqual(['users.lookupByEmail']);
  });

  it('fails on the first unknown handle, naming it', async () => {
    const { client } = stubClient({ userPages: [[ALICE]] });
    const err = await resolveUserList(client, ['@alice', '@ghost'], '<users...>').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('"@ghost"');
  });
});

describe('lazyClient', () => {
  it('creates the client once, on first use, and exposes it afterwards', async () => {
    let created = 0;
    const lazy = lazyClient(async () => { created += 1; return stubClient().client; });
    expect(lazy.created()).toBeUndefined();
    const first = await lazy.get();
    expect(await lazy.get()).toBe(first);
    expect(lazy.created()).toBe(first);
    expect(created).toBe(1);
  });
});
