import type { SlackClient } from './slack-client.ts';
import type { CustomEmoji } from '../types/index.ts';

// Validate and parse the `emoji list --limit` option value. The command slices
// its already-fetched list locally rather than handing the value to Slack, so a
// non-numeric or non-positive value must be rejected here — otherwise
// `parseInt('abc')` yields NaN and `slice(0, NaN)` returns an empty list,
// making a bad flag look like an empty workspace. Returns the parsed limit, or
// an `error` message when the value is not a positive integer.
export function parseEmojiLimit(value: string): { limit?: number; error?: string } {
  const limit = parseInt(value, 10);
  if (isNaN(limit) || limit < 1) {
    return { error: 'Limit must be a positive integer' };
  }
  return { limit };
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
