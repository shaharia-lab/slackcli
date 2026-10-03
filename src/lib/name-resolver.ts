/**
 * Resolve channel names (`#general`, `general`) and user handles (`@alice`) or
 * email addresses to Slack IDs, for every argument that accepts an ID.
 *
 * IDs and Slack URLs never reach a lookup: {@link parseNameReference} is pure,
 * and the client is only touched when it says a name was given. A lookup is
 * exact (case-insensitive on the name), and a name that matches nothing or
 * more than one thing is an error — the CLI never guesses where to post.
 */

import { getLogger } from '@logtape/logtape';
import { InvalidInputError, NotFoundError } from './cli-errors.ts';
import {
  type ExpectedKind,
  identifierKind,
  isSlackUrl,
  normalizeIdentifier,
} from './slack-url-parser.ts';

const logger = getLogger(['slackcli', 'name-resolver']);

/** The client calls a lookup needs. `SlackClient` satisfies it. */
export interface NameLookupClient {
  listConversations(options: {
    types?: string;
    limit?: number;
    exclude_archived?: boolean;
    cursor?: string;
  }): Promise<any>;
  listUsers(options: { cursor?: string; limit?: number }): Promise<any>;
  lookupUserByEmail(email: string): Promise<any>;
}

/** A client, or a way to get one only when a lookup is actually needed. */
export type NameLookupClientSource = NameLookupClient | (() => Promise<NameLookupClient>);

export interface ResolveOptions {
  onProgress?: (message: string) => void;
}

/** What a non-ID input names. */
export type NameReference =
  | { kind: 'channel'; name: string }
  | { kind: 'user'; handle: string }
  | { kind: 'email'; email: string }
  // A bare name on a channel-or-user argument: either, decided by what exists.
  | { kind: 'channel-or-user'; name: string };

// Page size for conversations.list / users.list, the same as the search fallback.
const PAGE_LIMIT = 1000;

// Anything shaped like a Slack ID (upper-case letter, then upper-case
// alphanumerics) is passed through as one, including prefixes identifierKind()
// does not classify (A… app, B… bot IDs). Channel names and handles are
// lower-case, so this never swallows a name.
const ID_LIKE_PATTERN = /^[A-Z][A-Z0-9]{6,}$/;

function isIdLike(value: string): boolean {
  return identifierKind(value) !== 'unknown' || ID_LIKE_PATTERN.test(value);
}

