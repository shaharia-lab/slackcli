import { describe, expect, it } from 'bun:test';
import { InvalidInputError } from './cli-errors.ts';
import { applyFields, FIELDS_LIST_KEYS, fieldsOption, parseFields, projectFields } from './json-fields.ts';

describe('parseFields', () => {
  it('splits on commas and dots, trimming each entry', () => {
    expect(parseFields('ts, user ,profile.email')).toEqual([['ts'], ['user'], ['profile', 'email']]);
  });

  it('drops duplicates, keeping the first position', () => {
    expect(parseFields('user,ts,user, ts')).toEqual([['user'], ['ts']]);
  });

  it('accepts a key with spaces or punctuation, as --resolve-fields labels have', () => {
    expect(parseFields('id,fields.Start Date, fields . T-shirt size/EU ')).toEqual([
      ['id'],
      ['fields', 'Start Date'],
      ['fields', 'T-shirt size/EU'],
    ]);
  });

  it('treats the same path written with different spacing as one', () => {
    expect(parseFields('a.b, a . b')).toEqual([['a', 'b']]);
  });

  it('accepts digits, underscores and hyphens', () => {
    expect(parseFields('thread_ts,x-1,a.b_2')).toEqual([['thread_ts'], ['x-1'], ['a', 'b_2']]);
  });

  it.each(['', '   ', ',', ' , , '])('rejects an empty list %j', (input) => {
    expect(() => parseFields(input)).toThrow(InvalidInputError);
    expect(() => parseFields(input)).toThrow('--fields needs at least one field name');
  });

  it.each(['ts,,user', 'ts,', ',ts', 'profile.', '.email', 'a..b', 'a. .b', 'ts, ,user'])(
    'rejects the malformed list %j',
    (input) => {
      expect(() => parseFields(input)).toThrow(InvalidInputError);
      expect(() => parseFields(input)).toThrow(/^Invalid --fields entry/);
    },
  );

  it('reports invalid_input', () => {
    try {
      parseFields('a..b');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as InvalidInputError).code).toBe('invalid_input');
    }
  });
});

describe('fieldsOption', () => {
  it('is undefined when --fields is not given, with or without --json', () => {
    expect(fieldsOption({})).toBeUndefined();
    expect(fieldsOption({ json: true })).toBeUndefined();
  });

  it('parses --fields with --json', () => {
    expect(fieldsOption({ json: true, fields: 'ts,user' })).toEqual([['ts'], ['user']]);
  });

  it('refuses --fields without --json, even when the list is valid', () => {
    expect(() => fieldsOption({ fields: 'ts' })).toThrow('--fields only applies to --json output; add --json');
    expect(() => fieldsOption({ json: false, fields: 'ts' })).toThrow(InvalidInputError);
  });

  it('refuses an empty --fields value with --json', () => {
    expect(() => fieldsOption({ json: true, fields: '' })).toThrow(InvalidInputError);
  });
});

const READ_OUTPUT = {
  channel_id: 'C0123456789',
  message_count: 3,
  next_oldest: '1712345678.000300',
  has_more: false,
  messages: [
    { ts: '1712345678.000100', user: 'U0123456789', text: 'hi', type: 'message', blocks: [{ type: 'rich_text' }] },
    { ts: '1712345678.000200', bot_id: 'B0123456789', text: 'bot', type: 'message' },
    { ts: '1712345678.000300', user: 'U0123456789', text: 'third', reactions: [{ name: 'tada', count: 2, users: ['U1'] }] },
  ],
  users: [{ id: 'U0123456789', name: 'alice', real_name: 'Alice', email: 'alice@example.com' }],
};

// A projected read output: the same envelope, items of any shape.
type Projected = { messages: Record<string, unknown>[]; users: unknown };

