import type { SlackClient } from './slack-client.ts';
import type { SlackUsergroup, UsergroupMember } from '../types/index.ts';

type ProgressOptions = { onProgress?: (message: string) => void };
type ScopeOptions = { teamId?: string };
type LibOptions = ProgressOptions & ScopeOptions;

// A user group is "enabled" when Slack has not soft-deleted it. Slack encodes
// that as date_delete === 0 (a disabled group carries the unix time it was
// disabled). The formatter imports this so the render layer and the lib share
// one definition of the rule.
export function isUsergroupEnabled(group: Pick<SlackUsergroup, 'date_delete'>): boolean {
  return !group.date_delete || group.date_delete === 0;
}

// Normalise the usergroups.list array into our typed, name-sorted shape. The
// raw response carries ~25 fields per group; we keep the ones worth surfacing.
export function normalizeUsergroups(raw: any[]): SlackUsergroup[] {
  const groups: SlackUsergroup[] = (raw || []).map((g) => ({
    id: g.id,
    team_id: g.team_id,
    name: g.name,
    handle: g.handle,
    description: g.description,
    is_external: g.is_external,
    is_usergroup: g.is_usergroup,
    is_subteam: g.is_subteam,
    date_create: g.date_create,
    date_update: g.date_update,
    date_delete: g.date_delete,
    created_by: g.created_by,
    user_count: g.user_count,
    channel_count: g.channel_count,
    users: g.users,
  }));
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

// Fetch the workspace's user groups as a normalised, sorted list.
export async function fetchUsergroups(
  client: SlackClient,
  options: { includeDisabled?: boolean } & LibOptions = {},
): Promise<SlackUsergroup[]> {
  options.onProgress?.('Fetching user groups...');
  const response = await client.listUsergroups({
    include_disabled: options.includeDisabled,
    team_id: options.teamId,
  });
  return normalizeUsergroups(response?.usergroups ?? []);
}

// Resolve a user group by its id (S...), @handle, or exact name (case-insensitive
// on handle/name). Returns undefined when nothing matches.
//
// A raw usergroup id (S...) is honoured DIRECTLY without a usergroups.list
// round-trip: on an enterprise grid, a group scoped to a member workspace does
// not always appear in the org-context list, so requiring a list hit would make
// a just-created group unresolvable. For an id we return a stub the caller
// enriches (read/create/update responses carry the full object anyway); only
// @handle / name refs need the list to map to an id.
const USERGROUP_ID = /^S[A-Z0-9]{6,}$/;

export async function resolveUsergroup(
  client: SlackClient,
  ref: string,
  options: LibOptions = {},
): Promise<SlackUsergroup | undefined> {
  if (USERGROUP_ID.test(ref)) {
    // Trust the id. Enrich from the list when the group is visible there, but
    // never fail resolution just because an org-level list omits a grid group.
    const groups = await fetchUsergroups(client, { includeDisabled: true, ...options });
    return groups.find((g) => g.id === ref) ?? { id: ref, name: ref };
  }

  const needle = ref.replace(/^@/, '');
  const groups = await fetchUsergroups(client, { includeDisabled: true, ...options });

  const lower = needle.toLowerCase();
  return groups.find(
    (g) => (g.handle && g.handle.toLowerCase() === lower) || g.name.toLowerCase() === lower,
  );
}

// Resolve a group's member IDs to typed members with best-effort name data.
// Returns { ids, members } — ids is always the raw membership; members carries
// resolved names when the users.info lookups succeed.
export async function fetchUsergroupMembers(
  client: SlackClient,
  usergroupId: string,
  options: LibOptions = {},
): Promise<{ ids: string[]; members: UsergroupMember[] }> {
  options.onProgress?.('Fetching group members...');
  const response = await client.listUsergroupUsers(usergroupId, { team_id: options.teamId });
  const ids: string[] = response?.users ?? [];

  if (ids.length === 0) return { ids, members: [] };

  options.onProgress?.('Resolving member names...');
  const usersResponse = await client.getUsersInfo(ids);
  const byId = new Map<string, any>();
  for (const u of usersResponse?.users ?? []) byId.set(u.id, u);

  const members: UsergroupMember[] = ids.map((id) => {
    const u = byId.get(id);
    return {
      id,
      name: u?.name,
      real_name: u?.real_name ?? u?.profile?.real_name,
      display_name: u?.profile?.display_name,
      is_bot: u?.is_bot,
      deleted: u?.deleted,
    };
  });

  return { ids, members };
}
