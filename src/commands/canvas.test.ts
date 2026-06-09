import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCreateParams, resolveCanvasMarkdown } from './canvas';

describe('buildCreateParams', () => {
  it('returns empty params when nothing is provided', () => {
    expect(buildCreateParams({})).toEqual({});
  });

  it('includes only the title when no markdown or channel', () => {
    expect(buildCreateParams({ title: 'Sprint Notes' })).toEqual({ title: 'Sprint Notes' });
  });

  it('wraps markdown into a JSON-stringified document_content', () => {
    const params = buildCreateParams({ markdown: '# Hello' });
    expect(params.document_content).toBe(JSON.stringify({ type: 'markdown', markdown: '# Hello' }));
    expect(params.title).toBeUndefined();
  });

  it('maps channel to channel_id', () => {
    expect(buildCreateParams({ channel: 'C123' })).toEqual({ channel_id: 'C123' });
  });

  it('combines title, markdown, and channel', () => {
    const params = buildCreateParams({ title: 'T', markdown: 'body', channel: 'C9' });
    expect(params.title).toBe('T');
    expect(params.channel_id).toBe('C9');
    expect(params.document_content).toBe(JSON.stringify({ type: 'markdown', markdown: 'body' }));
  });

  it('omits empty-string markdown', () => {
    expect(buildCreateParams({ markdown: '' })).toEqual({});
  });
});

describe('resolveCanvasMarkdown', () => {
  it('returns undefined when no source is provided', async () => {
    expect(await resolveCanvasMarkdown({})).toBeUndefined();
  });

  it('returns inline content', async () => {
    expect(await resolveCanvasMarkdown({ content: '# Inline' })).toBe('# Inline');
  });

  it('rejects when more than one source is provided', async () => {
    await expect(resolveCanvasMarkdown({ content: 'a', file: 'b.md' })).rejects.toThrow(
      'Use only one of --content, --file, or --stdin',
    );
  });

  it('rejects content + stdin together', async () => {
    await expect(resolveCanvasMarkdown({ content: 'a', stdin: true })).rejects.toThrow(
      'Use only one of',
    );
  });

  it('reads markdown from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-test-'));
    const path = join(dir, 'doc.md');
    await writeFile(path, '# From file\n- item');
    try {
      expect(await resolveCanvasMarkdown({ file: path })).toBe('# From file\n- item');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error for a missing file', async () => {
    const path = join(tmpdir(), 'canvas-test-does-not-exist-xyz.md');
    await expect(resolveCanvasMarkdown({ file: path })).rejects.toThrow(`File not found: ${path}`);
  });
});
