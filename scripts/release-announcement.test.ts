import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAnnouncement,
  EMBED_DESCRIPTION_LIMIT,
  INSTALL_HINT,
  releaseUrl,
  truncateNotes,
} from './release-announcement';

const RELEASE_URL = 'https://github.com/shaharia-lab/slackcli/releases/tag/v1.2.3';
const LINK = `[Full release notes](${RELEASE_URL})`;
const FOOTER = `\n\n${INSTALL_HINT}`;

/** `count` lines of `width` characters each, joined by newlines. */
function lines(count: number, width: number): string {
  return Array.from({ length: count }, (_, i) => `${i}`.padStart(4, '0').padEnd(width, 'x')).join('\n');
}

describe('truncateNotes', () => {
  it('returns short notes untouched', () => {
    expect(truncateNotes('## What changed\n* a fix', RELEASE_URL, 200)).toBe('## What changed\n* a fix');
  });

  it('returns notes of exactly the limit untouched', () => {
    const body = lines(10, 19); // 10 * 19 + 9 newlines = 199
    expect(body).toHaveLength(199);
    expect(truncateNotes(body, RELEASE_URL, 199)).toBe(body);
  });

  it('cuts notes one character over the limit', () => {
    const body = lines(10, 19) + 'y';
    const out = truncateNotes(body, RELEASE_URL, 199);
    expect(out).not.toBe(body);
    expect(out.length).toBeLessThanOrEqual(199);
  });

  it('cuts on a line boundary and ends with the full-notes link', () => {
    const body = lines(100, 20);
    const out = truncateNotes(body, RELEASE_URL, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith(`\n\n${LINK}`)).toBe(true);
    const kept = out.slice(0, -`\n\n${LINK}`.length);
    // Every kept line is a whole line of the original, in order from the top.
    expect(body.startsWith(`${kept}\n`)).toBe(true);
    expect(kept.split('\n').every((line) => line.length === 20)).toBe(true);
    // It keeps as many whole lines as fit, not fewer.
    const room = 500 - `\n\n${LINK}`.length;
    expect(kept.length + 21).toBeGreaterThan(room);
  });

  it('keeps the last line when the cut falls exactly on its end', () => {
    const link = `\n\n${LINK}`;
    const body = lines(20, 20); // lines end at 20, 41, 62, ...
    const out = truncateNotes(body, RELEASE_URL, 62 + link.length);
    expect(out).toBe(`${body.slice(0, 62)}${link}`);
  });

  it('cuts a single line with no newline mid-line, within the limit', () => {
    const out = truncateNotes('a'.repeat(5000), RELEASE_URL, 300);
    expect(out).toHaveLength(300);
    expect(out.endsWith(`\n\n${LINK}`)).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const link = `\n\n${LINK}`;
    // An odd amount of room would cut the last emoji (2 code units) in half.
    const out = truncateNotes('😀'.repeat(400), RELEASE_URL, 101 + link.length);
    const kept = out.slice(0, -link.length);
    expect(kept).toBe('😀'.repeat(50));
    // No high surrogate left without its low half.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('counts multi-byte characters as UTF-16 code units, so it never exceeds the limit', () => {
    const body = Array.from({ length: 300 }, () => 'ünïcödé 日本語 😀').join('\n');
    const out = truncateNotes(body, RELEASE_URL, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect([...out].length).toBeLessThanOrEqual(1000);
    expect(out.endsWith(LINK)).toBe(true);
  });

  it('falls back to the link alone when the first line is blank padding', () => {
    expect(truncateNotes(' '.repeat(600), RELEASE_URL, 200)).toBe(LINK);
  });

  it('refuses a limit too small to hold the link', () => {
    expect(() => truncateNotes('a'.repeat(100), RELEASE_URL, LINK.length)).toThrow(RangeError);
  });
});

describe('buildAnnouncement', () => {
  it('builds the title and link from the tag', () => {
    const payload = buildAnnouncement({ tag: 'v1.2.3', body: 'notes' });
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].title).toBe('SlackCLI v1.2.3');
    expect(payload.embeds[0].url).toBe(RELEASE_URL);
    expect(releaseUrl('v1.2.3')).toBe(RELEASE_URL);
  });

  it('prefers the URL GitHub reports for the release', () => {
    const url = 'https://github.com/shaharia-lab/slackcli/releases/tag/v9.9.9';
    expect(buildAnnouncement({ tag: 'v1.2.3', url, body: 'notes' }).embeds[0].url).toBe(url);
  });

  it('puts the notes first and the install hint last', () => {
    const { description } = buildAnnouncement({ tag: 'v1.2.3', url: RELEASE_URL, body: '## What changed\n* a fix\n' }).embeds[0];
    expect(description).toBe(`## What changed\n* a fix${FOOTER}`);
    expect(description).toContain('brew tap shaharia-lab/tap && brew install slackcli');
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\n '],
    ['null', null],
    ['missing', undefined],
  ])('links to the release when the body is %s', (_label, body) => {
    const { description } = buildAnnouncement({ tag: 'v1.2.3', url: RELEASE_URL, body }).embeds[0];
    expect(description).toBe(`${LINK}${FOOTER}`);
  });

  it('keeps notes that exactly fill the description', () => {
    const body = 'n'.repeat(EMBED_DESCRIPTION_LIMIT - FOOTER.length);
    const { description } = buildAnnouncement({ tag: 'v1.2.3', url: RELEASE_URL, body }).embeds[0];
    expect(description).toHaveLength(EMBED_DESCRIPTION_LIMIT);
    expect(description).toBe(`${body}${FOOTER}`);
  });

  it('truncates long notes so the description stays within 4096 and keeps the hint', () => {
    expect(EMBED_DESCRIPTION_LIMIT).toBe(4096);
    const body = lines(400, 60); // ~24 KB, like a large generated changelog
    const { description } = buildAnnouncement({ tag: 'v1.2.3', url: RELEASE_URL, body }).embeds[0];
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description.length).toBeGreaterThan(4096 - 62);
    expect(description.endsWith(`\n\n${LINK}${FOOTER}`)).toBe(true);
  });

  it.each(['@everyone', '@here', '<@&123456789012345678>', '<@123456789012345678>'])(
    'suppresses every mention when the notes contain %s',
    (mention) => {
      const payload = buildAnnouncement({ tag: 'v1.2.3', url: RELEASE_URL, body: `* fix by ${mention}` });
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      // Sent as written; allowed_mentions is what stops the ping.
      expect(payload.embeds[0].description).toContain(mention);
      expect(Object.keys(payload).sort()).toEqual(['allowed_mentions', 'embeds']);
    },
  );
});

