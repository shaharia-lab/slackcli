import { describe, expect, it } from 'bun:test';
import { fetchCustomEmoji, filterEmojiByName, getCustomEmoji, normalizeEmojiMap, parseEmojiLimit } from './emoji.ts';
import {
  addCustomEmoji,
  addCustomEmojiAlias,
  normalizeEmojiName,
  removeCustomEmoji,
  resolveAddMode,
  validateEmojiName,
} from './emoji.ts';
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

describe('validateEmojiName', () => {
  it('accepts lower-case letters, digits, dashes and underscores', () => {
    expect(validateEmojiName('party-kiro_2')).toEqual({ name: 'party-kiro_2' });
  });

  it('strips surrounding colons', () => {
    expect(validateEmojiName(':party:')).toEqual({ name: 'party' });
  });

  it('rejects an empty name', () => {
    expect(validateEmojiName('::').error).toBeDefined();
    expect(validateEmojiName('   ').error).toBeDefined();
  });

  it('rejects upper-case and punctuation', () => {
    expect(validateEmojiName('Party').error).toBeDefined();
    expect(validateEmojiName('party!').error).toBeDefined();
    expect(validateEmojiName('party parrot').error).toBeDefined();
  });
});

describe('normalizeEmojiName', () => {
  it('strips colons and trims', () => {
    expect(normalizeEmojiName('  :foo:  ')).toBe('foo');
  });
});

describe('resolveAddMode', () => {
  it('is data mode for --file', () => {
    expect(resolveAddMode({ file: './x.png' })).toEqual({ mode: 'data' });
  });

  it('is alias mode for --alias-for', () => {
    expect(resolveAddMode({ aliasFor: 'rapid7' })).toEqual({ mode: 'alias' });
  });

  it('rejects both set', () => {
    expect(resolveAddMode({ file: './x.png', aliasFor: 'rapid7' }).error).toBeDefined();
  });

  it('rejects neither set', () => {
    expect(resolveAddMode({}).error).toBeDefined();
    expect(resolveAddMode({ file: '', aliasFor: '' }).error).toBeDefined();
  });
});

describe('addCustomEmoji / addCustomEmojiAlias', () => {
  it('uploads a file and reports a non-alias record', async () => {
    const calls: Array<[string, string]> = [];
    const client = { addEmoji: (n: string, f: string) => { calls.push([n, f]); return Promise.resolve({ ok: true }); } };
    const result = await addCustomEmoji(client as any, 'party', './party.png');
    expect(result).toEqual({ name: 'party', is_alias: false });
    expect(calls).toEqual([['party', './party.png']]);
  });

  it('creates an alias and reports the target', async () => {
    const client = { addEmojiAlias: () => Promise.resolve({ ok: true }) };
    const result = await addCustomEmojiAlias(client as any, 'r7', 'rapid7');
    expect(result).toEqual({ name: 'r7', is_alias: true, alias_for: 'rapid7' });
  });
});

describe('removeCustomEmoji', () => {
  it('reports a real delete', async () => {
    const client = { removeEmoji: () => Promise.resolve({ ok: true }) };
    expect(await removeCustomEmoji(client as any, 'party')).toEqual({
      name: 'party', removed: true, already_removed: false,
    });
  });

  it('is idempotent: a missing emoji is a no-op success (error_emoji_not_found)', async () => {
    const client = {
      removeEmoji: () => Promise.reject(Object.assign(new Error('x'), { slackData: { error: 'error_emoji_not_found' } })),
    };
    expect(await removeCustomEmoji(client as any, 'ghost')).toEqual({
      name: 'ghost', removed: false, already_removed: true,
    });
  });

  it('also treats the bare emoji_not_found code as the no-op', async () => {
    const client = {
      removeEmoji: () => Promise.reject(Object.assign(new Error('x'), { slackData: { error: 'emoji_not_found' } })),
    };
    expect((await removeCustomEmoji(client as any, 'ghost')).already_removed).toBe(true);
  });

  it('rethrows any other error (non-vacuous: a different code must NOT be swallowed)', async () => {
    const client = {
      removeEmoji: () => Promise.reject(Object.assign(new Error('nope'), { slackData: { error: 'not_authed' } })),
    };
    await expect(removeCustomEmoji(client as any, 'party')).rejects.toThrow('nope');
  });

  it('does NOT treat a policy denial (enterprise_is_restricted) as the idempotent no-op', async () => {
    const client = {
      removeEmoji: () => Promise.reject(Object.assign(new Error('restricted'), { slackData: { error: 'enterprise_is_restricted' } })),
    };
    await expect(removeCustomEmoji(client as any, 'party')).rejects.toThrow('restricted');
  });
});
