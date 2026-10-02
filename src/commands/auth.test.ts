import { describe, expect, it, mock, afterEach, beforeEach, spyOn } from 'bun:test';
import { createAuthCommand, resolveSecretBackend } from './auth.ts';
import * as authLib from '../lib/auth.ts';
import * as workspacesLib from '../lib/workspaces.ts';
import type { IdentityResult, ProfileCheck } from '../types/index.ts';

function subcommand(name: string) {
  return createAuthCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

function mandatoryOptions(name: string): string[] {
  return (subcommand(name)?.options ?? [])
    .filter((option) => option.mandatory)
    .map((option) => option.long ?? '')
    .sort();
}

describe('resolveSecretBackend', () => {
  it('accepts "file" on any platform', () => {
    expect(resolveSecretBackend('file', 'linux')).toBe('file');
    expect(resolveSecretBackend('file', 'darwin')).toBe('file');
  });

  it('accepts "keychain" only on darwin', () => {
    expect(resolveSecretBackend('keychain', 'darwin')).toBe('keychain');
  });

  it('exits with a clear message for an unrecognised value', () => {
    const exitSpy = mock(() => { throw new Error('exit'); });
    const original = process.exit;
    process.exit = exitSpy as never;
    try {
      expect(() => resolveSecretBackend('vault', 'darwin')).toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.exit = original;
    }
  });

  it('exits rather than silently falling back to file when keychain is requested off macOS', () => {
    const exitSpy = mock(() => { throw new Error('exit'); });
    const original = process.exit;
    process.exit = exitSpy as never;
    try {
      expect(() => resolveSecretBackend('keychain', 'linux')).toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.exit = original;
    }
  });
});

describe('auth command wiring', () => {
  it('exposes --secret-backend, defaulting to file, on every login path', () => {
    for (const name of ['login', 'login-browser', 'login-auto']) {
      expect(longOptions(name)).toContain('--secret-backend');
      const opt = subcommand(name)?.options.find((o) => o.long === '--secret-backend');
      expect(opt?.defaultValue).toBe('file');
    }
    const parseCurl = longOptions('parse-curl');
    expect(parseCurl).toContain('--secret-backend');
    expect(parseCurl).toContain('--login');
  });

  it('adds migrate-secrets requiring --to, with --profile optional and --yes off by default', () => {
    expect(mandatoryOptions('migrate-secrets')).toEqual(['--to']);
    const options = subcommand('migrate-secrets')?.options ?? [];
    expect(options.find((o) => o.long === '--profile')?.mandatory).toBe(false);
    expect(options.find((o) => o.long === '--yes')?.defaultValue).toBe(false);
  });
});

describe('migrate-secrets confirmation gate', () => {
  afterEach(() => {
    mock.restore();
  });

  it('refuses to run unattended without --yes when stdin is not a TTY', async () => {
    const command = createAuthCommand();
    const migrate = command.commands.find((c) => c.name() === 'migrate-secrets')!;
    migrate.exitOverride();
    migrate.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    const realIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const exitSpy = mock(() => { throw new Error('exit'); });
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await expect(
        command.parseAsync(['migrate-secrets', '--to', 'file'], { from: 'user' }),
      ).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
      process.exit = originalExit;
    }
  });
});

