// `emoji add` / `emoji remove` end to end in process, with the Slack client
// stubbed: the add success shape, the remove confirmation gate and --yes, the
// idempotent error_emoji_not_found no-op, and the boundary the maintainer asked
// to pin — enterprise_is_restricted comes out as permission_denied (exit 1), not
// a removed:false no-op.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authLib from '../lib/auth.ts';
import { createEmojiCommand } from './emoji.ts';

function refusal(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

// A browser-auth stub. requireBrowserAuth is a no-op (browser), and each write
// method records its call and returns/raises what the test sets.
function client(overrides: Record<string, (...args: any[]) => Promise<unknown>> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string, fn?: (...a: any[]) => Promise<unknown>) =>
    (...args: unknown[]) => { calls.push([name, args]); return (fn ?? (async () => ({ ok: true })))(...args); };
  return {
    calls,
    stub: {
      authType: 'browser',
      workspaceHost: 'acme.slack.com',
      requireBrowserAuth: () => {},
      addEmoji: record('addEmoji', overrides.addEmoji),
      addEmojiAlias: record('addEmojiAlias', overrides.addEmojiAlias),
      removeEmoji: record('removeEmoji', overrides.removeEmoji),
    },
  };
}

describe('emoji add / remove (command)', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;
  let dir: string;

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    dir = await mkdtemp(join(tmpdir(), 'slackcli-emoji-write-'));
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
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
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  async function run(stub: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);
    await createEmojiCommand().parseAsync(argv, { from: 'user' });
  }

  it('add --file uploads and prints { name, is_alias: false }', async () => {
    const file = join(dir, 'party-kiro.png');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { stub, calls } = client();

    await run(stub, ['add', 'party-kiro', '--file', file, '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['addEmoji', ['party-kiro', file]]]);
    expect(JSON.parse(stdout)).toEqual({ name: 'party-kiro', is_alias: false });
  });

  it('add --alias-for creates an alias and prints alias_for', async () => {
    const { stub, calls } = client();

    await run(stub, ['add', 'r7', '--alias-for', 'rapid7', '--json']);

    expect(calls).toEqual([['addEmojiAlias', ['r7', 'rapid7']]]);
    expect(JSON.parse(stdout)).toEqual({ name: 'r7', is_alias: true, alias_for: 'rapid7' });
  });

  it('add rejects both --file and --alias-for before any call', async () => {
    const file = join(dir, 'x.png');
    await writeFile(file, Buffer.from([1]));
    const { stub, calls } = client();

    await run(stub, ['add', 'x', '--file', file, '--alias-for', 'y', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it('remove with --yes deletes and prints { name, removed: true, already_removed: false }', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', 'party-kiro', '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['removeEmoji', ['party-kiro']]]);
    expect(JSON.parse(stdout)).toEqual({ name: 'party-kiro', removed: true, already_removed: false });
  });

  it('remove refuses unattended without --yes (stdin not a terminal), no call made', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', 'party-kiro', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).toContain('--yes');
  });

  it('remove is idempotent: error_emoji_not_found is removed:false, already_removed:true, exit 0', async () => {
    const { stub } = client({ removeEmoji: async () => { throw refusal('error_emoji_not_found'); } });

    await run(stub, ['remove', 'ghost', '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ name: 'ghost', removed: false, already_removed: true });
    expect(stderr).not.toContain('"error"');
  });

  // The boundary the maintainer asked to pin: a policy denial is a real failure,
  // never the idempotent no-op.
  it('remove surfaces enterprise_is_restricted as permission_denied exit 1, NOT removed:false', async () => {
    const { stub } = client({ removeEmoji: async () => { throw refusal('enterprise_is_restricted'); } });

    await run(stub, ['remove', 'party-kiro', '--yes', '--json']);

    expect(process.exitCode).toBe(1);
    const lines = stderr.trimEnd().split('\n');
    const error = JSON.parse(lines[lines.length - 1]).error;
    expect(error.code).toBe('permission_denied');
    expect(stdout).not.toContain('already_removed');
  });
});
