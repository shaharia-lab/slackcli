import { describe, expect, it } from 'bun:test';
import { fetchCustomEmoji, filterEmojiByName, getCustomEmoji, normalizeEmojiMap, parseEmojiLimit } from './emoji.ts';
import type { CustomEmoji } from '../types/index.ts';
import type { SlackClient } from './slack-client.ts';

function createMockClient(
  overrides: { listEmoji?: () => Promise<any> } = {},
): SlackClient {
  return {
    listEmoji: overrides.listEmoji ?? (() => Promise.resolve({ ok: true, emoji: {} })),
  } as unknown as SlackClient;
}

describe('normalizeEmojiMap', () => {
  it('maps a URL value to an original (non-alias) emoji', () => {
    const result = normalizeEmojiMap({ parrot: 'https://emoji.example/parrot.gif' });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'parrot',
      is_alias: false,
      url: 'https://emoji.example/parrot.gif',
    });
  });

  it('maps an "alias:" value to an alias emoji with its target', () => {
    const result = normalizeEmojiMap({ shipit: 'alias:squirrel' });
    expect(result[0]).toEqual({ name: 'shipit', is_alias: true, alias_for: 'squirrel' });
  });

  it('sorts emoji by name', () => {
    const result = normalizeEmojiMap({
      zebra: 'https://emoji.example/z.png',
      apple: 'https://emoji.example/a.png',
      mango: 'alias:apple',
    });
    expect(result.map(e => e.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('returns an empty list for an empty map', () => {
    expect(normalizeEmojiMap({})).toEqual([]);
  });
});

describe('fetchCustomEmoji', () => {
  it('normalizes the emoji.list response', async () => {
    const client = createMockClient({
      listEmoji: () => Promise.resolve({
        ok: true,
        emoji: {
          beta: 'https://emoji.example/beta.png',
          alpha: 'alias:beta',
        },
      }),
    });

    const result = await fetchCustomEmoji(client);
    expect(result.map(e => e.name)).toEqual(['alpha', 'beta']);
    expect(result[0].is_alias).toBe(true);
    expect(result[1].is_alias).toBe(false);
  });

  it('tolerates a response with no emoji field', async () => {
    const client = createMockClient({ listEmoji: () => Promise.resolve({ ok: true }) });
    expect(await fetchCustomEmoji(client)).toEqual([]);
  });

  it('reports progress through the onProgress callback', async () => {
    const messages: string[] = [];
    const client = createMockClient();
    await fetchCustomEmoji(client, { onProgress: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe('getCustomEmoji', () => {
  const client = createMockClient({
    listEmoji: () => Promise.resolve({
      ok: true,
      emoji: { 'party-parrot': 'https://emoji.example/pp.gif' },
    }),
  });

  it('finds an emoji by bare name', async () => {
    const found = await getCustomEmoji(client, 'party-parrot');
    expect(found?.name).toBe('party-parrot');
  });

  it('finds an emoji when the name is wrapped in colons', async () => {
    const found = await getCustomEmoji(client, ':party-parrot:');
    expect(found?.name).toBe('party-parrot');
  });

  it('returns undefined for an unknown emoji', async () => {
    expect(await getCustomEmoji(client, 'does-not-exist')).toBeUndefined();
  });
});

describe('parseEmojiLimit', () => {
  it('accepts a positive integer', () => {
    expect(parseEmojiLimit('5')).toEqual({ limit: 5 });
  });

  it('parses the leading integer of a numeric string', () => {
    expect(parseEmojiLimit('10')).toEqual({ limit: 10 });
  });

  it('rejects a non-numeric value instead of yielding NaN', () => {
    // Regression: parseInt('abc') is NaN and slice(0, NaN) returns [], which
    // made `--limit abc` look like an empty workspace rather than an error.
    expect(parseEmojiLimit('abc')).toEqual({ error: 'Limit must be a positive integer' });
  });

  it('rejects a negative value instead of dropping from the tail', () => {
    // Regression: slice(0, -2) silently drops the last two entries.
    expect(parseEmojiLimit('-2')).toEqual({ error: 'Limit must be a positive integer' });
  });

  it('rejects zero', () => {
    expect(parseEmojiLimit('0')).toEqual({ error: 'Limit must be a positive integer' });
  });
});

describe('filterEmojiByName', () => {
  const emoji: CustomEmoji[] = [
    { name: 'kiro', is_alias: false, url: 'https://emoji.example/kiro.png' },
    { name: 'kiro-cli', is_alias: false, url: 'https://emoji.example/kiro-cli.png' },
    { name: 'scumbag-kiro', is_alias: true, alias_for: 'kiro' },
    { name: 'party-parrot', is_alias: false, url: 'https://emoji.example/pp.gif' },
    { name: 'KIROV', is_alias: false, url: 'https://emoji.example/kirov.png' },
  ];

  it('keeps only names containing the substring', () => {
    expect(filterEmojiByName(emoji, 'parrot').emoji?.map(e => e.name)).toEqual(['party-parrot']);
  });

  it('matches a substring anywhere in the name, not just the prefix', () => {
    // The composer autocomplete behaviour the issue cites: `:kiro` surfaces
    // scumbag-kiro too, not only names that start with it.
    expect(filterEmojiByName(emoji, 'kiro').emoji?.map(e => e.name))
      .toEqual(['kiro', 'kiro-cli', 'scumbag-kiro', 'KIROV']);
  });

  it('is case-insensitive on both the needle and the name', () => {
    expect(filterEmojiByName(emoji, 'KIRO').emoji?.map(e => e.name))
      .toEqual(['kiro', 'kiro-cli', 'scumbag-kiro', 'KIROV']);
  });

  it('strips surrounding colons the way emoji get does', () => {
    // `--filter :kiro:` and `--filter kiro` must behave identically.
    expect(filterEmojiByName(emoji, ':kiro:').emoji?.map(e => e.name))
      .toEqual(['kiro', 'kiro-cli', 'scumbag-kiro', 'KIROV']);
    expect(filterEmojiByName(emoji, ':parrot').emoji?.map(e => e.name)).toEqual(['party-parrot']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterEmojiByName(emoji, 'zzz').emoji).toEqual([]);
  });

  it('rejects an empty or colons/whitespace-only value instead of matching everything', () => {
    expect(filterEmojiByName(emoji, '')).toEqual({ error: 'Filter must not be empty' });
    expect(filterEmojiByName(emoji, '   ')).toEqual({ error: 'Filter must not be empty' });
    expect(filterEmojiByName(emoji, '::')).toEqual({ error: 'Filter must not be empty' });
  });

  it('does not mutate the input list', () => {
    const before = emoji.length;
    filterEmojiByName(emoji, 'kiro');
    expect(emoji).toHaveLength(before);
  });
});
