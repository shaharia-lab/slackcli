/**
 * Parser for the Slack URLs and permalink-style timestamps that Slack's "Copy link"
 * actually produces, so the CLI can accept them wherever it takes an ID or timestamp.
 *
 * Everything here is pure input widening: bare IDs and dotted API timestamps pass
 * through untouched, so every previously-valid invocation keeps working.
 */

import { extractSlackWorkspaceName } from './curl-parser.ts';

/** A parsed Slack message permalink. */
export interface ParsedPermalink {
  channelId: string;
  /** Dotted API form. Absent when the link points at a channel rather than a message. */
  timestamp?: string;
  /** Parent timestamp from ?thread_ts=, present when the link points at a threaded reply. */
  threadTs?: string;
  /** Workspace subdomain, for cross-workspace validation. */
  workspace?: string;
}

/** What a Slack identifier refers to, derived from its prefix letter. */
export type IdentifierKind = 'channel' | 'user' | 'file' | 'team' | 'unknown';

/** What a call site is willing to accept. */
export type ExpectedKind = 'channel' | 'user' | 'file' | 'channel-or-user';

export class SlackUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackUrlParseError';
  }
}

// Matches standard (myteam.slack.com) and enterprise (myorg.enterprise.slack.com) hosts.
const SLACK_URL_PATTERN = /^https?:\/\/[\w.-]+\.slack\.com(?:\/|$)/i;

// Slack IDs are uppercase letter + alphanumerics. Deliberately strict: anything that
// does not look like a real ID is classified 'unknown' and passed through rather than
// rejected, so we never reject an input the API would have accepted.
const SLACK_ID_PATTERN = /^([CDGUWFTE])[A-Z0-9]{6,}$/;

const KIND_BY_PREFIX: Record<string, IdentifierKind> = {
  C: 'channel', // public channel
  D: 'channel', // DM conversation
  G: 'channel', // private channel / MPIM
  U: 'user',
  W: 'user', // enterprise-grid user
  F: 'file', // files, including canvases
  T: 'team',
  E: 'team', // enterprise org
};

const KIND_LABEL: Record<IdentifierKind, string> = {
  channel: 'channel',
  user: 'user',
  file: 'file',
  team: 'workspace',
  unknown: 'value',
};

/**
 * Strip the wrapping Slack itself adds when a link is pasted out of a message
 * (`<https://…>`) plus surrounding whitespace.
 */
function clean(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** True when the input looks like a Slack web URL. */
export function isSlackUrl(input: string): boolean {
  return SLACK_URL_PATTERN.test(clean(input));
}

/**
 * The workspace subdomain an input belongs to, or undefined when it is not a Slack URL
 * (a bare ID carries no workspace).
 */
export function workspaceOf(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const value = clean(input);
  if (!isSlackUrl(value)) return undefined;
  try {
    return workspaceOfUrl(new URL(value));
  } catch {
    return undefined;
  }
}

/**
 * The workspace subdomain of an already-parsed Slack URL. Reads from `origin`, which
 * the URL parser has lowercased, so a host typed as `MyTeam.SLACK.com` still resolves.
 */
function workspaceOfUrl(url: URL): string {
  return extractSlackWorkspaceName(url.origin);
}

/** Classify a bare Slack identifier by its prefix letter. */
export function identifierKind(id: string): IdentifierKind {
  const match = id.match(SLACK_ID_PATTERN);
  if (!match) return 'unknown';
  return KIND_BY_PREFIX[match[1]] ?? 'unknown';
}

function accepts(expected: ExpectedKind, kind: IdentifierKind): boolean {
  // 'unknown' always passes: we only reject an input we positively recognise
  // as the wrong type.
  if (kind === 'unknown') return true;
  if (expected === 'channel-or-user') return kind === 'channel' || kind === 'user';
  return kind === expected;
}

function expectedLabel(expected: ExpectedKind): string {
  return expected === 'channel-or-user' ? 'channel or user' : expected;
}

function assertKind(id: string, expected: ExpectedKind, flag: string): string {
  const kind = identifierKind(id);
  if (!accepts(expected, kind)) {
    throw new SlackUrlParseError(
      `${flag} expects a ${expectedLabel(expected)} ID, but got a ${KIND_LABEL[kind]} ID (${id}).`
    );
  }
  return id;
}

/**
 * Parse the path of a Slack URL into the identifier it names.
 * Returns null when the URL is a Slack URL but not one we recognise.
 */
function identifierFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [area, first, second] = segments;

  // /archives/<channel>[/p<ts>] and /team/<user>
  if (area === 'archives' || area === 'team') return first;

  // /docs/<team>/<file> — canvas documents
  if (area === 'docs' && second) return second;

  return null;
}