describe('auth whoami', () => {
  const profile = {
    profile: 'acme',
    workspace_id: 'T1',
    workspace_name: 'example',
    auth_type: 'browser',
    source: 'default',
  } as const;
  const verified: IdentityResult = { ...profile, status: 'ok', user: 'alice', user_id: 'U1' };
  const refused: IdentityResult = {
    ...profile,
    status: 'auth_failed',
    user_id: 'U1',
    error: { code: 'invalid_auth', meaning: 'The stored browser session is no longer valid.', fix: 'slackcli auth login-auto' },
  };
  const unreachable: IdentityResult = {
    ...profile,
    status: 'unreachable',
    user_id: 'U1',
    error: { message: 'Slack API error: fetch failed' },
  };

  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
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
    // The command reports failure through process.exitCode; do not let it
    // become the test run's own exit code.
    process.exitCode = savedExitCode ?? 0;
  });

  async function whoami(result: IdentityResult, args: string[] = []) {
    const check = spyOn(authLib, 'checkIdentity').mockResolvedValue(result);
    await createAuthCommand().parseAsync(['whoami', ...args], { from: 'user' });
    return { check, exitCode: process.exitCode };
  }

  it('offers --workspace and --json, with --json off by default', () => {
    expect(longOptions('whoami').sort()).toEqual(['--json', '--workspace']);
    expect(subcommand('whoami')?.options.find((o) => o.long === '--json')?.defaultValue).toBe(false);
  });

  it('passes --workspace to the lookup', async () => {
    const { check } = await whoami(verified, ['--workspace', 'acme', '--json']);
    expect(check).toHaveBeenCalledWith('acme');
  });

  it.each([
    ['ok', verified, 0],
    ['auth_failed', refused, 1],
    ['unreachable', unreachable, 1],
  ] as const)('writes exactly the %s result as one JSON object', async (_status, result, code) => {
    const { exitCode } = await whoami(result, ['--json']);
    expect(JSON.parse(stdout)).toEqual(result);
    expect(exitCode).toBe(code);
  });

  it('prints the verified identity and exits 0', async () => {
    const { exitCode } = await whoami(verified);
    expect(stdout).toContain('Profile: acme');
    expect(stdout).toContain('User: alice (U1)');
    expect(stdout).toContain('Status: verified');
    expect(exitCode).toBe(0);
  });

  it('prints the stored details, then the meaning and fix, when Slack refuses the credentials', async () => {
    const { exitCode } = await whoami(refused);
    expect(stdout).toContain('Profile: acme');
    expect(stdout).toContain('Status: authentication failed (invalid_auth)');
    expect(stderr).toContain('invalid_auth: The stored browser session is no longer valid.');
    expect(stderr).toContain('To fix: slackcli auth login-auto');
    expect(exitCode).toBe(1);
  });

  it('reports an unreachable Slack as such, never as an authentication failure', async () => {
    const { exitCode } = await whoami(unreachable);
    expect(stdout).toContain('Profile: acme');
    expect(stdout).toContain('Status: unreachable');
    expect(stderr).toContain('Slack API error: fetch failed');
    expect(stderr).toContain('the credentials were not checked');
    expect(stdout + stderr).not.toContain('authentication failed');
    expect(stdout + stderr).not.toContain('To fix:');
    expect(exitCode).toBe(1);
  });

  it('exits 1 with the error and nothing on stdout when no profile resolves', async () => {
    spyOn(authLib, 'checkIdentity').mockRejectedValue(new Error('Workspace not found: nope'));
    const exitSpy = mock(() => { throw new Error('exit'); });
    const originalExit = process.exit;
    process.exit = exitSpy as never;
    try {
      await expect(
        createAuthCommand().parseAsync(['whoami', '--workspace', 'nope', '--json'], { from: 'user' }),
      ).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr).toContain('Workspace not found: nope');
      expect(stdout).toBe('');
    } finally {
      process.exit = originalExit;
    }
  });
});

