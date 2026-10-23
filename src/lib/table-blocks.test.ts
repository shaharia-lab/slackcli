import { describe, expect, it } from 'bun:test';
import { extractTables, formatTableRows, tableCellText } from './table-blocks.ts';

const raw = (text: string) => ({ type: 'raw_text', text });
const rich = (...elements: unknown[]) => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements }],
});
const table = (rows: unknown[]) => ({ type: 'table', block_id: 'b1', rows });

describe('tableCellText', () => {
  it('reads a raw_text cell', () => {
    expect(tableCellText(raw('Row 1 col A'))).toBe('Row 1 col A');
  });

  it('joins the runs of a rich_text cell, whatever their style', () => {
    expect(tableCellText(rich(
      { type: 'text', text: 'Header ', style: { bold: true } },
      { type: 'text', text: 'A' },
    ))).toBe('Header A');
  });

  it('renders links, mentions and emoji inside a rich_text cell', () => {
    expect(tableCellText(rich(
      { type: 'link', url: 'https://example.com', text: 'docs' },
      { type: 'text', text: ' ' },
      { type: 'user', user_id: 'U0123456789' },
      { type: 'text', text: ' ' },
      { type: 'emoji', name: 'tada' },
    ))).toBe('docs <@U0123456789> :tada:');
  });

  it('keeps a cell on one line', () => {
    expect(tableCellText(raw('two\nlines'))).toBe('two lines');
    expect(tableCellText(rich({ type: 'text', text: 'a \n b' }))).toBe('a b');
  });

  it('returns empty for empty, unknown or malformed cells', () => {
    expect(tableCellText(raw(''))).toBe('');
    expect(tableCellText(rich())).toBe('');
    expect(tableCellText({ type: 'image', image_url: 'https://example.com/x.png' })).toBe('');
    expect(tableCellText({ type: 'raw_text' })).toBe('');
    expect(tableCellText({ type: 'raw_text', text: 42 })).toBe('');
    expect(tableCellText(null)).toBe('');
    expect(tableCellText('text')).toBe('');
    expect(tableCellText([raw('x')])).toBe('');
  });
});

describe('extractTables', () => {
  it('finds a table in attachments[].blocks', () => {
    const msg = {
      attachments: [{ id: 1, blocks: [table([
        [rich({ type: 'text', text: 'Header A', style: { bold: true } }), rich({ type: 'text', text: 'Header B' })],
        [raw('Row 1 col A'), raw('Row 1 col B')],
      ])] }],
    };
    expect(extractTables(msg)).toEqual([[
      ['Header A', 'Header B'],
      ['Row 1 col A', 'Row 1 col B'],
    ]]);
  });

  it('finds a table in blocks', () => {
    expect(extractTables({ blocks: [table([[raw('a'), raw('b')]])] })).toEqual([[['a', 'b']]]);
  });

  it('returns every table in order: blocks first, then each attachment', () => {
    const msg = {
      blocks: [table([[raw('1')]])],
      attachments: [
        { blocks: [table([[raw('2')]]), table([[raw('3')]])] },
        { blocks: [table([[raw('4')]])] },
      ],
    };
    expect(extractTables(msg)).toEqual([[['1']], [['2']], [['3']], [['4']]]);
  });

  it('keeps ragged rows and empty cells as they are', () => {
    expect(extractTables({ blocks: [table([[raw('a'), raw('b'), raw('c')], [raw('d')], [raw(''), raw('f')]])] }))
      .toEqual([[['a', 'b', 'c'], ['d'], ['', 'f']]]);
  });

  it('skips other block types, tables without rows, and malformed rows', () => {
    const msg = {
      blocks: [
        { type: 'rich_text', elements: [] },
        { type: 'section', text: { type: 'mrkdwn', text: 'hi' } },
        { type: 'table' },
        { type: 'table', rows: 'nope' },
        table([]),
        table([[], 'row', null]),
        table([[raw('kept')], 'row', []]),
      ],
    };
    expect(extractTables(msg)).toEqual([[['kept']]]);
  });

  it('skips attachments without blocks and non-object entries', () => {
    const msg = {
      blocks: [null, 'table'] as unknown as Array<Record<string, unknown>>,
      attachments: [{ text: 'legacy attachment' }, { blocks: 'nope' }, null] as unknown as Array<Record<string, unknown>>,
    };
    expect(extractTables(msg)).toEqual([]);
  });

  it('returns no tables for a message without blocks or attachments', () => {
    expect(extractTables({})).toEqual([]);
  });
});

describe('formatTableRows', () => {
  it('pads every column to its widest cell', () => {
    expect(formatTableRows([
      ['Header A', 'Header B'],
      ['Row 1 col A', 'B'],
      ['x', 'Row 2 col B'],
    ])).toEqual([
      'Header A    | Header B',
      'Row 1 col A | B',
      'x           | Row 2 col B',
    ]);
  });

  it('pads short rows with empty cells and leaves no trailing whitespace', () => {
    expect(formatTableRows([['a', 'bb', 'c'], ['dddd'], ['', 'f']])).toEqual([
      'a    | bb | c',
      'dddd |    |',
      '     | f  |',
    ]);
  });

  it('handles a single cell and no rows', () => {
    expect(formatTableRows([['only']])).toEqual(['only']);
    expect(formatTableRows([])).toEqual([]);
  });
});
