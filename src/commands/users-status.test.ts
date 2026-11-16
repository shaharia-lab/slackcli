// users set-status / users clear-status in process. The client is real and
// its transport is stubbed, so a dry run, a refused confirm, and a bot token
// are "no users.profile.set call".
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createUsersCommand } from './users.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

const USER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  profile: 'acme',
  auth_type: 'standard',
  token: 'xoxp-fake',
  token_type: 'user',
};

const BOT: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  auth_type: 'standard',
  token: 'xoxb-fake',
  token_type: 'bot',
};

type Call = { method: string; params: Record<string, unknown> };

function clientFor(config: WorkspaceConfig): { client: SlackClient; calls: Call[] } {
  const client = new SlackClient(config);
  const calls: Call[] = [];
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    return { ok: true };
  });
  return { client, calls };
}

describe('users set-status / clear-status', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
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

  afterEach(() => {
    mock.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(config: WorkspaceConfig, argv: string[]): Promise<Call[]> {
    const { client, calls } = clientFor(config);
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client);
    await createUsersCommand().parseAsync(argv, { from: 'user' });
    return calls;
  }

  function lastError(): { code: string; message: string; hint?: string } {
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).error;
  }

  it.each([
    ['browser session', BROWSER],
    ['user token', USER],
  ])('set-status --yes writes the profile on a %s', async (_label, config) => {
    const calls = await run(config, [
      'set-status', '--text', 'Out of office', '--emoji', ':palm_tree:', '--yes', '--json',
    ]);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([{
      method: 'users.profile.set',
      params: {
        profile: JSON.stringify({
          status_text: 'Out of office',
          status_emoji: ':palm_tree:',
          status_expiration: 0,
        }),
      },
    }]);
    expect(JSON.parse(stdout)).toEqual({
      status_text: 'Out of office',
      status_emoji: ':palm_tree:',
      status_expiration: 0,
    });
  });

  it('clear-status --yes sends empty text and emoji', async () => {
    const calls = await run(BROWSER, ['clear-status', '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([{
      method: 'users.profile.set',
      params: {
        profile: JSON.stringify({ status_text: '', status_emoji: '', status_expiration: 0 }),
      },
    }]);
    expect(JSON.parse(stdout)).toEqual({ status_text: '', status_emoji: '', status_expiration: 0 });
  });

  it('set-status --dry-run prints the preview and does not write or prompt', async () => {
    const calls = await run(BROWSER, [
      'set-status', '--text', 'Out of office', '--emoji', ':palm_tree:', '--dry-run', '--json',
    ]);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      dry_run: true,
      action: 'set status',
      payload: { status_text: 'Out of office', status_emoji: ':palm_tree:', status_expiration: 0 },
    });
    expect(stderr).not.toContain('[y/N]');
  });

  it('clear-status --dry-run prints empty fields and does not write', async () => {
    const calls = await run(BROWSER, ['clear-status', '--dry-run', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(stdout).payload).toEqual({ status_text: '', status_emoji: '', status_expiration: 0 });
  });

  it('refuses set-status unattended without --yes and does not write', async () => {
    const calls = await run(BROWSER, [
      'set-status', '--text', 'Out of office', '--emoji', ':palm_tree:', '--json',
    ]);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(lastError().code).toBe('confirmation_required');
  });

  it('refuses clear-status unattended without --yes and does not write', async () => {
    const calls = await run(BROWSER, ['clear-status', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(lastError().code).toBe('confirmation_required');
  });

  it.each([
    ['set-status', ['set-status', '--text', 'Out of office', '--emoji', ':palm_tree:', '--yes', '--json']],
    ['clear-status', ['clear-status', '--yes', '--json']],
  ])('%s on a bot token fails before any call', async (_name, argv) => {
    const calls = await run(BOT, argv);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    const error = lastError();
    expect(error.code).toBe('unsupported_auth_type');
    expect(error.message).toContain('bot token');
    expect(error.hint).toContain('login-auto');
  });

  it('rejects status text past 100 characters before any call', async () => {
    const calls = await run(BROWSER, [
      'set-status', '--text', 'a'.repeat(101), '--emoji', ':palm_tree:', '--yes', '--json',
    ]);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(lastError().code).toBe('invalid_input');
  });

  it('accepts 100 characters', async () => {
    const text = 'a'.repeat(100);
    const calls = await run(USER, ['set-status', '--text', text, '--emoji', ':palm_tree:', '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(stdout).status_text).toBe(text);
  });
});
