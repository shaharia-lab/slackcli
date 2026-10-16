// `emoji add` output paths the write tests do not reach (#418): the oversized
// image warning at its boundary, and the human success line for an image and an
// alias. They pin the behaviour the add handler had before its helpers were
// extracted, so the refactor stays byte-for-byte the same.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authLib from '../lib/auth.ts';
import { EMOJI_MAX_BYTES } from '../lib/emoji.ts';
import { createEmojiCommand } from './emoji.ts';

const WARNING = 'Slack\'s guidance is 128×128 / 64 KB — it may be downscaled.';

function client() {
  const calls: string[] = [];
  return {
    calls,
    stub: {
      authType: 'browser',
      workspaceHost: 'acme.slack.com',
      requireBrowserAuth: () => {},
      addEmoji: async () => { calls.push('addEmoji'); return { ok: true }; },
      addEmojiAlias: async () => { calls.push('addEmojiAlias'); return { ok: true }; },
    },
  };
}

describe('emoji add (command output)', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;
  let dir: string;

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    dir = await mkdtemp(join(tmpdir(), 'slackcli-emoji-add-'));
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(async () => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  async function addFile(bytes: number, json: boolean) {
    const file = join(dir, 'party-kiro.png');
    await writeFile(file, Buffer.alloc(bytes, 1));
    const { stub, calls } = client();
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);
    await createEmojiCommand().parseAsync(['add', 'party-kiro', '--file', file, ...(json ? ['--json'] : [])], { from: 'user' });
    return calls;
  }

  it.each([
    { bytes: EMOJI_MAX_BYTES, warns: false },
    { bytes: EMOJI_MAX_BYTES + 1, warns: true },
  ])('warns before uploading only above the size guidance ($bytes bytes)', async ({ bytes, warns }) => {
    const calls = await addFile(bytes, true);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual(['addEmoji']);
    expect(stderr.includes(`Image is ${Math.round(bytes / 1024)} KB; ${WARNING}`)).toBe(warns);
    expect(JSON.parse(stdout)).toEqual({ name: 'party-kiro', is_alias: false });
  });

  it('an alias never gets the size warning', async () => {
    const { stub } = client();
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);

    await createEmojiCommand().parseAsync(['add', 'r7', '--alias-for', ':rapid7:'], { from: 'user' });

    expect(stderr).not.toContain(WARNING);
    expect(stderr).toContain('Added alias :r7: → :rapid7:');
    expect(stdout).toBe('');
  });

  it('without --json an image prints only the success line, nothing on stdout', async () => {
    await addFile(4, false);

    expect(process.exitCode).toBe(0);
    expect(stderr).toContain('Added :party-kiro:');
    expect(stderr).not.toContain('Added alias');
    expect(stdout).toBe('');
  });
});