describe('projectFields', () => {
  it('returns the value itself when no fields were given', () => {
    expect(projectFields(READ_OUTPUT, undefined, 'messages')).toBe(READ_OUTPUT);
    expect(projectFields(READ_OUTPUT, undefined, null)).toBe(READ_OUTPUT);
  });

  it('keeps only the requested keys of each item, same count and order', () => {
    const out = projectFields(READ_OUTPUT, parseFields('ts,user,text'), 'messages') as Projected;
    expect(out.messages).toEqual([
      { ts: '1712345678.000100', user: 'U0123456789', text: 'hi' },
      { ts: '1712345678.000200', text: 'bot' },
      { ts: '1712345678.000300', user: 'U0123456789', text: 'third' },
    ]);
  });

  it('keeps every envelope key unchanged, in place', () => {
    const out = projectFields(READ_OUTPUT, parseFields('ts'), 'messages') as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(Object.keys(READ_OUTPUT));
    for (const key of ['channel_id', 'message_count', 'next_oldest', 'has_more']) {
      expect(out[key]).toBe(READ_OUTPUT[key as keyof typeof READ_OUTPUT]);
    }
    expect(out.users).toBe(READ_OUTPUT.users);
  });

  it('emits keys in the requested order', () => {
    const out = projectFields(READ_OUTPUT, parseFields('text,ts'), 'messages') as Projected;
    expect(JSON.stringify(out.messages[0])).toBe('{"text":"hi","ts":"1712345678.000100"}');
  });

  it('turns an item with none of the fields into {} instead of dropping it', () => {
    const out = projectFields(READ_OUTPUT, parseFields('nope'), 'messages') as Projected;
    expect(out.messages).toEqual([{}, {}, {}]);
  });

  it('keeps nesting for dot paths', () => {
    const user = { id: 'U1', profile: { email: 'a@example.com', phone: '1', fields: { X: { value: 'v' } } } };
    expect(projectFields(user, parseFields('id,profile.email'), null)).toEqual({ id: 'U1', profile: { email: 'a@example.com' } });
    expect(projectFields(user, parseFields('profile.fields.X.value'), null)).toEqual({
      profile: { fields: { X: { value: 'v' } } },
    });
  });

  it('selects a key that contains spaces', () => {
    const row = { id: 'U1', fields: { 'Start Date': '2026-01-01', Team: 'Platform' } };
    expect(projectFields(row, parseFields('id,fields.Start Date'), null)).toEqual({
      id: 'U1',
      fields: { 'Start Date': '2026-01-01' },
    });
  });

  it('merges several dot paths under one key', () => {
    const user = { profile: { email: 'a@example.com', phone: '1', title: 't' } };
    expect(projectFields(user, parseFields('profile.title,profile.email'), null)).toEqual({
      profile: { title: 't', email: 'a@example.com' },
    });
  });

  it('lets a whole key win over a narrower path, in either order', () => {
    const user = { profile: { email: 'a@example.com', phone: '1' } };
    expect(projectFields(user, parseFields('profile.email,profile'), null)).toEqual(user);
    expect(projectFields(user, parseFields('profile,profile.email'), null)).toEqual(user);
  });

  it('omits a nested path that is missing, or that runs into a scalar or null', () => {
    const user = { id: 'U1', profile: { phone: '1' }, name: 'alice', tz: null };
    expect(projectFields(user, parseFields('id,profile.email,name.first,tz.offset'), null)).toEqual({ id: 'U1' });
  });

  it('keeps a requested null or falsy value', () => {
    const item = { a: null, b: 0, c: '', d: false };
    expect(projectFields(item, parseFields('a,b,c,d'), null)).toEqual(item);
  });

  it('projects through arrays inside items', () => {
    const out = projectFields(READ_OUTPUT, parseFields('ts,reactions.name'), 'messages') as Projected;
    expect(out.messages[2]).toEqual({ ts: '1712345678.000300', reactions: [{ name: 'tada' }] });
  });

  it('keeps objects in a nested array as {} when they lack the field, and drops scalars', () => {
    const item = { files: [{ id: 'F1', name: 'a.txt' }, { id: 'F2' }, 'stray', null], tags: ['x', 'y'] };
    expect(projectFields(item, parseFields('files.name,tags.value'), null)).toEqual({ files: [{ name: 'a.txt' }, {}], tags: [] });
  });

  it('keeps a whole array when it is asked for by name', () => {
    expect(projectFields({ editors: ['U1', 'U2'], id: 'F1' }, parseFields('editors'), null)).toEqual({ editors: ['U1', 'U2'] });
  });

  it('projects a single object at the list key', () => {
    const output = { channel_id: 'C1', message: { ts: '1', text: 'hi', blocks: [] }, users: [] };
    expect(projectFields(output, parseFields('text'), 'message')).toEqual({ channel_id: 'C1', message: { text: 'hi' }, users: [] });
  });

  it('leaves scalar list items alone', () => {
    expect(projectFields({ members: ['U1', 'U2'] }, parseFields('id'), 'members')).toEqual({ members: ['U1', 'U2'] });
  });

  it('returns the value unchanged when the list key is absent or the value is not an object', () => {
    const output = { other: [1] };
    expect(projectFields(output, parseFields('id'), 'messages')).toBe(output);
    expect(projectFields(null, parseFields('id'), 'messages')).toBeNull();
    expect(projectFields([{ id: 1 }], parseFields('id'), 'messages')).toEqual([{ id: 1 }]);
  });

  it('projects a single record to {} when it has none of the fields', () => {
    expect(projectFields({ id: 'T1' }, parseFields('name'), null)).toEqual({});
  });

  it('reads only own properties, never inherited ones', () => {
    const out = projectFields({ id: 'U1' }, parseFields('id,constructor,toString,__proto__'), null);
    expect(out).toEqual({ id: 'U1' });
    expect(JSON.stringify(out)).toBe('{"id":"U1"}');
  });

  it('copies a key named __proto__ as data, without touching the prototype', () => {
    const item = JSON.parse('{"__proto__":{"polluted":true},"id":"U1"}');
    const out = projectFields({ items: [item] }, parseFields('__proto__,id'), 'items') as { items: object[] };
    expect(JSON.stringify(out)).toBe('{"items":[{"__proto__":{"polluted":true},"id":"U1"}]}');
    expect(Object.getPrototypeOf(out.items[0])).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not modify its input', () => {
    const before = JSON.stringify(READ_OUTPUT);
    projectFields(READ_OUTPUT, parseFields('ts,reactions.name,profile.email'), 'messages');
    expect(JSON.stringify(READ_OUTPUT)).toBe(before);
  });
});

describe('applyFields', () => {
  it('uses the command\'s list key from the table', () => {
    const out = applyFields('conversations read', READ_OUTPUT, parseFields('ts')) as Projected;
    expect(out.messages).toEqual([{ ts: '1712345678.000100' }, { ts: '1712345678.000200' }, { ts: '1712345678.000300' }]);
    expect(out.users).toBe(READ_OUTPUT.users);
  });

  it('projects the record itself for a single-record command', () => {
    expect(applyFields('team info', { id: 'T1', name: 'Acme', domain: 'acme' }, parseFields('name'))).toEqual({ name: 'Acme' });
  });

  it('returns the value untouched without fields', () => {
    expect(applyFields('users list', READ_OUTPUT, undefined)).toBe(READ_OUTPUT);
  });

  it('names a list key or null for every command', () => {
    for (const [command, key] of Object.entries(FIELDS_LIST_KEYS)) {
      expect({ command, ok: key === null || /^[a-z_]+$/.test(key) }).toEqual({ command, ok: true });
    }
  });
});
