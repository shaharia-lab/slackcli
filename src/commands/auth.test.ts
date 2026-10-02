import { describe, expect, it, mock, afterEach, beforeEach, spyOn } from 'bun:test';
import { createAuthCommand, resolveSecretBackend } from './auth.ts';
import * as authLib from '../lib/auth.ts';
import type { IdentityResult } from '../types/index.ts';

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
