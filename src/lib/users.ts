import type { SlackClient } from './slack-client.ts';

export type UserStatusFilter = 'all' | 'active' | 'deactivated';

// A user's account status, derived from the boolean flags Slack returns.
// `deleted` is the one reliable, always-present deactivation signal (tz/is_admin
// are stripped from a deactivated user, so they cannot be relied on for status).
export function statusOf(u: any): string {
  if (u.deleted) return 'DEACTIVATED';
  if (u.is_bot) return 'bot';
  if (u.is_ultra_restricted) return 'guest (single-channel)';
  if (u.is_restricted) return 'guest (multi-channel)';
  return 'active';
}

// True when a member passes the requested status filter.
export function matchesStatus(u: any, status: UserStatusFilter): boolean {
  if (status === 'active') return !u.deleted;
  if (status === 'deactivated') return u.deleted === true;
  return true; // 'all'
}

// List workspace users honouring MATCHES-RETURNED limit semantics: `limit` caps
// the number of users that PASS the status filter, not how deep we scan. We page
// users.list internally, applying the filter as we go, and stop as soon as we
// have `limit` matches OR the workspace is exhausted. This mirrors every other
// paginated flag in the CLI (`search`, `conversations list`), where --limit is
// "number of results to return".
//
// Without this, `--status active --limit 5` on a workspace whose first page is
// bots and deactivated accounts returns fewer than 5 (or zero) active users even
// though thousands exist — the scan-depth bug this fixes.
export async function listUsersByStatus(
  client: SlackClient,
  options: {
    limit: number;
    status: UserStatusFilter;
    onProgress?: (message: string) => void;
  },
): Promise<any[]> {
  const { limit, status } = options;
  const matches: any[] = [];
  let cursor: string | undefined;

  do {
    const resp = await client.listUsers({ cursor, limit: 200 });
    if (!resp.ok) {
      throw new Error(resp.error || 'Failed to list users');
    }

    for (const member of resp.members || []) {
      if (matchesStatus(member, status)) {
        matches.push(member);
        if (matches.length >= limit) break;
      }
    }

    options.onProgress?.(`Scanning users… ${matches.length}/${limit} matched`);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor && matches.length < limit);

  return matches;
}
