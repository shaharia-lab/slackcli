import { describe, expect, it } from 'bun:test';
import { renderBlocks, renderAttachments } from './block-renderer.ts';

const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');

describe('renderBlocks', () => {
  it('renders header text', () => {
    const out = stripAnsi(renderBlocks([{ type: 'header', text: { text: 'Hello' } }], 0));
    expect(out).toBe('Hello\n');
  });

  it('skips header without text', () => {
    expect(renderBlocks([{ type: 'header' }], 0)).toBe('');
  });

  it('renders section text preserving newlines and indents', () => {
    const out = stripAnsi(renderBlocks([{ type: 'section', text: { text: 'a\nb' } }], 2));
    expect(out).toBe('  a\n  b\n');
  });

  it('renders section fields as bullets and flattens internal newlines', () => {
    const out = stripAnsi(renderBlocks([
      { type: 'section', fields: [{ text: 'one' }, { text: 'two\nlines' }] },
    ], 0));
    expect(out).toBe('  • one\n  • two lines\n');
  });

  it('renders context elements joined with space', () => {
    const out = stripAnsi(renderBlocks([
      { type: 'context', elements: [{ text: 'foo' }, { alt_text: 'bar' }, {}] },
    ], 0));
    expect(out).toBe('foo bar\n');
  });

  it('skips empty context', () => {
    expect(renderBlocks([{ type: 'context', elements: [] }], 0)).toBe('');
  });

  it('renders divider', () => {
    const out = stripAnsi(renderBlocks([{ type: 'divider' }], 0));
    expect(out).toBe('─────────\n');
  });

  it('skips actions and image blocks', () => {
    expect(renderBlocks([{ type: 'actions' }, { type: 'image' }], 0)).toBe('');
  });

  it('falls back to default renderer when block.type is unknown', () => {
    const out = stripAnsi(renderBlocks([{ type: 'mystery', text: { text: 'x' } }], 0));
    expect(out).toBe('x\n');
  });

  it('renders rich_text plain text + link + user + channel + emoji', () => {
    const out = stripAnsi(renderBlocks([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'hi ' },
          { type: 'link', text: 'site', url: 'https://x' },
          { type: 'text', text: ' ' },
          { type: 'user', user_id: 'U1' },
          { type: 'text', text: ' ' },
          { type: 'channel', channel_id: 'C1' },
          { type: 'text', text: ' ' },
          { type: 'emoji', name: 'wave' },
        ],
      }],
    }], 0));
    // Trailing blank line is from rich_text_section appending \n, then the
    // outer per-line loop emitting one more newline for the empty tail.
    expect(out).toBe('hi site <@U1> <#C1> :wave:\n\n');
  });

  it('renders link url when text is missing', () => {
    const out = stripAnsi(renderBlocks([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'link', url: 'https://x' }],
      }],
    }], 0));
    expect(out).toBe('https://x\n\n');
  });

  it('renders rich_text_list as bullets', () => {
    const out = stripAnsi(renderBlocks([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_list',
        elements: [
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] },
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'two' }] },
        ],
      }],
    }], 0));
    expect(out).toBe('• one\n• two\n\n');
  });

  it('renders rich_text_quote with leading >', () => {
    const out = stripAnsi(renderBlocks([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_quote',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'q' }] }],
      }],
    }], 0));
    expect(out).toBe('> q\n\n');
  });

  it('renders rich_text_preformatted as code fence', () => {
    const out = stripAnsi(renderBlocks([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: 'code' }],
      }],
    }], 0));
    expect(out).toBe('```\ncode\n```\n\n');
  });
});

describe('renderAttachments', () => {
  it('renders pretext, title, text, footer in order', () => {
    const out = stripAnsi(renderAttachments([{
      pretext: 'P',
      title: 'T',
      text: 'body\nline2',
      footer: 'F',
    }], 0));
    expect(out).toBe('P\nT\nbody\nline2\nF\n');
  });

  it('appends title_link in parens after title', () => {
    const out = stripAnsi(renderAttachments([{ title: 'T', title_link: 'https://x' }], 0));
    expect(out).toBe('T (https://x)\n');
  });

  it('renders fields with title: value and indents', () => {
    const out = stripAnsi(renderAttachments([{
      fields: [
        { title: 'k', value: 'v' },
        { value: 'multi\nline' },
        { title: '', value: '' },
      ],
    }], 0));
    expect(out).toBe('  k: v\n  multi\n  line\n');
  });

  it('renders nested blocks at indent+2', () => {
    const out = stripAnsi(renderAttachments([{
      blocks: [{ type: 'header', text: { text: 'H' } }],
    }], 0));
    expect(out).toBe('  H\n');
  });

  it('honours outer indent', () => {
    const out = stripAnsi(renderAttachments([{ title: 'T' }], 4));
    expect(out).toBe('    T\n');
  });
});
