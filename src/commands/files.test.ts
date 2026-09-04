import { describe, expect, it } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFilesCommand,
  extractedFileContent,
  formatFileInfo,
  isAuthenticationResponse,
  isTextFile,
  writeResponseToFile,
} from './files.ts';

function subcommand(name: string) {
  return createFilesCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

describe('files command', () => {
  it('exposes info, read, and download with one required file input', () => {
    expect(createFilesCommand().commands.map((command) => command.name())).toEqual([
      'info',
      'read',
      'download',
    ]);
    for (const name of ['info', 'read', 'download']) {
      expect(subcommand(name)?.registeredArguments.map((argument) => ({
        name: argument.name(),
        required: argument.required,
      }))).toEqual([{ name: 'file-id-or-url', required: true }]);
    }
  });

  it('exposes the structured and raw output options on the right commands', () => {
    expect(longOptions('info')).toContain('--json');
    expect(longOptions('read')).toContain('--json');
    expect(longOptions('read')).toContain('--raw');
    expect(longOptions('download')).toContain('--output');
  });
});

describe('file content selection', () => {
  it('prefers Slack email plain_text without requiring a textual MIME type', () => {
    expect(extractedFileContent({
      id: 'F123',
      filetype: 'email',
      mimetype: 'application/vnd.slack-email',
      plain_text: 'From: ada@example.com\n\nHello',
    }, false)).toEqual({
      source: 'plain_text',
      content: 'From: ada@example.com\n\nHello',
    });
  });

  it('uses the original file in raw mode', () => {
    expect(extractedFileContent({ id: 'F123', filetype: 'email', plain_text: 'Extracted body' }, true)).toBeNull();
  });

  it('does not print extracted text attached to a binary file', () => {
    expect(extractedFileContent({
      id: 'F123',
      mimetype: 'application/pdf',
      plain_text: 'Extracted PDF text',
    }, false)).toBeNull();
  });

  it('recognises safe textual MIME types and rejects binary MIME types', () => {
    expect(isTextFile({ id: 'F1', mimetype: 'text/plain; charset=utf-8' })).toBe(true);
    expect(isTextFile({ id: 'F2', mimetype: 'application/problem+json' })).toBe(true);
    expect(isTextFile({ id: 'F3', mimetype: 'message/rfc822' })).toBe(true);
    expect(isTextFile({ id: 'F4', filetype: 'email' })).toBe(true);
    expect(isTextFile({ id: 'F5', mimetype: 'application/pdf' })).toBe(false);
    expect(isTextFile({ id: 'F6' })).toBe(false);
  });
});

describe('authentication response detection', () => {
  it('detects a sign-in page returned for a non-HTML file', async () => {
    const response = new Response(
      '<html><title>Sign in | Slack</title><body>Authentication required</body></html>',
      { headers: { 'content-type': 'text/html' } },
    );

    expect(await isAuthenticationResponse(response, { id: 'F123', mimetype: 'application/pdf' })).toBe(true);
    expect(await response.text()).toContain('Authentication required');
  });

  it('does not reject a requested HTML file', async () => {
    const response = new Response('<html><title>Sign in instructions</title></html>', {
      headers: { 'content-type': 'text/html' },
    });

    expect(await isAuthenticationResponse(response, { id: 'F123', mimetype: 'text/html' })).toBe(false);
  });
});

describe('file metadata output', () => {
  it('shows useful metadata without private retrieval URLs', () => {
    const output = formatFileInfo({
      id: 'F123',
      name: 'report.txt',
      title: 'Report',
      mimetype: 'text/plain',
      size: 12,
      user: 'U123',
      created: 1_788_480_000,
      permalink: 'https://example.slack.com/files/U123/F123/report.txt',
      url_private: 'https://files.slack.com/private-secret',
      url_private_download: 'https://files.slack.com/download/private-secret',
    });

    expect(output).toContain('ID: F123');
    expect(output).toContain('MIME type: text/plain');
    expect(output).toContain('Size: 12 B (12 bytes)');
    expect(output).toContain('Owner: U123');
    expect(output).toContain('Permalink: https://example.slack.com/files/U123/F123/report.txt');
    expect(output).not.toContain('private-secret');
  });
});

describe('writeResponseToFile', () => {
  it('preserves binary bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-download-'));
    const output = join(dir, 'file.bin');
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 1]);

    try {
      expect(await writeResponseToFile(new Response(bytes), output)).toBe(bytes.byteLength);
      expect(new Uint8Array(await readFile(output))).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-download-'));
    const output = join(dir, 'existing.txt');
    await writeFile(output, 'keep me');

    try {
      await expect(writeResponseToFile(new Response('replacement'), output)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(output, 'utf8')).toBe('keep me');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a partial file when the response stream fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-download-'));
    const output = join(dir, 'partial.bin');
    let firstChunk = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstChunk) {
          firstChunk = false;
          controller.enqueue(new Uint8Array([1, 2, 3]));
          return;
        }
        controller.error(new Error('connection lost'));
      },
    });

    try {
      await expect(writeResponseToFile(new Response(body), output)).rejects.toThrow('connection lost');
      await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
