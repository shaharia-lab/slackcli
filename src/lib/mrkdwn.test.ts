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

  it('preserves newlines in text elements', () => {
    // Newlines must be embedded in text, not split into separate sections.
    // Slack's draft composer renders multiple sections inline (no breaks),
    // but correctly preserves \n within text elements.
    const result = parseMrkdwn('line one\nline two');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'line one\nline two' }],
      }],
    }]);
  });

  it('preserves newlines with formatting', () => {
    const result = parseMrkdwn('*bold*\nplain');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'bold', style: { bold: true } },
          { type: 'text', text: '\nplain' },
        ],
      }],
    }]);
  });

  it('preserves multiple newlines', () => {
    const result = parseMrkdwn('above\n\nbelow');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'above\n\nbelow' }],
      }],
    }]);
  });

  it('does not pair underscores across two unrelated URLs', () => {
    const text =
      'https://example.com/a/merge_requests/1 and https://example.com/b/merge_requests/2';
    expect(elements(text)).toEqual([{ type: 'text', text }]);
  });

  it('does not treat an underscore inside a single identifier as emphasis', () => {
    expect(elements('see file_name.txt for details')).toEqual([
      { type: 'text', text: 'see file_name.txt for details' },
    ]);
  });

  it('still parses _italic_ when a later word also contains an underscore', () => {
    expect(elements('_this_ is about file_name.txt')).toEqual([
      { type: 'text', text: 'this', style: { italic: true } },
      { type: 'text', text: ' is about file_name.txt' },
    ]);
  });

  it('does not open emphasis on a marker directly after a word character', () => {
    expect(elements('snake_case_name stays literal')).toEqual([
      { type: 'text', text: 'snake_case_name stays literal' },
    ]);
  });

  it('does not open emphasis on a marker directly after a non-ASCII word character', () => {
    // Both Unicode forms of the same word: precomposed U+00E9, then e + U+0301.
    for (const cafe of ['caf\u00e9', 'cafe\u0301']) {
      expect(elements(`${cafe}_italic_ stays literal`)).toEqual([
        { type: 'text', text: `${cafe}_italic_ stays literal` },
      ]);
    }
  });

  it('does not open emphasis after an astral-plane word character', () => {
    // U+1D400 is a letter but occupies two UTF-16 units.
    expect(elements('\u{1D400}_italic_ stays literal')).toEqual([
      { type: 'text', text: '\u{1D400}_italic_ stays literal' },
    ]);
  });

  it('leaves an identifier-spanning underscore pair literal', () => {
    expect(elements('_start with file_name inside_')).toEqual([
      { type: 'text', text: '_start with file_name inside_' },
    ]);
  });

  it('applies bold, strike and code mid-word', () => {
    // Slack scopes the word-boundary rule to _italic_ only.
    expect(elements('*a*b')).toEqual([
      { type: 'text', text: 'a', style: { bold: true } },
      { type: 'text', text: 'b' },
    ]);
    expect(elements('a`b`c')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b', style: { code: true } },
      { type: 'text', text: 'c' },
    ]);
    expect(elements('~a~b')).toEqual([
      { type: 'text', text: 'a', style: { strike: true } },
      { type: 'text', text: 'b' },
    ]);
  });

  it('does not let a doubled marker swallow the adjacent one', () => {
    expect(elements('**bold**')).toEqual([
      { type: 'text', text: '*' },
      { type: 'text', text: 'bold', style: { bold: true } },
      { type: 'text', text: '*' },
    ]);
    expect(elements('~~strike~~')).toEqual([
      { type: 'text', text: '~' },
      { type: 'text', text: 'strike', style: { strike: true } },
      { type: 'text', text: '~' },
    ]);
  });

  it('does not let a tilde in a URL swallow a later strike span', () => {
    expect(elements('see https://host/~user and ~important~')).toEqual([
      { type: 'text', text: 'see https://host/~user and ' },
      { type: 'text', text: 'important', style: { strike: true } },
    ]);
  });
});