describe('scripts/release-announcement.ts', () => {
  const script = join(import.meta.dir, 'release-announcement.ts');
  const dir = mkdtempSync(join(tmpdir(), 'release-announcement-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(...args: string[]) {
    const res = Bun.spawnSync([process.execPath, 'run', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  }

  it('prints one JSON payload for a `gh release view --json body,url` file', () => {
    const file = join(dir, 'release.json');
    writeFileSync(file, JSON.stringify({ body: '* a fix\r\n* @everyone', url: RELEASE_URL }));
    const res = run(file, 'v1.2.3');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(buildAnnouncement({ tag: 'v1.2.3', url: RELEASE_URL, body: '* a fix\r\n* @everyone' }));
    expect(res.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it('exits 1 with usage when an argument is missing', () => {
    const res = run();
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Usage: bun run scripts/release-announcement.ts');
  });

  it('exits non-zero and prints no payload when the file is not JSON', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, 'not json');
    const res = run(file, 'v1.2.3');
    expect(res.code).not.toBe(0);
    expect(res.stdout).toBe('');
  });

  it('does nothing when imported', () => {
    const res = Bun.spawnSync([process.execPath, '-e', `await import(${JSON.stringify(script)}); console.log('imported')`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(res.stdout.toString().trim()).toBe('imported');
    expect(res.exitCode).toBe(0);
  });
});
