#!/usr/bin/env bun
/**
 * Build the Discord webhook payload that announces a release (#358).
 * Usage: bun run scripts/release-announcement.ts <release.json> <tag>
 * where release.json is the output of `gh release view <tag> --json body,url`.
 * Prints the payload as JSON on stdout; release.yml posts it with curl.
 */

/** Discord rejects an embed whose description is longer than this. */
export const EMBED_DESCRIPTION_LIMIT = 4096;

export const INSTALL_HINT = 'Install or upgrade with Homebrew: `brew tap shaharia-lab/tap && brew install slackcli`';

const REPO_URL = 'https://github.com/shaharia-lab/slackcli';
const SEPARATOR = '\n\n';

export interface ReleaseInfo {
  tag: string;
  url?: string | null;
  body?: string | null;
}

export interface DiscordPayload {
  embeds: [{ title: string; url: string; description: string }];
  allowed_mentions: { parse: [] };
}

export function releaseUrl(tag: string): string {
  return `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;
}

function fullNotesLink(url: string): string {
  return `[Full release notes](${url})`;
}

/**
 * Cut `text` to at most `max` UTF-16 code units, on a line boundary when one
 * exists. A single line longer than `max` is cut mid-line, never between the
 * two halves of a surrogate pair (that would leave invalid JSON text).
 */
function cutOnLineBoundary(text: string, max: number): string {
  const head = text.slice(0, max);
  // The cut is clean when the next character starts a new line.
  const lineEnd = text[max] === '\n' ? max : head.lastIndexOf('\n');
  if (lineEnd > 0) return head.slice(0, lineEnd).trimEnd();
  const last = head.charCodeAt(head.length - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return (splitsPair ? head.slice(0, -1) : head).trimEnd();
}

/**
 * Returns `body` unchanged when it fits in `limit`, otherwise its leading
 * lines followed by a link to the full notes, the whole staying within
 * `limit`. Lengths are UTF-16 code units, which never undercount Discord's
 * character limit.
 */
export function truncateNotes(body: string, url: string, limit: number): string {
  if (body.length <= limit) return body;
  const link = fullNotesLink(url);
  const room = limit - link.length - SEPARATOR.length;
  if (room <= 0) {
    throw new RangeError(`A limit of ${limit} leaves no room for the release notes link`);
  }
  const kept = cutOnLineBoundary(body, room);
  return kept ? `${kept}${SEPARATOR}${link}` : link;
}

export function buildAnnouncement({ tag, url, body }: ReleaseInfo): DiscordPayload {
  const link = url || releaseUrl(tag);
  const notes = (body ?? '').trim();
  const footer = `${SEPARATOR}${INSTALL_HINT}`;
  const description = notes
    ? truncateNotes(notes, link, EMBED_DESCRIPTION_LIMIT - footer.length) + footer
    : fullNotesLink(link) + footer;
  return {
    embeds: [{ title: `SlackCLI ${tag}`, url: link, description }],
    // Release notes are free text: without this an "@everyone" in a PR title
    // would ping the whole server.
    allowed_mentions: { parse: [] },
  };
}

// Guarded so the tests can import the builder without reading argv.
if (import.meta.main) {
  const [file, tag] = process.argv.slice(2);
  if (!file || !tag) {
    console.error('Usage: bun run scripts/release-announcement.ts <release.json> <tag>');
    process.exit(1);
  }
  const release = (await Bun.file(file).json()) as Partial<ReleaseInfo>;
  console.log(JSON.stringify(buildAnnouncement({ tag, url: release.url, body: release.body })));
}
