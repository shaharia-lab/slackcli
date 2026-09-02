import { describe, expect, test } from 'bun:test';
import {
  addUsergroupMembers,
  applyMembershipChange,
  fetchUsergroupMembers,
  isUsergroupEnabled,
  normalizeUsergroups,
  removeUsergroupMembers,
  resolveUsergroup,
} from './usergroups.ts';
import type { SlackClient } from './slack-client.ts';

// Minimal fake client: records every request and returns canned responses
// keyed by method. Mirrors the SlackClient surface the helpers call.
function fakeClient(overrides: Partial<Record<string, (params: any) => any>> = {}): {
  client: SlackClient;
  calls: Array<{ method: string; params: any }>;
} {
  const calls: Array<{ method: string; params: any }> = [];
  const client: any = {
    listUsergroups: (params: any) => {
      calls.push({ method: 'usergroups.list', params });
      return overrides['usergroups.list']?.(params) ?? { ok: true, usergroups: [] };
    },
    listUsergroupUsers: (usergroup: string) => {
      calls.push({ method: 'usergroups.users.list', params: { usergroup } });
      return overrides['usergroups.users.list']?.({ usergroup }) ?? { ok: true, users: [] };
    },
    setUsergroupUsers: (usergroup: string, users: string) => {
      calls.push({ method: 'usergroups.users.update', params: { usergroup, users } });
      return overrides['usergroups.users.update']?.({ usergroup, users }) ?? { ok: true };
    },
    getUsersInfo: (ids: string[]) => {
      calls.push({ method: 'users.info', params: { ids } });
      return overrides['users.info']?.({ ids }) ?? { ok: true, users: [] };
    },
  };
  return { client: client as SlackClient, calls };
}

describe('isUsergroupEnabled', () => {
  test('date_delete 0 or missing is enabled', () => {
    expect(isUsergroupEnabled({ date_delete: 0 })).toBe(true);
    expect(isUsergroupEnabled({})).toBe(true);
  });
  test('non-zero date_delete is disabled', () => {
    expect(isUsergroupEnabled({ date_delete: 1700000000 })).toBe(false);
  });
});

describe('normalizeUsergroups', () => {
  test('maps fields and sorts by name', () => {
    const out = normalizeUsergroups([
      { id: 'S2', name: 'Zebra', handle: 'z', user_count: 3 },
      { id: 'S1', name: 'Apple', handle: 'a', user_count: 1 },
    ]);
    expect(out.map((g) => g.name)).toEqual(['Apple', 'Zebra']);
    expect(out[0].id).toBe('S1');
    expect(out[0].user_count).toBe(1);
  });
  test('tolerates empty/undefined input', () => {
    expect(normalizeUsergroups(undefined as any)).toEqual([]);
    expect(normalizeUsergroups([])).toEqual([]);
  });
});

describe('resolveUsergroup', () => {
  const groups = [
    { id: 'S03E2T070G7', name: 'Platform Team', handle: 'platform', date_delete: 0 },
    { id: 'S03E2T1SWEB', name: 'Security', handle: 'sec', date_delete: 0 },
  ];
  const list = () => ({ client } = fakeClient({ 'usergroups.list': () => ({ ok: true, usergroups: groups }) }));
  let client: SlackClient;

  test('resolves by id', async () => {
    list();
    const g = await resolveUsergroup(client, 'S03E2T1SWEB');
    expect(g?.name).toBe('Security');
  });
  test('resolves by @handle case-insensitively', async () => {
    list();
    const g = await resolveUsergroup(client, '@PLATFORM');
    expect(g?.id).toBe('S03E2T070G7');
  });
  test('resolves by exact name', async () => {
    list();
    const g = await resolveUsergroup(client, 'security');
    expect(g?.id).toBe('S03E2T1SWEB');
  });
  test('returns undefined on no handle/name match', async () => {
    list();
    expect(await resolveUsergroup(client, 'nope')).toBeUndefined();
  });
  test('honours a raw S-id even when absent from the list (enterprise grid)', async () => {
    const { client } = fakeClient({ 'usergroups.list': () => ({ ok: true, usergroups: [] }) });
    const g = await resolveUsergroup(client, 'S0BT63G1N2E');
    expect(g?.id).toBe('S0BT63G1N2E'); // stub, not undefined
  });
});

