import { describe, expect, it } from 'bun:test';
import {
  buildCanvasChange,
  CANVAS_EDIT_OPERATIONS,
  CANVAS_MARKDOWN_MAX_BYTES,
  CANVAS_MARKDOWN_MAX_CHARS,
  checkCanvasMarkdown,
  checkEditOptions,
  isDestructiveOperation,
  parseEditOperation,
  readCanvasMarkdown,
  type CanvasEditOperation,
  type MarkdownInputDeps,
} from './canvas-write.ts';
import { InvalidInputError } from './cli-errors.ts';

describe('parseEditOperation', () => {
  it.each(CANVAS_EDIT_OPERATIONS.map((operation) => [operation]))('accepts %s', (operation) => {
    expect(parseEditOperation(operation)).toBe(operation);
  });

  it('trims and lower-cases', () => {
    expect(parseEditOperation(' Insert_At_End ')).toBe('insert_at_end');
  });

  it.each([[''], ['insert'], ['append'], ['insert-at-end'], ['remove']])('refuses %p', (input) => {
    expect(() => parseEditOperation(input)).toThrow(InvalidInputError);
    expect(() => parseEditOperation(input)).toThrow(`use one of ${CANVAS_EDIT_OPERATIONS.join(', ')}`);
  });
});

describe('isDestructiveOperation', () => {
  it('is true for replace and delete only', () => {
    expect(CANVAS_EDIT_OPERATIONS.filter(isDestructiveOperation)).toEqual(['replace', 'delete']);
  });
});

describe('checkCanvasMarkdown', () => {
  it.each([[''], [' '], ['\n\t\n']])('refuses empty Markdown %p', (markdown) => {
    expect(() => checkCanvasMarkdown(markdown, 'file x.md')).toThrow('Markdown file x.md is empty');
  });

  it('accepts exactly the limit and refuses one character more', () => {
    expect(() => checkCanvasMarkdown('a'.repeat(CANVAS_MARKDOWN_MAX_CHARS), 'from standard input')).not.toThrow();
    expect(() => checkCanvasMarkdown('a'.repeat(CANVAS_MARKDOWN_MAX_CHARS + 1), 'from standard input'))
      .toThrow(`Markdown from standard input is longer than Slack's limit of ${CANVAS_MARKDOWN_MAX_CHARS} characters`);
  });

  it('counts characters, not UTF-16 units', () => {
    // Each emoji is two UTF-16 units but one character.
    const atLimit = '😀'.repeat(CANVAS_MARKDOWN_MAX_CHARS);
    expect(atLimit.length).toBe(2 * CANVAS_MARKDOWN_MAX_CHARS);
    expect(() => checkCanvasMarkdown(atLimit, 'x')).not.toThrow();
    expect(() => checkCanvasMarkdown(`${atLimit}😀`, 'x')).toThrow(InvalidInputError);
  });
});

type Combo = { section?: string; hasMarkdown: boolean; title?: string };
const S = 'temp:C:abc123';

describe('checkEditOptions', () => {
  // What each operation must get, from the canvases.edit reference.
  const valid: Array<[CanvasEditOperation, Combo]> = [
    ['insert_after', { section: S, hasMarkdown: true }],
    ['insert_before', { section: S, hasMarkdown: true }],
    ['insert_at_start', { hasMarkdown: true }],
    ['insert_at_end', { hasMarkdown: true }],
    ['replace', { hasMarkdown: true }],
    ['replace', { section: S, hasMarkdown: true }],
    ['delete', { section: S, hasMarkdown: false }],
    ['rename', { hasMarkdown: false, title: 'Q3 plan' }],
  ];

  it.each(valid)('accepts %s with %j', (operation, combo) => {
    expect(() => checkEditOptions({ operation, ...combo })).not.toThrow();
  });

  const invalid: Array<[CanvasEditOperation, Combo, string]> = [
    ['insert_after', { hasMarkdown: true }, '--operation insert_after needs --section <section-id>'],
    ['insert_before', { hasMarkdown: true }, '--operation insert_before needs --section <section-id>'],
    ['delete', { hasMarkdown: false }, '--operation delete needs --section <section-id>'],
    ['insert_at_start', { section: S, hasMarkdown: true }, '--operation insert_at_start does not take --section'],
    ['insert_at_end', { section: S, hasMarkdown: true }, '--operation insert_at_end does not take --section'],
    ['rename', { section: S, hasMarkdown: false, title: 'T' }, '--operation rename does not take --section'],
    ['insert_after', { section: '  ', hasMarkdown: true }, '--section needs a section ID'],
    ['replace', { section: '', hasMarkdown: true }, '--section needs a section ID'],
    ['insert_after', { section: S, hasMarkdown: false }, '--operation insert_after needs --markdown-file <path|->'],
    ['insert_at_start', { hasMarkdown: false }, '--operation insert_at_start needs --markdown-file'],
    ['insert_at_end', { hasMarkdown: false }, '--operation insert_at_end needs --markdown-file'],
    ['replace', { hasMarkdown: false }, '--operation replace needs --markdown-file'],
    ['delete', { section: S, hasMarkdown: true }, '--operation delete does not take --markdown-file'],
    ['rename', { hasMarkdown: true, title: 'T' }, '--operation rename does not take --markdown-file'],
    ['rename', { hasMarkdown: false }, '--operation rename needs --title <title>'],
    ['replace', { hasMarkdown: true, title: 'T' }, '--title is only used with --operation rename'],
    ['delete', { section: S, hasMarkdown: false, title: 'T' }, '--title is only used with --operation rename'],
    ['rename', { hasMarkdown: false, title: '   ' }, '--title needs some text'],
  ];

  it.each(invalid)('refuses %s with %j', (operation, combo, message) => {
    expect(() => checkEditOptions({ operation, ...combo })).toThrow(InvalidInputError);
    expect(() => checkEditOptions({ operation, ...combo })).toThrow(message);
  });
});