/**
 * A Slack URL or a bare ID -> a bare ID. Bare IDs pass through unchanged.
 *
 * `flag` names the CLI input in error messages (e.g. `--channel-id`).
 */
export function normalizeIdentifier(input: string, expected: ExpectedKind, flag: string): string {
  const value = clean(input);
  if (!value) {
    throw new SlackUrlParseError(`${flag} requires a value.`);
  }

  if (!isSlackUrl(value)) {
    return assertKind(value, expected, flag);
  }

  const id = identifierFromUrl(value);
  if (!id) {
    throw new SlackUrlParseError(
      `${flag} could not read an ID out of this Slack URL: ${value}. ` +
        `Supported forms are /archives/<channel>, /team/<user>, and /docs/<team>/<file>.`
    );
  }

  return assertKind(id, expected, flag);
}

/**
 * A permalink-style or bare timestamp -> the dotted API form.
 *
 * Slack permalinks carry `p<10 second digits><6 microsecond digits>`; the API wants
 * those two halves separated by a dot. Plain epoch seconds (used for `--oldest` /
 * `--latest` range bounds) and already-dotted values pass through unchanged.
 */
export function normalizeTimestamp(input: string, flag: string): string {
  const value = clean(input);
  if (!value) {
    throw new SlackUrlParseError(`${flag} requires a value.`);
  }

  if (isSlackUrl(value)) {
    throw new SlackUrlParseError(
      `${flag} expects a timestamp, but got a Slack URL. Use --permalink ${value} instead.`
    );
  }

  // Already in API form.
  if (/^\d+\.\d+$/.test(value)) return value;

  const permalinkForm = value.match(/^p(\d+)$/);
  if (permalinkForm) {
    const digits = permalinkForm[1];
    if (digits.length !== 16) {
      throw new SlackUrlParseError(
        `${flag} got a permalink-style timestamp with ${digits.length} digits; expected 16 (p<10 second digits><6 microsecond digits>).`
      );
    }
    return `${digits.slice(0, 10)}.${digits.slice(10)}`;
  }

  if (/^\d+$/.test(value)) {
    // 16 digits is the permalink form without its `p`; anything shorter is epoch
    // seconds, which Slack accepts as-is for range bounds.
    if (value.length === 16) return `${value.slice(0, 10)}.${value.slice(10)}`;
    return value;
  }

  throw new SlackUrlParseError(
    `${flag} is not a valid Slack timestamp: ${value}. ` +
      `Expected 1234567890.123456, 1234567890123456, or p1234567890123456.`
  );
}

/**
 * A Slack link -> the channel it names, plus the message timestamp when the link
 * points at one. Accepts both `/archives/<channel>` and `/archives/<channel>/p<ts>`.
 */
export function parseSlackLink(input: string): ParsedPermalink {
  const value = clean(input);

  if (!isSlackUrl(value)) {
    throw new SlackUrlParseError(`Not a Slack URL: ${value}.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackUrlParseError(`Not a valid URL: ${value}.`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'archives' || !segments[1]) {
    throw new SlackUrlParseError(
      `Not a Slack message link: ${value}. Expected https://<workspace>.slack.com/archives/<channel>/p<timestamp>.`
    );
  }

  const channelId = segments[1];
  const kind = identifierKind(channelId);
  if (kind !== 'channel' && kind !== 'unknown') {
    throw new SlackUrlParseError(
      `Slack link names a ${KIND_LABEL[kind]} ID (${channelId}) where a channel was expected: ${value}.`
    );
  }

  const result: ParsedPermalink = {
    channelId,
    workspace: workspaceOfUrl(url),
  };

  const messageSegment = segments[2];
  if (messageSegment) {
    if (!/^p\d+$/.test(messageSegment)) {
      throw new SlackUrlParseError(
        `Slack link has an unexpected message segment (${messageSegment}): ${value}.`
      );
    }
    result.timestamp = normalizeTimestamp(messageSegment, 'permalink');
  }

  // On a link to a threaded reply the path holds the *reply* timestamp and
  // ?thread_ts= holds the parent — the value every --thread-ts consumer wants.
  const threadTs = url.searchParams.get('thread_ts');
  if (threadTs) {
    result.threadTs = normalizeTimestamp(threadTs, 'permalink thread_ts');
  }

  return result;
}

/**
 * Strict form of {@link parseSlackLink}: the link must point at a specific message.
 */
export function parsePermalink(input: string): ParsedPermalink & { timestamp: string } {
  const parsed = parseSlackLink(input);
  if (!parsed.timestamp) {
    throw new SlackUrlParseError(
      `Slack link does not point at a message: ${clean(input)}. ` +
        `Expected https://<workspace>.slack.com/archives/<channel>/p<timestamp>.`
    );
  }
  return parsed as ParsedPermalink & { timestamp: string };
}

