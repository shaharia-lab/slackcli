import { describe, expect, it } from 'bun:test';
import { parseMrkdwn } from './mrkdwn';

function elements(text: string) {
  return parseMrkdwn(text)[0].elements[0].elements;
}

describe('parseMrkdwn', () => {
  it('returns plain text as-is', () => {
    expect(elements('hello world')).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('parses *bold*', () => {
    expect(elements('hello *world*')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { bold: true } },
    ]);
  });

  it('parses _italic_', () => {
    expect(elements('hello _world_')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { italic: true } },
    ]);
  });

  it('parses ~strike~', () => {
    expect(elements('hello ~world~')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { strike: true } },
    ]);
  });

  it('parses `code`', () => {
    expect(elements('hello `world`')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { code: true } },
    ]);
  });

  it('parses multiple formats in one line', () => {
    expect(elements('*bold* and _italic_')).toEqual([
      { type: 'text', text: 'bold', style: { bold: true } },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'italic', style: { italic: true } },
    ]);
  });

  it('parses nested *_bold italic_*', () => {
    expect(elements('*_bold italic_*')).toEqual([
      { type: 'text', text: 'bold italic', style: { italic: true, bold: true } },
    ]);
  });

  it('does not match markers with spaces inside', () => {
    expect(elements('not * bold *')).toEqual([
      { type: 'text', text: 'not * bold *' },
    ]);
  });

  it('does not match empty markers', () => {
    expect(elements('nothing ** here')).toEqual([
      { type: 'text', text: 'nothing ** here' },
    ]);
  });

  it('does not parse formatting inside `code`', () => {
    expect(elements('`*not bold*`')).toEqual([
      { type: 'text', text: '*not bold*', style: { code: true } },
    ]);
  });

  it('handles unmatched markers as plain text', () => {
    expect(elements('hello *world')).toEqual([
      { type: 'text', text: 'hello *world' },
    ]);
  });

  it('handles text after formatted text', () => {
    expect(elements('*bold* then plain')).toEqual([
      { type: 'text', text: 'bold', style: { bold: true } },
      { type: 'text', text: ' then plain' },
    ]);
  });

  it('returns valid rich_text block structure', () => {
    const result = parseMrkdwn('*hello*');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'hello', style: { bold: true } },
        ],
      }],
    }]);
  });
});
