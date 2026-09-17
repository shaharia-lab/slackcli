import { describe, expect, it } from 'bun:test';
import { SlackClient } from './slack-client.ts';
import { statusOf, matchesStatus, listUsersByStatus } from './users.ts';

// A users.list stub that serves canned pages and records the cursor/limit of
// every call, so we can assert both the RESULT and the PAGING behaviour.
class PagedUsersClient extends SlackClient {
  public readonly listCalls: Array<{ cursor?: string; limit?: number }> = [];

  constructor(private readonly pages: Array<{ members: any[]; next?: string }>) {
    super({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      auth_type: 'browser',
      xoxd_token: 'xoxd-test',
      xoxc_token: 'xoxc-test',
      workspace_url: 'https://example.slack.com',
    });
  }

  override async listUsers(options: { cursor?: string; limit?: number } = {}): Promise<any> {
    this.listCalls.push({ cursor: options.cursor, limit: options.limit });
    const index = options.cursor ? Number(options.cursor) : 0;
    const page = this.pages[index];
    if (!page) return { ok: true, members: [] };
    return {
      ok: true,
      members: page.members,
      response_metadata: page.next ? { next_cursor: page.next } : {},
    };
  }
}

const active = (id: string) => ({ id, name: id, deleted: false });
const gone = (id: string) => ({ id, name: id, deleted: true });
const bot = (id: string) => ({ id, name: id, deleted: false, is_bot: true });

describe('statusOf', () => {
  it('reports DEACTIVATED for a deleted user regardless of other flags', () => {
    expect(statusOf({ deleted: true, is_bot: true })).toBe('DEACTIVATED');
  });
  it('distinguishes bot, guests, and active', () => {
    expect(statusOf(bot('B1'))).toBe('bot');
    expect(statusOf({ is_ultra_restricted: true })).toBe('guest (single-channel)');
    expect(statusOf({ is_restricted: true })).toBe('guest (multi-channel)');
    expect(statusOf(active('U1'))).toBe('active');
  });
});

describe('matchesStatus', () => {
  it('active excludes deleted, deactivated requires deleted, all passes both', () => {
    expect(matchesStatus(active('U1'), 'active')).toBe(true);
    expect(matchesStatus(gone('U2'), 'active')).toBe(false);
    expect(matchesStatus(gone('U2'), 'deactivated')).toBe(true);
    expect(matchesStatus(active('U1'), 'deactivated')).toBe(false);
    expect(matchesStatus(gone('U2'), 'all')).toBe(true);
    expect(matchesStatus(active('U1'), 'all')).toBe(true);
  });
});

describe('listUsersByStatus — matches-returned limit semantics', () => {
  // The core of decision (1): --limit caps MATCHES, not scan depth. `active`
  // means "not deactivated" (the deleted axis) — bots count as active, matching
  // the all/active/deactivated status model. Page 0 is all deactivated; the
  // active users we want appear on later pages. A scan-depth cap would return
  // zero active users here; matches-returned must keep paging.
  it('keeps paging past non-matching pages until `limit` matches are collected', async () => {
    const client = new PagedUsersClient([
      { members: [gone('D1'), gone('D2')], next: '1' },
      { members: [active('U1'), gone('D3'), active('U2')], next: '2' },
      { members: [active('U3'), active('U4')], next: '3' },
      { members: [active('U5')] },
    ]);

    const result = await listUsersByStatus(client, { limit: 3, status: 'active' });

    expect(result.map((u) => u.id)).toEqual(['U1', 'U2', 'U3']);
  });

  it('counts a bot as active (status filters on the deleted axis only)', async () => {
    const client = new PagedUsersClient([
      { members: [gone('D1'), bot('B1'), active('U1')] },
    ]);

    const result = await listUsersByStatus(client, { limit: 2, status: 'active' });

    expect(result.map((u) => u.id)).toEqual(['B1', 'U1']);
  });

  it('stops early once the limit is reached and does not fetch further pages', async () => {
    const client = new PagedUsersClient([
      { members: [active('U1'), active('U2')], next: '1' },
      { members: [active('U3'), active('U4')], next: '2' },
    ]);

    const result = await listUsersByStatus(client, { limit: 2, status: 'active' });

    expect(result.map((u) => u.id)).toEqual(['U1', 'U2']);
    // Only the first page needed to be fetched.
    expect(client.listCalls).toEqual([{ cursor: undefined, limit: 200 }]);
  });

  it('returns fewer than the limit when the workspace is exhausted', async () => {
    const client = new PagedUsersClient([
      { members: [active('U1'), gone('D1')], next: '1' },
      { members: [active('U2')] },
    ]);

    const result = await listUsersByStatus(client, { limit: 10, status: 'active' });

    expect(result.map((u) => u.id)).toEqual(['U1', 'U2']);
  });

  it('counts deactivated matches for --status deactivated', async () => {
    const client = new PagedUsersClient([
      { members: [active('U1'), gone('D1')], next: '1' },
      { members: [gone('D2'), active('U2')] },
    ]);

    const result = await listUsersByStatus(client, { limit: 2, status: 'deactivated' });

    expect(result.map((u) => u.id)).toEqual(['D1', 'D2']);
  });

  it('counts every member for --status all', async () => {
    const client = new PagedUsersClient([
      { members: [active('U1'), gone('D1'), bot('B1')] },
    ]);

    const result = await listUsersByStatus(client, { limit: 2, status: 'all' });

    expect(result.map((u) => u.id)).toEqual(['U1', 'D1']);
  });

  it('throws a clear error when users.list returns not-ok', async () => {
    class FailingClient extends PagedUsersClient {
      override async listUsers(): Promise<any> {
        return { ok: false, error: 'ratelimited' };
      }
    }
    const client = new FailingClient([]);
    await expect(listUsersByStatus(client, { limit: 5, status: 'all' })).rejects.toThrow('ratelimited');
  });
});
