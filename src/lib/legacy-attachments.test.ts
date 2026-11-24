import { describe, expect, it } from 'bun:test';
import { attachmentLines, extractAttachments } from './legacy-attachments.ts';

describe('attachmentLines', () => {
  it('orders pretext, title with link, text, fields, footer', () => {
    expect(attachmentLines({
      pretext: 'Heads up', title: 'Disk full', title_link: 'https://example.com/a', text: 'on db-1',
      fields: [{ title: 'Severity', value: 'high', short: true }, { title: 'Region', value: 'eu' }],
      footer: 'Grafana', fallback: 'ignored',
    })).toEqual(['Heads up', 'Disk full (https://example.com/a)', 'on db-1', 'Severity: high', 'Region: eu', 'Grafana']);
  });

  it('prints a title without a link as-is', () => {
    expect(attachmentLines({ title: 'Disk full' })).toEqual(['Disk full']);
  });

  it('ignores a title_link without a title', () => {
    expect(attachmentLines({ title_link: 'https://example.com', text: 'body' })).toEqual(['body']);
  });

  it('splits multi-line values and trims surrounding whitespace', () => {
    expect(attachmentLines({ text: '  line 1\nline 2\n' })).toEqual(['line 1', 'line 2']);
  });

  it('falls back to fallback when title and text are empty', () => {
    expect(attachmentLines({ title: '  ', text: '', fallback: 'Something is firing' }))
      .toEqual(['Something is firing']);
  });

  it('skips fallback when title or text is present', () => {
    expect(attachmentLines({ text: 'body', fallback: 'summary' })).toEqual(['body']);
  });

  it('skips a fallback that repeats the message text', () => {
    expect(attachmentLines({ fallback: 'same' }, ' same ')).toEqual([]);
  });

  it('skips the fallback of an attachment that carries blocks', () => {
    expect(attachmentLines({ fallback: '[no preview available]', blocks: [{ type: 'table' }] })).toEqual([]);
  });

  it('uses the fallback when the blocks array is empty', () => {
    expect(attachmentLines({ fallback: 'summary', blocks: [] })).toEqual(['summary']);
  });

  it('prints a field with only a title or only a value, and skips empty or malformed ones', () => {
    expect(attachmentLines({ fields: [{ title: 'Only title' }, { value: 'Only value' }, {}, null, 'x', { title: 3 }] }))
      .toEqual(['Only title', 'Only value']);
  });

  it('ignores non-array fields and non-string values', () => {
    expect(attachmentLines({ fields: 'nope', title: 42, text: { a: 1 }, footer: ['x'] })).toEqual([]);
  });

  it('returns nothing for a non-object attachment', () => {
    expect(attachmentLines(null)).toEqual([]);
    expect(attachmentLines('text')).toEqual([]);
    expect(attachmentLines([{ text: 'x' }])).toEqual([]);
  });
});

describe('extractAttachments', () => {
  it('keeps attachments with content, in order', () => {
    expect(extractAttachments({ text: '', attachments: [{ text: 'one' }, { color: '#000' }, { title: 'two' }] }))
      .toEqual([['one'], ['two']]);
  });

  it('returns nothing without attachments', () => {
    expect(extractAttachments({ text: 'hi' })).toEqual([]);
    expect(extractAttachments({ text: 'hi', attachments: [] })).toEqual([]);
  });

  it('compares the fallback with the message text', () => {
    expect(extractAttachments({ text: 'Alert', attachments: [{ fallback: 'Alert' }] })).toEqual([]);
  });
});
