import { describe, expect, it } from 'bun:test';
import { SlackClient } from './slack-client.ts';
import { buildFieldLabelMap, resolveProfileFields } from './profile-fields.ts';

class TeamProfileClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly fields: any[]) {
    super({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });
  }

  override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'team.profile.get') {
      return { ok: true, profile: { fields: this.fields } };
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

describe('buildFieldLabelMap', () => {
  it('maps each custom-field ID to its label via one team.profile.get call', async () => {
    const client = new TeamProfileClient([
      { id: 'Xf01', label: 'Department' },
      { id: 'Xf02', label: 'Cost Center' },
    ]);

    const map = await buildFieldLabelMap(client);

    expect(map).toEqual({ Xf01: 'Department', Xf02: 'Cost Center' });
    expect(client.calls).toEqual([{ method: 'team.profile.get', params: {} }]);
  });

  it('falls back to the raw ID when a field has no label', async () => {
    const client = new TeamProfileClient([{ id: 'Xf03' }]);
    expect(await buildFieldLabelMap(client)).toEqual({ Xf03: 'Xf03' });
  });

  it('returns an empty map when the workspace defines no custom fields', async () => {
    const client = new TeamProfileClient([]);
    expect(await buildFieldLabelMap(client)).toEqual({});
  });
});

describe('resolveProfileFields', () => {
  const labels = { Xf01: 'Department', Xf02: 'Manager' };

  it('replaces opaque field IDs with their human labels', () => {
    const user = {
      profile: {
        fields: {
          Xf01: { value: 'Engineering' },
          Xf02: { value: 'U0MANAGER01' },
        },
      },
    };

    expect(resolveProfileFields(user, labels)).toEqual({
      Department: 'Engineering',
      Manager: 'U0MANAGER01',
    });
  });

  // Decision 3: labels resolve, user-typed VALUES stay as IDs. The Manager value
  // above is a U… id and MUST be passed through unchanged — no id->name hop.
  it('leaves user-typed field values as raw U… IDs (no --resolve-users hop)', () => {
    const user = { profile: { fields: { Xf02: { value: 'U0MANAGER01' } } } };
    expect(resolveProfileFields(user, labels).Manager).toBe('U0MANAGER01');
  });

  it('keeps an unknown field ID under its raw key rather than dropping it', () => {
    const user = { profile: { fields: { XfUNKNOWN: { value: 'x' } } } };
    expect(resolveProfileFields(user, labels)).toEqual({ XfUNKNOWN: 'x' });
  });

  it('returns an empty object for a user with no custom fields', () => {
    expect(resolveProfileFields({ profile: {} }, labels)).toEqual({});
    expect(resolveProfileFields({}, labels)).toEqual({});
  });

  it('normalises a missing value to an empty string', () => {
    const user = { profile: { fields: { Xf01: {} } } };
    expect(resolveProfileFields(user, labels)).toEqual({ Department: '' });
  });
});
