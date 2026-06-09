import { describe, expect, it } from 'bun:test';
import { SlackClient } from './slack-client.ts';
import { resolveMentions } from './mentions.ts';

interface FakeData {
  usergroups?: any[];
  people?: Record<string, any[]>;
  channels?: Record<string, any[]>;
}

// Subclass SlackClient and override request() so no network call is made.
// search.modules / usergroups.list are routed to the canned FakeData.
class FakeSlackClient extends SlackClient {
  public usergroupsCalls = 0;

  constructor(private readonly data: FakeData = {}) {
    super({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });
  }

  override async request(method: string, params: Record<string, any> = {}): Promise<any> {
    if (method === 'usergroups.list') {
      this.usergroupsCalls++;
      return { ok: true, usergroups: this.data.usergroups || [] };
    }

    if (method === 'search.modules') {
      const query = String(params.query);
      if (params.module === 'people') {
        return { ok: true, items: this.data.people?.[query] || [] };
      }
      if (params.module === 'channels') {
        return { ok: true, items: this.data.channels?.[query] || [] };
      }
    }

    throw new Error(`Unexpected method: ${method} ${JSON.stringify(params)}`);
  }
}

describe('resolveMentions', () => {
  it('passes plain text through unchanged', async () => {
    const client = new FakeSlackClient();
    expect(await resolveMentions('hello world', client)).toBe('hello world');
  });

  it('passes existing escape tokens through verbatim', async () => {
    const client = new FakeSlackClient();
    const input = '<@U1> <#C1> <!here> <https://example.com|site>';
    expect(await resolveMentions(input, client)).toBe(input);
  });

  it('resolves @group: by handle', async () => {
    const client = new FakeSlackClient({
      usergroups: [{ id: 'S1', handle: 'ror_team', name: 'RoR Team' }],
    });
    expect(await resolveMentions('@group:ror_team', client)).toBe('<!subteam^S1>');
  });

  it('resolves @group: by name when the handle does not match', async () => {
    const client = new FakeSlackClient({
      usergroups: [{ id: 'S2', handle: 'devs', name: 'engineers' }],
    });
    expect(await resolveMentions('@group:engineers', client)).toBe('<!subteam^S2>');
  });

  it('matches @group: handles case-insensitively', async () => {
    const client = new FakeSlackClient({
      usergroups: [{ id: 'S1', handle: 'ror_team', name: 'RoR Team' }],
    });
    expect(await resolveMentions('@group:ROR_TEAM', client)).toBe('<!subteam^S1>');
  });

  it('throws and lists available handles when a group is not found', async () => {
    const client = new FakeSlackClient({
      usergroups: [{ id: 'S1', handle: 'ror_team' }, { id: 'S2', handle: 'devs' }],
    });
    await expect(resolveMentions('@group:nope', client)).rejects.toThrow(/ror_team/);
  });

  it('resolves @user: by username', async () => {
    const client = new FakeSlackClient({
      people: { paul: [{ id: 'U1', name: 'paul' }] },
    });
    expect(await resolveMentions('@user:paul', client)).toBe('<@U1>');
  });

  it('resolves @user: by email', async () => {
    const client = new FakeSlackClient({
      people: {
        'paul@example.com': [{ id: 'U2', name: 'paul', profile: { email: 'paul@example.com' } }],
      },
    });
    expect(await resolveMentions('@user:paul@example.com', client)).toBe('<@U2>');
  });

  it('picks the exact username over the first result when multiple match', async () => {
    const client = new FakeSlackClient({
      people: {
        paul: [
          { id: 'U9', name: 'paul.jones', real_name: 'Paul Jones' },
          { id: 'U1', name: 'paul', real_name: 'Paul Smith' },
        ],
      },
    });
    // Naive results[0] would wrongly pick U9; exact-match priority picks U1.
    expect(await resolveMentions('@user:paul', client)).toBe('<@U1>');
  });

  it('resolves @user: with a quoted name via real_name', async () => {
    const client = new FakeSlackClient({
      people: {
        'Jane Doe': [{ id: 'U7', name: 'jane', real_name: 'Jane Doe' }],
      },
    });
    expect(await resolveMentions('@user:"Jane Doe"', client)).toBe('<@U7>');
  });

  it('falls back to the sole result when there is exactly one and no exact match', async () => {
    const client = new FakeSlackClient({
      people: { jane: [{ id: 'U5', name: 'jane.doe', real_name: 'Jane Doe' }] },
    });
    expect(await resolveMentions('@user:jane', client)).toBe('<@U5>');
  });

  it('throws an ambiguity error when multiple match and none is exact', async () => {
    const client = new FakeSlackClient({
      people: {
        pa: [
          { id: 'U1', name: 'paula' },
          { id: 'U2', name: 'pawel' },
        ],
      },
    });
    await expect(resolveMentions('@user:pa', client)).rejects.toThrow(/ambiguous/);
  });

  it('throws when no user matches', async () => {
    const client = new FakeSlackClient({ people: { ghost: [] } });
    await expect(resolveMentions('@user:ghost', client)).rejects.toThrow(/No user matches/);
  });

  it('resolves #channel by exact name', async () => {
    const client = new FakeSlackClient({
      channels: { general: [{ id: 'C1', name: 'general' }] },
    });
    expect(await resolveMentions('#general', client)).toBe('<#C1>');
  });

  it('prefers the exact channel name over a fuzzy match', async () => {
    const client = new FakeSlackClient({
      channels: {
        general: [
          { id: 'C9', name: 'general-chat' },
          { id: 'C1', name: 'general' },
        ],
      },
    });
    expect(await resolveMentions('#general', client)).toBe('<#C1>');
  });

  it('throws when no channel matches', async () => {
    const client = new FakeSlackClient({ channels: { nope: [] } });
    await expect(resolveMentions('#nope', client)).rejects.toThrow(/No channel matches/);
  });

  it('resolves multiple tokens in one message', async () => {
    const client = new FakeSlackClient({
      people: { paul: [{ id: 'U1', name: 'paul' }] },
      channels: { general: [{ id: 'C1', name: 'general' }] },
    });
    expect(await resolveMentions('@user:paul see #general', client)).toBe('<@U1> see <#C1>');
  });

  it('leaves a # inside a URL untouched', async () => {
    const client = new FakeSlackClient();
    const input = 'see https://example.com#section now';
    expect(await resolveMentions(input, client)).toBe(input);
  });

  it('fetches usergroups only once across multiple @group tokens', async () => {
    const client = new FakeSlackClient({
      usergroups: [{ id: 'S1', handle: 'ror_team' }],
    });
    const out = await resolveMentions('@group:ror_team and @group:ror_team', client);
    expect(out).toBe('<!subteam^S1> and <!subteam^S1>');
    expect(client.usergroupsCalls).toBe(1);
  });
});
