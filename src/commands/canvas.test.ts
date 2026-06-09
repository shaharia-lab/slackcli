import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCanvasCommand,
  buildEditChange,
  buildSectionCriteria,
  resolveMarkdown,
  VALID_EDIT_OPERATIONS,
} from './canvas.ts';

describe('canvas command', () => {
  it('exposes edit and sections subcommands', () => {
    const canvas = createCanvasCommand();
    const names = canvas.commands.map((c) => c.name());
    expect(names).toContain('edit');
    expect(names).toContain('sections');
  });

  it('exposes the operation and section options on edit', () => {
    const canvas = createCanvasCommand();
    const edit = canvas.commands.find((c) => c.name() === 'edit');
    expect(edit?.options.some((o) => o.long === '--operation')).toBe(true);
    expect(edit?.options.some((o) => o.long === '--section')).toBe(true);
    expect(edit?.options.some((o) => o.long === '--stdin')).toBe(true);
  });
});

describe('buildEditChange', () => {
  it('builds insert_at_end with document_content and no section', () => {
    const change = buildEditChange('insert_at_end', '## Update', undefined);
    expect(change).toEqual({
      operation: 'insert_at_end',
      document_content: { type: 'markdown', markdown: '## Update' },
    });
  });

  it('builds insert_at_start with document_content', () => {
    const change = buildEditChange('insert_at_start', '# Top', undefined);
    expect(change.operation).toBe('insert_at_start');
    expect(change.document_content).toEqual({ type: 'markdown', markdown: '# Top' });
    expect(change.section_id).toBeUndefined();
  });

  it('builds insert_after with content and section', () => {
    const change = buildEditChange('insert_after', '- item', 'temp:C:abc');
    expect(change).toEqual({
      operation: 'insert_after',
      document_content: { type: 'markdown', markdown: '- item' },
      section_id: 'temp:C:abc',
    });
  });

  it('builds insert_before with content and section', () => {
    const change = buildEditChange('insert_before', 'before', 'temp:C:xyz');
    expect(change.operation).toBe('insert_before');
    expect(change.section_id).toBe('temp:C:xyz');
  });

  it('builds replace without a section (whole canvas)', () => {
    const change = buildEditChange('replace', 'new body', undefined);
    expect(change).toEqual({
      operation: 'replace',
      document_content: { type: 'markdown', markdown: 'new body' },
    });
  });

  it('builds replace with a section', () => {
    const change = buildEditChange('replace', 'new section', 'temp:C:sec');
    expect(change.section_id).toBe('temp:C:sec');
    expect(change.document_content).toEqual({ type: 'markdown', markdown: 'new section' });
  });

  it('builds delete with only a section_id', () => {
    const change = buildEditChange('delete', undefined, 'temp:C:gone');
    expect(change).toEqual({ operation: 'delete', section_id: 'temp:C:gone' });
    expect(change.document_content).toBeUndefined();
  });

  it('throws when a content operation has no content', () => {
    expect(() => buildEditChange('insert_at_end', undefined, undefined)).toThrow(/requires content/);
  });

  it('throws when insert_after has no section', () => {
    expect(() => buildEditChange('insert_after', 'x', undefined)).toThrow(/requires --section/);
  });

  it('throws when insert_at_start is given a section', () => {
    expect(() => buildEditChange('insert_at_start', 'x', 'temp:C:abc')).toThrow(/does not accept --section/);
  });

  it('throws when delete is given content', () => {
    expect(() => buildEditChange('delete', 'oops', 'temp:C:abc')).toThrow(/does not accept content/);
  });

  it('throws when delete has no section', () => {
    expect(() => buildEditChange('delete', undefined, undefined)).toThrow(/requires --section/);
  });

  it('lists exactly six valid operations', () => {
    expect(VALID_EDIT_OPERATIONS).toEqual([
      'insert_at_start',
      'insert_at_end',
      'insert_after',
      'insert_before',
      'replace',
      'delete',
    ]);
  });
});

describe('buildSectionCriteria', () => {
  it('maps --type to section_types array', () => {
    expect(buildSectionCriteria({ type: 'h2' })).toEqual({ section_types: ['h2'] });
  });

  it('maps --contains to contains_text', () => {
    expect(buildSectionCriteria({ contains: 'Action Items' })).toEqual({ contains_text: 'Action Items' });
  });

  it('maps both type and contains', () => {
    expect(buildSectionCriteria({ type: 'any_header', contains: 'Notes' })).toEqual({
      section_types: ['any_header'],
      contains_text: 'Notes',
    });
  });

  it('defaults to any_header when no filters are given (Slack rejects empty criteria)', () => {
    expect(buildSectionCriteria({})).toEqual({ section_types: ['any_header'] });
  });
});

describe('resolveMarkdown', () => {
  it('returns inline content from --content', async () => {
    expect(await resolveMarkdown({ content: '# Hi' })).toBe('# Hi');
  });

  it('returns undefined when no source is given', async () => {
    expect(await resolveMarkdown({})).toBeUndefined();
  });

  it('throws when more than one source is supplied', async () => {
    await expect(resolveMarkdown({ content: 'a', file: 'b.md' })).rejects.toThrow(/only one of/);
  });

  it('throws a clear error for a missing file', async () => {
    await expect(resolveMarkdown({ file: '/no/such/file-xyz.md' })).rejects.toThrow(/File not found/);
  });

  it('reads markdown from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-test-'));
    const path = join(dir, 'body.md');
    await writeFile(path, '# From file\n- bullet', 'utf-8');
    try {
      expect(await resolveMarkdown({ file: path })).toBe('# From file\n- bullet');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
