import { describe, expect, it, mock, afterEach } from 'bun:test';
import { createAuthCommand, resolveSecretBackend } from './auth.ts';

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
