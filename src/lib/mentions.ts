// Resolve friendly mention tokens into Slack escape tokens before a draft is
// built. The mrkdwn parser (src/lib/mrkdwn.ts) turns Slack escape tokens such
// as <@U…>, <!subteam^S…> and <#C…> into rich_text mention elements, but it
// has no way to look names up. This module bridges that gap by translating:
//
//   @group:<handle>       → <!subteam^S…>   (usergroups.list)
//   @user:<name|email>    → <@U…>           (search people, exact-match first)
//   #<channel>            → <#C…>           (search channels, exact name)
//
// Existing escape tokens are passed through verbatim. Lookups that cannot be
// resolved unambiguously throw a clear, actionable error rather than leaving a
// friendly token behind as dead literal text.

import type { SlackClient } from './slack-client.ts';

interface ResolvedPerson {
  id: string;
  name?: string;
  real_name?: string;
  display_name?: string;
  email?: string;
}

interface ResolvedChannel {
  id: string;
  name?: string;
}

const GROUP_PREFIX = '@group:';
const USER_PREFIX = '@user:';

// Read a token argument starting at `start`. Supports a quoted form
// (@user:"Jane Doe") and an unquoted form that runs to the next whitespace
// (so emails like jane@example.com are captured intact).
function readArg(text: string, start: number): { value: string; end: number } {
  if (text[start] === '"') {
    const close = text.indexOf('"', start + 1);
    if (close !== -1) {
      return { value: text.slice(start + 1, close), end: close + 1 };
    }
  }

  let j = start;
  while (j < text.length && !/\s/.test(text[j])) j++;
  return { value: text.slice(start, j), end: j };
}

// Read a channel name (letters, digits, hyphen, underscore) starting at `start`.
function readChannelName(text: string, start: number): { value: string; end: number } {
  let j = start;
  while (j < text.length && /[a-z0-9_-]/i.test(text[j])) j++;
  return { value: text.slice(start, j), end: j };
}

function normalizePeople(response: any): ResolvedPerson[] {
  if (response.items) {
    // search.modules (browser auth)
    return response.items.map((p: any) => ({
      id: p.id,
      name: p.name,
      real_name: p.real_name || p.profile?.real_name,
      display_name: p.profile?.display_name,
      email: p.profile?.email,
    }));
  }

  // users.list fallback (standard auth)
  return (response.members || [])
    .filter((u: any) => !u.deleted && !u.is_bot)
    .map((u: any) => ({
      id: u.id,
      name: u.name,
      real_name: u.real_name || u.profile?.real_name,
      display_name: u.profile?.display_name,
      email: u.profile?.email,
    }));
}

function normalizeChannels(response: any): ResolvedChannel[] {
  if (response.items) {
    // search.modules (browser auth)
    return response.items.map((c: any) => ({ id: c.id, name: c.name }));
  }

  // conversations.list fallback (standard auth)
  return (response.channels || []).map((c: any) => ({ id: c.id, name: c.name }));
}

function describePerson(person: ResolvedPerson): string {
  const label = person.real_name || person.display_name || person.email;
  const handle = person.name ? `@${person.name}` : person.id;
  return label ? `${handle} (${label})` : handle;
}

async function resolveGroup(handle: string, getUsergroups: () => Promise<any[]>): Promise<string> {
  const groups = await getUsergroups();
  const target = handle.toLowerCase();

  const match =
    groups.find((g) => g.handle?.toLowerCase() === target) ||
    groups.find((g) => g.name?.toLowerCase() === target);

  if (!match) {
    const handles = groups.map((g) => g.handle).filter(Boolean).sort();
    const available = handles.length ? handles.join(', ') : '(none)';
    throw new Error(
      `No usergroup matches "@group:${handle}". Available handles: ${available}.`,
    );
  }

  return `<!subteam^${match.id}>`;
}

async function resolveUser(query: string, client: SlackClient): Promise<string> {
  const response = await client.searchModules(query, 'people');
  const people = normalizePeople(response);
  const target = query.toLowerCase();

  // Exact-match priority: username → email → display name → real name.
  const exact =
    people.find((p) => p.name?.toLowerCase() === target) ||
    people.find((p) => p.email?.toLowerCase() === target) ||
    people.find((p) => p.display_name?.toLowerCase() === target) ||
    people.find((p) => p.real_name?.toLowerCase() === target);

  if (exact) return `<@${exact.id}>`;

  // Fall back to the sole result only when there is exactly one.
  if (people.length === 1) return `<@${people[0].id}>`;

  if (people.length === 0) {
    throw new Error(
      `No user matches "@user:${query}". Try an exact username or email, e.g. @user:jane.doe or @user:jane@example.com.`,
    );
  }

  const candidates = people.slice(0, 10).map(describePerson).join(', ');
  throw new Error(
    `"@user:${query}" is ambiguous — ${people.length} matches: ${candidates}. ` +
      'Use an exact username or email to disambiguate.',
  );
}

async function resolveChannel(name: string, client: SlackClient): Promise<string> {
  const response = await client.searchModules(name, 'channels');
  const channels = normalizeChannels(response);
  const target = name.toLowerCase();

  // Exact name match takes priority over any fuzzy search hit.
  const exact = channels.find((c) => c.name?.toLowerCase() === target);
  if (exact) return `<#${exact.id}>`;

  if (channels.length === 1) return `<#${channels[0].id}>`;

  if (channels.length === 0) {
    throw new Error(`No channel matches "#${name}". Use the exact channel name.`);
  }

  const candidates = channels
    .slice(0, 10)
    .map((c) => (c.name ? `#${c.name}` : c.id))
    .join(', ');
  throw new Error(
    `"#${name}" is ambiguous — ${channels.length} matches: ${candidates}. Use the exact channel name.`,
  );
}

// Translate friendly mention tokens in `text` into Slack escape tokens.
// A single left-to-right scan is used (rather than a global regex replace) so
// that labels inside existing escape tokens, and '#' characters inside URLs,
// are never mistaken for friendly tokens.
export async function resolveMentions(text: string, client: SlackClient): Promise<string> {
  let usergroups: any[] | null = null;
  const getUsergroups = async (): Promise<any[]> => {
    if (usergroups === null) {
      const response = await client.listUsergroups({ include_disabled: true });
      usergroups = response.usergroups || [];
    }
    return usergroups ?? [];
  };

  let result = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Pass existing escape tokens (<@…>, <#…>, <!…>, <https://…>) through verbatim.
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      if (end !== -1) {
        result += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      result += ch;
      i++;
      continue;
    }

    if (text.startsWith(GROUP_PREFIX, i)) {
      const { value, end } = readArg(text, i + GROUP_PREFIX.length);
      if (value.length > 0) {
        result += await resolveGroup(value, getUsergroups);
        i = end;
        continue;
      }
    }

    if (text.startsWith(USER_PREFIX, i)) {
      const { value, end } = readArg(text, i + USER_PREFIX.length);
      if (value.length > 0) {
        result += await resolveUser(value, client);
        i = end;
        continue;
      }
    }

    // #channel, only at a word boundary so '#' inside a URL is left untouched.
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      const { value, end } = readChannelName(text, i + 1);
      if (value.length > 0) {
        result += await resolveChannel(value, client);
        i = end;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}