describe('auth list', () => {
  // As stored: metadata only, the way getAllWorkspaceEntries() returns it.
  const entries = [
    {
      key: 'T1',
      config: { workspace_id: 'T1', workspace_name: 'example', auth_type: 'browser', workspace_url: 'https://example.slack.com' },
    },
    {
      key: 'bot',
      config: { workspace_id: 'T1', workspace_name: 'example', auth_type: 'standard', token_type: 'bot', profile: 'bot', secret_backend: 'keychain' },
    },
  ] as unknown as workspacesLib.ResolvedWorkspace[];
  const listed = [
    { profile: 'T1', workspace_id: 'T1', workspace_name: 'example', auth_type: 'browser', is_default: true, secret_backend: 'file' },
    { profile: 'bot', workspace_id: 'T1', workspace_name: 'example', auth_type: 'standard', is_default: false, secret_backend: 'keychain' },
  ];

  const ok: ProfileCheck = { status: 'ok', user: 'alice', user_id: 'U1' };
  const refused: ProfileCheck = {
    status: 'auth_failed',
    error: { code: 'invalid_auth', meaning: 'The stored browser session is no longer valid.', fix: 'slackcli auth login-auto' },
  };
  const unreachable: ProfileCheck = { status: 'unreachable', error: { message: 'Slack API error: fetch failed' } };

  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
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
    // The command reports failure through process.exitCode; do not let it
    // become the test run's own exit code.
    process.exitCode = savedExitCode ?? 0;
  });

  async function list(args: string[], checks: ProfileCheck[] = [], stored = entries, defaultKey: string | null = 'T1') {
    spyOn(workspacesLib, 'getAllWorkspaceEntries').mockResolvedValue(stored);
    spyOn(workspacesLib, 'getDefaultWorkspaceId').mockResolvedValue(defaultKey ?? undefined);
    const check = spyOn(authLib, 'checkAllProfiles').mockImplementation(async (onProgress) => {
      stored.forEach(({ key }, i) => onProgress?.({ profile: key, index: i + 1, total: stored.length }));
      return stored.map(({ key }, i) => ({ profile: key, check: checks[i] }));
    });
    await createAuthCommand().parseAsync(['list', ...args], { from: 'user' });
    return { check, exitCode: process.exitCode };
  }

  it('offers --check and --json, both off by default', () => {
    expect(longOptions('list').sort()).toEqual(['--check', '--json']);
    for (const option of subcommand('list')?.options ?? []) {
      expect(option.defaultValue).toBe(false);
    }
  });

  it('prints the stored profiles and checks nothing without --check', async () => {
    const { check, exitCode } = await list([]);
    expect(check).not.toHaveBeenCalled();
    expect(stdout).toContain('Authenticated Workspaces (2)');
    expect(stdout).toContain('1. ');
    expect(stdout).toContain('Profile: bot');
    expect(stdout).not.toContain('Status:');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  it('writes one JSON object with no check field without --check', async () => {
    const { check, exitCode } = await list(['--json']);
    expect(check).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toEqual({ default: 'T1', workspaces: listed });
    expect(exitCode).toBe(0);
  });

  it('reports a null default when none is stored', async () => {
    await list(['--json'], [], entries, null);
    const parsed = JSON.parse(stdout);
    expect(parsed.default).toBeNull();
    expect(parsed.workspaces.map((w: { is_default: boolean }) => w.is_default)).toEqual([false, false]);
  });

  it('adds a check to every profile and exits 0 when all are ok', async () => {
    const { check, exitCode } = await list(['--check', '--json'], [ok, ok]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout)).toEqual({
      default: 'T1',
      workspaces: [{ ...listed[0], check: ok }, { ...listed[1], check: ok }],
    });
    expect(exitCode).toBe(0);
  });

  it.each([
    ['an auth failure', [ok, refused]],
    ['an unreachable profile', [unreachable, ok]],
    ['a mix of failures', [refused, unreachable]],
  ] as const)('exits 1 with %s, still writing one JSON object for every profile', async (_name, checks) => {
    const { exitCode } = await list(['--check', '--json'], [...checks]);
    expect(JSON.parse(stdout).workspaces.map((w: { check: ProfileCheck }) => w.check)).toEqual([...checks]);
    expect(exitCode).toBe(1);
  });

  it('prints a status under each profile with --check', async () => {
    const { exitCode } = await list(['--check'], [refused, unreachable]);
    expect(stdout).toContain('Status: auth failed (invalid_auth: The stored browser session is no longer valid.)');
    expect(stdout).toContain('To fix: slackcli auth login-auto');
    expect(stdout).toContain('Status: unreachable (Slack API error: fetch failed)');
    expect(exitCode).toBe(1);

    stdout = '';
    process.exitCode = 0;
    const verified = await list(['--check'], [ok, ok]);
    expect(stdout.match(/Status: ok \(alice, U1\)/g)).toHaveLength(2);
    expect(verified.exitCode).toBe(0);
  });

  it.each([[[]], [['--check']]] as const)('prints the guidance and exits 0 for %j when no profile is stored', async (args) => {
    const { check, exitCode } = await list([...args], [], [], null);
    expect(check).not.toHaveBeenCalled();
    expect(stdout).toContain('No authenticated workspaces found.');
    expect(stdout).toContain('Run "slackcli auth login" or "slackcli auth login-browser" to authenticate.');
    expect(exitCode).toBe(0);
  });

  it.each([[['--json']], [['--check', '--json']]] as const)('writes an empty list for %j when no profile is stored', async (args) => {
    const { check, exitCode } = await list([...args], [], [], null);
    expect(check).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toEqual({ default: null, workspaces: [] });
    expect(exitCode).toBe(0);
  });

  it('exits 1 with the error and nothing on stdout when the config cannot be read', async () => {
    spyOn(workspacesLib, 'getAllWorkspaceEntries').mockRejectedValue(new Error('workspaces.json is not valid JSON'));
    const exitSpy = mock(() => { throw new Error('exit'); });
    const originalExit = process.exit;
    process.exit = exitSpy as never;
    try {
      await expect(
        createAuthCommand().parseAsync(['list', '--check', '--json'], { from: 'user' }),
      ).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr).toContain('workspaces.json is not valid JSON');
      expect(stdout).toBe('');
    } finally {
      process.exit = originalExit;
    }
  });
});