describe('fetchUsergroupMembers', () => {
  test('resolves ids to names, preserving order', async () => {
    const { client } = fakeClient({
      'usergroups.users.list': () => ({ ok: true, users: ['U1', 'U2'] }),
      'users.info': () => ({
        ok: true,
        users: [
          { id: 'U2', name: 'bob', real_name: 'Bob', profile: { display_name: 'bobby' } },
          { id: 'U1', name: 'alice', real_name: 'Alice', profile: { display_name: 'al' } },
        ],
      }),
    });
    const { ids, members } = await fetchUsergroupMembers(client, 'S1');
    expect(ids).toEqual(['U1', 'U2']);
    expect(members.map((m) => m.id)).toEqual(['U1', 'U2']); // order preserved
    expect(members[0].display_name).toBe('al');
  });
  test('empty group short-circuits without a users.info call', async () => {
    const { client, calls } = fakeClient({
      'usergroups.users.list': () => ({ ok: true, users: [] }),
    });
    const { members } = await fetchUsergroupMembers(client, 'S1');
    expect(members).toEqual([]);
    expect(calls.some((c) => c.method === 'users.info')).toBe(false);
  });
});

describe('applyMembershipChange', () => {
  test('adds only new ids', () => {
    const r = applyMembershipChange(['U1'], { add: ['U1', 'U2'] });
    expect(r.added).toEqual(['U2']);
    expect(r.removed).toEqual([]);
    expect(new Set(r.next)).toEqual(new Set(['U1', 'U2']));
    expect(r.noop).toBe(false);
  });
  test('removes only present ids', () => {
    const r = applyMembershipChange(['U1', 'U2'], { remove: ['U2', 'U9'] });
    expect(r.removed).toEqual(['U2']);
    expect(r.next).toEqual(['U1']);
  });
  test('no-op when nothing changes', () => {
    const r = applyMembershipChange(['U1'], { add: ['U1'] });
    expect(r.noop).toBe(true);
    expect(r.added).toEqual([]);
  });
});

describe('addUsergroupMembers / removeUsergroupMembers (read-modify-write)', () => {
  test('add reads current then writes the union', async () => {
    const { client, calls } = fakeClient({
      'usergroups.users.list': () => ({ ok: true, users: ['U1'] }),
    });
    const r = await addUsergroupMembers(client, 'S1', ['U2']);
    expect(r.added).toEqual(['U2']);
    const write = calls.find((c) => c.method === 'usergroups.users.update');
    expect(new Set(write!.params.users.split(','))).toEqual(new Set(['U1', 'U2']));
  });

  test('add that changes nothing does not write', async () => {
    const { client, calls } = fakeClient({
      'usergroups.users.list': () => ({ ok: true, users: ['U1'] }),
    });
    const r = await addUsergroupMembers(client, 'S1', ['U1']);
    expect(r.noop).toBe(true);
    expect(calls.some((c) => c.method === 'usergroups.users.update')).toBe(false);
  });

  test('remove writes the reduced list', async () => {
    const { client, calls } = fakeClient({
      'usergroups.users.list': () => ({ ok: true, users: ['U1', 'U2'] }),
    });
    const r = await removeUsergroupMembers(client, 'S1', ['U2']);
    expect(r.removed).toEqual(['U2']);
    const write = calls.find((c) => c.method === 'usergroups.users.update');
    expect(write!.params.users).toBe('U1');
  });

  test('refuses to empty the group', async () => {
    const { client } = fakeClient({
      'usergroups.users.list': () => ({ ok: true, users: ['U1'] }),
    });
    await expect(removeUsergroupMembers(client, 'S1', ['U1'])).rejects.toThrow(/last member/);
  });
});
