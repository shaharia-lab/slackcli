import type { SlackClient } from './slack-client.ts';
import type { CustomEmoji } from '../types/index.ts';

// Validate and parse the `emoji list --limit` option value. The command slices
// its already-fetched list locally rather than handing the value to Slack, so a
// non-numeric or non-positive value must be rejected here — otherwise
// `parseInt('abc')` yields NaN and `slice(0, NaN)` returns an empty list,
// making a bad flag look like an empty workspace. Returns the parsed limit, or
// an `error` message when the value is not a positive integer.
export function parseEmojiLimit(value: string): { limit?: number; error?: string } {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 1) {
    return { error: 'Limit must be a positive integer' };
  }
  return { limit };
}

// Narrow an already-fetched emoji list to those whose name contains `substring`,
// matched case-insensitively. Like `--no-aliases` and `--limit`, this is a local
// filter over the one `emoji.list` fetch — Slack exposes no `emoji.search`, and
// this mirrors the composer's `:name…` autocomplete (a client-side filter over an
// already-loaded map). Matches the name only, to keep the predicate surface the
// same as `getCustomEmoji`.
//
// Surrounding colons are stripped the way `getCustomEmoji` strips them, so
// `--filter :kiro:` and `--filter kiro` behave the same. An empty value (or one
// that is only colons/whitespace) is rejected rather than silently matching
// everything, mirroring how `parseEmojiLimit` rejects a bad `--limit`: returns
// the filtered list, or an `error` message the command surfaces as an
// `InvalidInputError`.
export function filterEmojiByName(
  emoji: CustomEmoji[],
  substring: string,
): { emoji?: CustomEmoji[]; error?: string } {
  const needle = substring.replace(/^:|:$/g, '').trim().toLowerCase();
  if (needle === '') {
    return { error: 'Filter must not be empty' };
  }
  return { emoji: emoji.filter((e) => e.name.toLowerCase().includes(needle)) };
}

// Slack's emoji.list returns a flat map of name -> value, where the value is
// either an image URL for a real custom emoji or the string "alias:<target>"
// pointing at another emoji (custom or built-in). This normalises that map into
// a typed, name-sorted list so the command and formatter never touch the raw
// shape.
export function normalizeEmojiMap(map: Record<string, string>): CustomEmoji[] {
  const emoji: CustomEmoji[] = Object.entries(map).map(([name, value]) => {
    if (typeof value === 'string' && value.startsWith('alias:')) {
      return { name, is_alias: true, alias_for: value.slice('alias:'.length) };
    }
    return { name, is_alias: false, url: value };
  });

  emoji.sort((a, b) => a.name.localeCompare(b.name));
  return emoji;
}

// Fetch the workspace's custom emoji as a normalised, sorted list.
export async function fetchCustomEmoji(
  client: SlackClient,
  options: { onProgress?: (message: string) => void } = {},
): Promise<CustomEmoji[]> {
  options.onProgress?.('Fetching custom emoji...');
  const response = await client.listEmoji();
  const map: Record<string, string> = response?.emoji ?? {};
  return normalizeEmojiMap(map);
}

// Look up a single custom emoji by name. The name is matched with any
// surrounding colons stripped, so both `party-parrot` and `:party-parrot:`
// resolve. Returns undefined when the workspace has no such custom emoji.
export async function getCustomEmoji(
  client: SlackClient,
  name: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<CustomEmoji | undefined> {
  const target = name.replace(/^:|:$/g, '');
  const emoji = await fetchCustomEmoji(client, options);
  return emoji.find((e) => e.name === target);
}

// --- Write actions: emoji add / emoji remove ---------------------------------

// Slack's custom-emoji guidance: a square image, no larger than 128x128, under
// 64 KB. Oversizing is a warn, not a block — Slack itself downscales — so these
// bound the pre-flight warning rather than a hard reject.
export const EMOJI_MAX_BYTES = 64 * 1024;

// Strip the optional surrounding colons the way getCustomEmoji/filter do, so
// `add :foo:` and `add foo` name the same emoji.
export function normalizeEmojiName(name: string): string {
  return name.trim().replace(/^:|:$/g, '').trim();
}

// Slack accepts lower-case letters, digits, dashes and underscores in a custom
// emoji name. Reject anything else locally so a bad name fails with a clear CLI
// error instead of a raw `error_name_taken`/`error_bad_name_i18n` from Slack.
export function validateEmojiName(name: string): { name?: string; error?: string } {
  const normalized = normalizeEmojiName(name);
  if (normalized === '') {
    return { error: 'Emoji name must not be empty' };
  }
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return { error: 'Emoji name may use only lower-case letters, digits, dashes and underscores' };
  }
  return { name: normalized };
}

// Decide what `emoji add` is doing from its two mutually exclusive inputs. Both
// set or neither set is a usage error; otherwise report the mode so the command
// routes to the file upload or the alias call.
export function resolveAddMode(
  options: { file?: string; aliasFor?: string },
): { mode?: 'data' | 'alias'; error?: string } {
  const hasFile = options.file !== undefined && options.file !== '';
  const hasAlias = options.aliasFor !== undefined && options.aliasFor !== '';
  if (hasFile && hasAlias) {
    return { error: 'Use either --file or --alias-for, not both' };
  }
  if (!hasFile && !hasAlias) {
    return { error: 'Provide --file <path> to upload an image, or --alias-for <existing> to alias' };
  }
  return { mode: hasFile ? 'data' : 'alias' };
}

export interface AddedEmojiResult {
  name: string;
  is_alias: boolean;
  alias_for?: string;
}

export interface RemovedEmojiResult {
  name: string;
  removed: boolean;
  already_removed: boolean;
}

// Upload a local image as a new custom emoji. Returns the added record. Slack
// answers 200 with { ok:false, error } on failure; the client's request path
// turns that into a thrown error with slackData, so a genuine failure (e.g.
// error_name_taken) propagates.
export async function addCustomEmoji(
  client: Pick<SlackClient, 'addEmoji'>,
  name: string,
  filePath: string,
): Promise<AddedEmojiResult> {
  await client.addEmoji(name, filePath);
  return { name, is_alias: false };
}

// Create an alias of an existing emoji. Returns the added alias record.
export async function addCustomEmojiAlias(
  client: Pick<SlackClient, 'addEmojiAlias'>,
  name: string,
  aliasFor: string,
): Promise<AddedEmojiResult> {
  await client.addEmojiAlias(name, aliasFor);
  return { name, is_alias: true, alias_for: aliasFor };
}

// Remove a custom emoji. Idempotent: Slack answers error_emoji_not_found when
// the name is gone; that is a success with
// `removed: false, already_removed: true`, so a retry is safe. Every other
// failure is rethrown. (Mirrors deleteMessage/removeReaction in message.ts.)
export async function removeCustomEmoji(
  client: Pick<SlackClient, 'removeEmoji'>,
  name: string,
): Promise<RemovedEmojiResult> {
  try {
    await client.removeEmoji(name);
    return { name, removed: true, already_removed: false };
  } catch (error) {
    const code = (error as { slackData?: { error?: unknown } })?.slackData?.error;
    if (code !== 'error_emoji_not_found' && code !== 'emoji_not_found') throw error;
    return { name, removed: false, already_removed: true };
  }
}