/**
 * The thread a link belongs to: the parent timestamp for a reply, otherwise the
 * message's own timestamp (a top-level message is its own thread parent).
 */
export function threadParentOf(parsed: ParsedPermalink): string | undefined {
  return parsed.threadTs ?? parsed.timestamp;
}

/** Raw CLI inputs for a command that targets one specific message. */
export interface MessageTargetInput {
  permalink?: string;
  channelId?: string;
  timestamp?: string;
}

/** Raw CLI inputs for a command that targets a conversation, optionally a thread in it. */
export interface ThreadTargetInput {
  permalink?: string;
  channelId?: string;
  threadTs?: string;
}

export interface ResolvedMessageTarget {
  channelId: string;
  timestamp: string;
  workspace?: string;
}

export interface ResolvedThreadTarget {
  channelId: string;
  threadTs?: string;
  workspace?: string;
}

interface TargetFlags {
  /** Name of the channel/recipient input, for error messages. */
  channel: string;
  /** Name of the timestamp input, for error messages. */
  timestamp: string;
}

/** `--permalink` supplies both inputs, so pairing it with either of them is ambiguous. */
function assertNoConflict(supplied: Array<[flag: string, value: string | undefined]>): void {
  const conflicting = supplied.filter(([, value]) => value).map(([flag]) => flag);
  if (conflicting.length > 0) {
    throw new SlackUrlParseError(
      `--permalink already supplies ${conflicting.join(' and ')}; pass one or the other, not both.`
    );
  }
}

/**
 * Resolve the channel + timestamp of a command targeting one specific message,
 * from either `--permalink` or the explicit inputs (never both).
 */
export function resolveMessageTarget(
  input: MessageTargetInput,
  flags: TargetFlags
): ResolvedMessageTarget {
  if (input.permalink) {
    assertNoConflict([[flags.channel, input.channelId], [flags.timestamp, input.timestamp]]);
    const parsed = parsePermalink(input.permalink);
    return {
      channelId: parsed.channelId,
      timestamp: parsed.timestamp,
      workspace: parsed.workspace,
    };
  }

  if (!input.channelId || !input.timestamp) {
    const missing = [!input.channelId ? flags.channel : '', !input.timestamp ? flags.timestamp : '']
      .filter(Boolean)
      .join(' and ');
    throw new SlackUrlParseError(
      `Missing ${missing}. Pass ${flags.channel} and ${flags.timestamp}, or a single --permalink <url>.`
    );
  }

  return {
    channelId: normalizeIdentifier(input.channelId, 'channel', flags.channel),
    timestamp: normalizeTimestamp(input.timestamp, flags.timestamp),
    workspace: workspaceOf(input.channelId),
  };
}

/**
 * Resolve the conversation (and thread, when one is named) of a command that reads or
 * posts into a channel, from either `--permalink` or the explicit inputs.
 *
 * A permalink pointing at a message resolves to that message's thread; a bare channel
 * link resolves to the channel with no thread.
 */
export function resolveThreadTarget(
  input: ThreadTargetInput,
  flags: TargetFlags,
  expected: ExpectedKind = 'channel'
): ResolvedThreadTarget {
  if (input.permalink) {
    assertNoConflict([[flags.channel, input.channelId], [flags.timestamp, input.threadTs]]);
    const parsed = parseSlackLink(input.permalink);
    return {
      channelId: parsed.channelId,
      threadTs: threadParentOf(parsed),
      workspace: parsed.workspace,
    };
  }

  if (!input.channelId) {
    throw new SlackUrlParseError(
      `Missing ${flags.channel}. Pass ${flags.channel}, or a single --permalink <url>.`
    );
  }

  return {
    channelId: normalizeIdentifier(input.channelId, expected, flags.channel),
    threadTs: input.threadTs ? normalizeTimestamp(input.threadTs, flags.timestamp) : undefined,
    workspace: workspaceOf(input.channelId),
  };
}

/**
 * Warning text when a pasted link belongs to a different workspace than the one the
 * command will run against — otherwise Slack answers with a misleading
 * `message_not_found`. Returns null when there is nothing to warn about.
 */
export function workspaceMismatchWarning(
  linkWorkspace: string | undefined,
  clientWorkspace: string | undefined
): string | null {
  if (!linkWorkspace || !clientWorkspace) return null;
  if (linkWorkspace.toLowerCase() === clientWorkspace.toLowerCase()) return null;
  return (
    `This link belongs to the "${linkWorkspace}" workspace but you are authenticated ` +
    `against "${clientWorkspace}". Use --workspace to pick the matching workspace if this fails.`
  );
}