describe('buildCanvasChange', () => {
  it('builds an insert with its section and Markdown content', () => {
    expect(buildCanvasChange({ operation: 'insert_after', section: ` ${S} `, markdown: '- [ ] coffee\n' })).toStrictEqual({
      operation: 'insert_after',
      section_id: S,
      document_content: { type: 'markdown', markdown: '- [ ] coffee\n' },
    });
  });

  it('builds a whole-canvas replace without a section_id key', () => {
    expect(buildCanvasChange({ operation: 'replace', markdown: '# New' })).toStrictEqual({
      operation: 'replace',
      document_content: { type: 'markdown', markdown: '# New' },
    });
  });

  it('builds a delete with the section only', () => {
    expect(buildCanvasChange({ operation: 'delete', section: S })).toStrictEqual({ operation: 'delete', section_id: S });
  });

  it('builds a rename with title_content', () => {
    expect(buildCanvasChange({ operation: 'rename', title: 'Q3 plan :white_check_mark:' })).toStrictEqual({
      operation: 'rename',
      title_content: { type: 'markdown', markdown: 'Q3 plan :white_check_mark:' },
    });
  });

  it('runs the same checks', () => {
    expect(() => buildCanvasChange({ operation: 'delete' })).toThrow('needs --section');
    expect(() => buildCanvasChange({ operation: 'rename', title: 'T', markdown: 'x' })).toThrow('does not take --markdown-file');
  });
});

describe('readCanvasMarkdown', () => {
  function deps(overrides: Partial<MarkdownInputDeps> = {}): MarkdownInputDeps & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      isStdinTTY: () => false,
      readStdin: async (maxBytes) => {
        reads.push(`stdin:${maxBytes}`);
        return '# From stdin\n';
      },
      fileSize: async () => 12,
      readFile: async (path) => {
        reads.push(`file:${path}`);
        return '# From file\n';
      },
      ...overrides,
    };
  }

  it('reads a file as is', async () => {
    const d = deps();
    expect(await readCanvasMarkdown('./notes.md', d)).toBe('# From file\n');
    expect(d.reads).toEqual(['file:./notes.md']);
  });

  it('reads standard input for -, bounded to the byte cap, keeping the text as is', async () => {
    const d = deps();
    expect(await readCanvasMarkdown('-', d)).toBe('# From stdin\n');
    expect(d.reads).toEqual([`stdin:${CANVAS_MARKDOWN_MAX_BYTES}`]);
  });

  it('treats ./- as a file', async () => {
    const d = deps();
    await readCanvasMarkdown('./-', d);
    expect(d.reads).toEqual(['file:./-']);
  });

  it('refuses an empty path', async () => {
    await expect(readCanvasMarkdown('', deps())).rejects.toThrow('--markdown-file path cannot be empty');
  });

  it('refuses a terminal on stdin before reading', async () => {
    const d = deps({ isStdinTTY: () => true });
    await expect(readCanvasMarkdown('-', d)).rejects.toThrow('stdin is a terminal; pipe the text in');
    expect(d.reads).toEqual([]);
  });

  it('reports a failed stdin read as invalid input', async () => {
    const d = deps({ readStdin: async () => { throw new Error('input is larger than 4194304 bytes'); } });
    await expect(readCanvasMarkdown('-', d)).rejects.toThrow(InvalidInputError);
    await expect(readCanvasMarkdown('-', d)).rejects.toThrow('Cannot read Markdown from standard input: input is larger than 4194304 bytes');
  });

  it('refuses empty stdin', async () => {
    await expect(readCanvasMarkdown('-', deps({ readStdin: async () => '\n' }))).rejects.toThrow('Markdown from standard input is empty');
  });

  it('refuses an oversized file without reading it', async () => {
    const d = deps({ fileSize: async () => CANVAS_MARKDOWN_MAX_BYTES + 1 });
    await expect(readCanvasMarkdown('big.md', d)).rejects.toThrow(`Cannot read Markdown file big.md: file is larger than ${CANVAS_MARKDOWN_MAX_BYTES} bytes`);
    expect(d.reads).toEqual([]);
  });

  it('reads a file of exactly the byte cap', async () => {
    const d = deps({ fileSize: async () => CANVAS_MARKDOWN_MAX_BYTES });
    expect(await readCanvasMarkdown('ok.md', d)).toBe('# From file\n');
  });

  it('reports a missing file as invalid input', async () => {
    const d = deps({ fileSize: async () => { throw new Error('ENOENT: no such file or directory'); } });
    await expect(readCanvasMarkdown('missing.md', d)).rejects.toThrow(InvalidInputError);
    await expect(readCanvasMarkdown('missing.md', d)).rejects.toThrow('Cannot read Markdown file missing.md: ENOENT');
  });

  it('refuses an empty file and one past the character limit', async () => {
    await expect(readCanvasMarkdown('e.md', deps({ readFile: async () => '  ' }))).rejects.toThrow('Markdown file e.md is empty');
    await expect(readCanvasMarkdown('l.md', deps({ readFile: async () => 'a'.repeat(CANVAS_MARKDOWN_MAX_CHARS + 1) })))
      .rejects.toThrow('Markdown file l.md is longer than');
  });

  it('reads a real file through the default dependencies', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-canvas-md-'));
    try {
      const path = join(dir, 'notes.md');
      await writeFile(path, '# Notes\n\n- one\n');
      expect(await readCanvasMarkdown(path)).toBe('# Notes\n\n- one\n');
      await expect(readCanvasMarkdown(join(dir, 'missing.md'))).rejects.toThrow(InvalidInputError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