// Deliberately loose: the address is passed to users.lookupByEmail verbatim,
// which is the authority. This only tells an address from a handle.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Strip surrounding whitespace and the `<…>` Slack adds to a pasted value. */
function clean(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function acceptsChannel(expected: ExpectedKind): boolean {
  return expected === 'channel' || expected === 'channel-or-user';
}

function acceptsUser(expected: ExpectedKind): boolean {
  return expected === 'user' || expected === 'channel-or-user';
}

/**
 * The name an input refers to, or null when it is an ID, a Slack URL, or a form
 * this argument does not take a name in (file arguments never do).
 */
export function parseNameReference(input: string, expected: ExpectedKind): NameReference | null {
  const value = clean(input);
  if (!value || expected === 'file' || isSlackUrl(value)) return null;
  if (isIdLike(value)) return null;

  const prefix = value[0];
  if (prefix === '#' || prefix === '@') {
    const rest = value.slice(1).trim();
    // `@U0123456789` / `#C0123456789` are IDs written with a prefix.
    if (!rest || isIdLike(rest)) return null;
    if (prefix === '#') return acceptsChannel(expected) ? { kind: 'channel', name: rest } : null;
    return acceptsUser(expected) ? { kind: 'user', handle: rest } : null;
  }

  if (EMAIL_PATTERN.test(value)) {
    return acceptsUser(expected) ? { kind: 'email', email: value } : null;
  }

  if (expected === 'channel') return { kind: 'channel', name: value };
  if (expected === 'user') return { kind: 'user', handle: value };
  return { kind: 'channel-or-user', name: value };
}

/**
 * The input with an ID's `@`/`#` prefix removed, so `@U0123456789` is usable as
 * `U0123456789`. Anything else comes back cleaned but otherwise unchanged.
 */
function stripIdPrefix(input: string): string {
  const value = clean(input);
  if ((value.startsWith('@') || value.startsWith('#')) && isIdLike(value.slice(1).trim())) {
    return value.slice(1).trim();
  }
  return value;
}

async function clientFrom(source: NameLookupClientSource): Promise<NameLookupClient> {
  return typeof source === 'function' ? source() : source;
}

interface Candidate {
  id: string;
  label: string;
}

/**
 * Page through a list method, keeping every item `match` accepts. Reads every
 * page: a match on page one does not rule out a second one later.
 */
async function scanPages(
  fetchPage: (cursor: string | undefined) => Promise<any>,
  itemsOf: (response: any) => any[],
  match: (item: any) => boolean,
  progress: (page: number) => void,
): Promise<{ matches: any[]; pages: number }> {
  const matches: any[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    pages += 1;
    progress(pages);
    const response = await fetchPage(cursor);
    for (const item of itemsOf(response)) {
      if (match(item)) matches.push(item);
    }
    const next: string | undefined = response?.response_metadata?.next_cursor || undefined;
    // A cursor Slack hands back twice would loop forever.
    if (next && seen.has(next)) break;
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return { matches, pages };
}

async function findChannels(
  client: NameLookupClient,
  name: string,
  options: ResolveOptions,
): Promise<Candidate[]> {
  const needle = name.toLowerCase();
  const { matches, pages } = await scanPages(
    (cursor) => client.listConversations({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    }),
    (response) => response?.channels ?? [],
    (channel) => typeof channel?.name === 'string' && channel.name.toLowerCase() === needle,
    (page) => options.onProgress?.(`Looking up channel name (page ${page})...`),
  );
  logger.debug('Channel name lookup finished', { pages, matches: matches.length });
  return matches.map((channel) => ({ id: channel.id, label: `#${channel.name}` }));
}

async function findUsersByHandle(
  client: NameLookupClient,
  handles: string[],
  options: ResolveOptions,
): Promise<Map<string, Candidate[]>> {
  const wanted = new Set(handles.map((h) => h.toLowerCase()));
  const { matches, pages } = await scanPages(
    (cursor) => client.listUsers({ limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }),
    (response) => response?.members ?? [],
    (user) => typeof user?.name === 'string' && wanted.has(user.name.toLowerCase()),
    (page) => options.onProgress?.(`Looking up user handle (page ${page})...`),
  );
  logger.debug('User handle lookup finished', { pages, handles: wanted.size, matches: matches.length });

  const byHandle = new Map<string, Candidate[]>();
  for (const handle of wanted) {
    let found = matches.filter((user) => user.name.toLowerCase() === handle);
    // A handle can survive on a deactivated account; prefer the active one.
    if (found.length > 1) {
      const active = found.filter((user) => user.deleted !== true);
      if (active.length > 0) found = active;
    }
    byHandle.set(handle, found.map((user) => ({ id: user.id, label: `@${user.name}` })));
  }
  return byHandle;
}

async function findUserByEmail(client: NameLookupClient, email: string, flag: string): Promise<string> {
  try {
    const response = await client.lookupUserByEmail(email);
    const id = response?.user?.id;
    if (typeof id !== 'string' || !id) {
      throw new NotFoundError(`${flag}: no user with the email address ${email}.`, 'Run "slackcli search people <query>" to find the user.');
    }
    return id;
  } catch (err: any) {
    const code = err?.slackData?.error;
    if (code === 'users_not_found') {
      throw new NotFoundError(
        `${flag}: no user with the email address ${email}.`,
        'Run "slackcli search people <query>" to find the user.',
      );
    }
    if (code === 'missing_scope') {
      // Keep Slack's payload (and so its permission_denied code), with the scope named.
      throw Object.assign(
        new Error(
          `${err.message}: looking a user up by email needs the users:read.email scope. ` +
            'Add it to the Slack app, or pass the user ID or @handle instead.',
          { cause: err },
        ),
        { slackData: err.slackData },
      );
    }
    throw err;
  }
}

const SEARCH_HINT: Record<'channel' | 'user' | 'channel or user', string> = {
  channel: 'Run "slackcli search channels <query>" to find it, then pass its ID.',
  user: 'Run "slackcli search people <query>" to find it, then pass its ID.',
  'channel or user':
    'Run "slackcli search channels <query>" or "slackcli search people <query>" to find it, then pass its ID.',
};

function notFound(flag: string, input: string, what: 'channel' | 'user' | 'channel or user'): NotFoundError {
  return new NotFoundError(`${flag}: no ${what} named "${input}".`, SEARCH_HINT[what]);
}

function ambiguous(flag: string, input: string, candidates: Candidate[], hint?: string): InvalidInputError {
  const list = candidates.map((c) => `${c.id} (${c.label})`).join(', ');
  return new InvalidInputError(
    `${flag}: "${input}" matches more than one: ${list}. Pass the ID you mean.`,
    hint ?? 'Pass one of the listed IDs instead of the name.',
  );
}

function single(flag: string, input: string, candidates: Candidate[], what: 'channel' | 'user'): string {
  if (candidates.length === 0) throw notFound(flag, input, what);
  if (candidates.length > 1) throw ambiguous(flag, input, candidates);
  return candidates[0].id;
}

async function resolveName(
  source: NameLookupClientSource,
  input: string,
  ref: NameReference,
  flag: string,
  options: ResolveOptions,
): Promise<string> {
  const client = await clientFrom(source);
  const shown = clean(input);
  logger.debug('Resolving {kind} name', { kind: ref.kind, flag });

  switch (ref.kind) {
    case 'channel':
      return single(flag, shown, await findChannels(client, ref.name, options), 'channel');
    case 'user': {
      const found = await findUsersByHandle(client, [ref.handle], options);
      return single(flag, shown, found.get(ref.handle.toLowerCase()) ?? [], 'user');
    }
    case 'email':
      options.onProgress?.('Looking up user by email...');
      return findUserByEmail(client, ref.email, flag);
    case 'channel-or-user': {
      const channels = await findChannels(client, ref.name, options);
      const users = (await findUsersByHandle(client, [ref.name], options)).get(ref.name.toLowerCase()) ?? [];
      const candidates = [...channels, ...users];
      if (candidates.length === 0) throw notFound(flag, shown, 'channel or user');
      if (channels.length > 0 && users.length > 0) {
        throw ambiguous(
          flag,
          shown,
          candidates,
          `Write "#${ref.name}" for the channel or "@${ref.name}" for the user.`,
        );
      }
      if (candidates.length > 1) throw ambiguous(flag, shown, candidates);
      return candidates[0].id;
    }
  }
}

/**
 * The ID a command should use for one argument. `raw` is what the user typed
 * (undefined when another flag, such as --permalink, supplied the target) and
 * `id` is what the URL/ID parser already made of it. Only a name triggers a
 * lookup. An ID or URL returns `id` untouched, and an ID written with a
 * prefix (`@U0123456789`, `#C0123456789`) is used without it; neither calls
 * the client.
 */
export async function resolveIdentifier(
  source: NameLookupClientSource,
  raw: string | undefined,
  id: string,
  expected: ExpectedKind,
  flag: string,
  options: ResolveOptions = {},
): Promise<string> {
  if (raw === undefined) return id;
  const ref = parseNameReference(raw, expected);
  if (ref) return resolveName(source, raw, ref, flag, options);
  const unprefixed = stripIdPrefix(raw);
  return unprefixed === clean(raw) ? id : normalizeIdentifier(unprefixed, expected, flag);
}

/**
 * A client created on first use and then reused: pass `get` as the lookup
 * source, and read `created()` afterwards to reuse the client (undefined when
 * no lookup needed one).
 */
export function lazyClient<T extends NameLookupClient>(
  create: () => Promise<T>,
): { get: () => Promise<T>; created: () => T | undefined } {
  let client: T | undefined;
  return {
    get: async () => {
      client ??= await create();
      return client;
    },
    created: () => client,
  };
}

/**
 * Resolve a list of user references (IDs, `@handle`s, handles, email
 * addresses) to user IDs, in input order. All handles share one `users.list`
 * scan; a list of IDs makes no call at all. A leading `@` on an ID is dropped,
 * as before.
 */
export async function resolveUserList(
  source: NameLookupClientSource,
  refs: string[],
  flag: string,
  options: ResolveOptions = {},
): Promise<string[]> {
  const parsed = refs.map((raw) => ({ raw, ref: parseNameReference(raw, 'user') }));
  if (parsed.every((p) => p.ref === null)) return refs.map(stripIdPrefix);

  const client = await clientFrom(source);
  const handles = parsed.flatMap((p) => (p.ref?.kind === 'user' ? [p.ref.handle] : []));
  const byHandle = handles.length > 0 ? await findUsersByHandle(client, handles, options) : new Map();

  const ids: string[] = [];
  for (const { raw, ref } of parsed) {
    if (ref === null) {
      ids.push(stripIdPrefix(raw));
    } else if (ref.kind === 'user') {
      ids.push(single(flag, clean(raw), byHandle.get(ref.handle.toLowerCase()) ?? [], 'user'));
    } else if (ref.kind === 'email') {
      options.onProgress?.('Looking up user by email...');
      ids.push(await findUserByEmail(client, ref.email, flag));
    }
  }
  return ids;
}
