import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { getLogger, resetSync } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';
import {
  LOG_FILE_NAME,
  LOG_MAX_SIZE_BYTES,
  buildSessionStart,
  configureLogging,
  describeInvocation,
  detectInstallMethod,
  resolveLogDir,
  resolveLogLevel,
  tildify,
} from './logger.ts';
import type { InstallMethod } from './logger.ts';

const isPosix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'slackcli-logger-'));
});

afterEach(() => {
  resetSync();
  try {
    chmodSync(tmp, 0o700);
  } catch {
    // already gone
  }
  rmSync(tmp, { recursive: true, force: true });
});

function readLines(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('resolveLogDir', () => {
  it('uses XDG_STATE_HOME on Linux when it is absolute', () => {
    expect(resolveLogDir({ XDG_STATE_HOME: '/state' }, 'linux', '/home/u')).toBe('/state/slackcli/logs');
  });

  it('falls back to ~/.local/state on Linux when XDG_STATE_HOME is unset, empty or relative', () => {
    expect(resolveLogDir({}, 'linux', '/home/u')).toBe('/home/u/.local/state/slackcli/logs');
    expect(resolveLogDir({ XDG_STATE_HOME: '  ' }, 'linux', '/home/u')).toBe('/home/u/.local/state/slackcli/logs');
    expect(resolveLogDir({ XDG_STATE_HOME: 'rel/state' }, 'linux', '/home/u')).toBe('/home/u/.local/state/slackcli/logs');
  });

  it('treats other POSIX platforms like Linux', () => {
    expect(resolveLogDir({}, 'freebsd', '/home/u')).toBe('/home/u/.local/state/slackcli/logs');
  });

  it('uses ~/Library/Logs on macOS and ignores XDG_STATE_HOME there', () => {
    expect(resolveLogDir({ XDG_STATE_HOME: '/state' }, 'darwin', '/Users/u')).toBe('/Users/u/Library/Logs/slackcli');
  });

  it('uses %LOCALAPPDATA% on Windows with Windows separators', () => {
    expect(resolveLogDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'))
      .toBe('C:\\Users\\u\\AppData\\Local\\slackcli\\logs');
  });

  it('falls back to <home>\\AppData\\Local on Windows when LOCALAPPDATA is unset', () => {
    expect(resolveLogDir({}, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Local\\slackcli\\logs');
  });

  it('lets SLACKCLI_LOG_DIR override every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(resolveLogDir({ SLACKCLI_LOG_DIR: '/custom', XDG_STATE_HOME: '/state' }, platform, '/h')).toBe('/custom');
    }
  });

  it('ignores a blank SLACKCLI_LOG_DIR', () => {
    expect(resolveLogDir({ SLACKCLI_LOG_DIR: ' ' }, 'linux', '/home/u')).toBe('/home/u/.local/state/slackcli/logs');
  });
});

describe('resolveLogLevel', () => {
  it('defaults to info', () => {
    expect(resolveLogLevel({ verbose: false })).toEqual({ level: 'info' });
    expect(resolveLogLevel({ verbose: false, envValue: '' })).toEqual({ level: 'info' });
  });

  it('honours every documented SLACKCLI_LOG_LEVEL value, case-insensitively', () => {
    for (const level of ['trace', 'debug', 'info', 'warning', 'error', 'off'] as const) {
      expect(resolveLogLevel({ verbose: false, envValue: level })).toEqual({ level });
      expect(resolveLogLevel({ verbose: false, envValue: ` ${level.toUpperCase()} ` })).toEqual({ level });
    }
  });

  it('lets -v win over the env value', () => {
    for (const envValue of [undefined, 'off', 'error', 'warning', 'info', 'debug']) {
      expect(resolveLogLevel({ verbose: true, envValue }).level).toBe('debug');
    }
  });

  it('does not let -v make an explicit trace less verbose', () => {
    expect(resolveLogLevel({ verbose: true, envValue: 'trace' }).level).toBe('trace');
  });

  it('falls back to info and reports an unknown value', () => {
    expect(resolveLogLevel({ verbose: false, envValue: 'loud' })).toEqual({ level: 'info', invalidValue: 'loud' });
    expect(resolveLogLevel({ verbose: true, envValue: 'loud' })).toEqual({ level: 'debug', invalidValue: 'loud' });
  });
});

describe('tildify', () => {
  it('replaces a leading home directory only', () => {
    expect(tildify('/home/u/.bun/bin/bun', '/home/u')).toBe('~/.bun/bin/bun');
    expect(tildify('/home/u', '/home/u')).toBe('~');
    expect(tildify('/home/user2/bin', '/home/u')).toBe('/home/user2/bin');
    expect(tildify('/usr/local/bin/slackcli', '/home/u')).toBe('/usr/local/bin/slackcli');
    expect(tildify('C:\\Users\\u\\bin\\slackcli.exe', 'C:\\Users\\u')).toBe('~\\bin\\slackcli.exe');
    expect(tildify('/x', '')).toBe('/x');
  });
});

describe('detectInstallMethod', () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('reports source when running under the Bun interpreter (as tests do)', () => {
    expect(detectInstallMethod()).toBe('source');
  });

  it.each([
    ['a Homebrew Cellar binary', '/usr/local/Cellar/slackcli/0.4.0/bin/slackcli', 'homebrew'],
    ['an Apple Silicon Homebrew binary', '/opt/homebrew/bin/slackcli', 'homebrew'],
    ['a linuxbrew binary', '/home/linuxbrew/.linuxbrew/bin/slackcli', 'homebrew'],
    ['a standalone binary', '/usr/local/bin/slackcli', 'binary'],
    ['a Windows binary', 'C:\\Tools\\slackcli.exe', 'binary'],
    ['source under a Homebrew-installed Bun', '/opt/homebrew/bin/bun', 'source'],
    ['source under a linuxbrew Bun', '/home/linuxbrew/.linuxbrew/bin/bun', 'source'],
    ['source under Bun on Windows', 'C:\\Users\\u\\.bun\\bin\\bun.exe', 'source'],
  ] as const satisfies ReadonlyArray<readonly [string, string, InstallMethod]>)('for %s (%s) returns %p', (_label, execPath, expected) => {
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    expect(detectInstallMethod()).toBe(expected);
  });
});

describe('describeInvocation', () => {
  function parse(argv: string[]): Command {
    let action: Command | undefined;
    const program = new Command().name('slackcli').exitOverride().option('-v, --verbose');
    const messages = program.command('messages');
    messages.command('send')
      .argument('<text>')
      .requiredOption('--recipient-id <id>')
      .option('--thread-ts <ts>')
      .option('--json', 'json', false)
      .action((_text, _opts, cmd: Command) => { action = cmd; });
    program.parse(argv, { from: 'user' });
    return action!;
  }

  it('records the subcommand path and given option names, never values or positionals', () => {
    const invocation = describeInvocation(
      parse(['messages', 'send', 'secret message text', '--recipient-id', 'C123', '--json', '-v']),
    );

    expect(invocation).toEqual({ command: 'messages send', options: ['--json', '--recipient-id', '--verbose'] });
    expect(JSON.stringify(invocation)).not.toContain('secret');
    expect(JSON.stringify(invocation)).not.toContain('C123');
  });

  it('leaves out options that only carry their default', () => {
    expect(describeInvocation(parse(['messages', 'send', 'hi', '--recipient-id', 'C1'])).options)
      .toEqual(['--recipient-id']);
  });
});

describe('buildSessionStart', () => {
  it('carries the environment header fields', () => {
    const header = buildSessionStart({
      command: 'team info',
      options: ['--json'],
      execPath: '/home/u/.bun/bin/bun',
      home: '/home/u',
    });

    expect(header).toMatchObject({
      event: 'session_start',
      command: 'team info',
      options: ['--json'],
      exec_path: '~/.bun/bin/bun',
      install_method: 'source',
      arch: process.arch,
      stdout_tty: Boolean(process.stdout.isTTY),
    });
    expect(typeof header.version).toBe('string');
    expect(typeof header.os).toBe('string');
    expect(typeof header.os_release).toBe('string');
    expect(header.runtime).toMatch(/^bun \d+\.\d+/);
  });
});

describe('configureLogging', () => {
  it('writes JSON Lines with the run id on every record, readable without a flush', () => {
    const dir = join(tmp, 'logs');
    const setup = configureLogging({ level: 'info', verbose: false, dir, runId: 'run-1' });

    getLogger(['slackcli', 'session']).info('session_start', { event: 'session_start' });
    getLogger(['slackcli', 'slack-client']).info('call', { method: 'auth.test' });
    getLogger(['slackcli', 'slack-client']).debug('too detailed for info');

    expect(setup.logFile).toBe(join(dir, LOG_FILE_NAME));
    // No flush or dispose: bufferSize 0 means the data is already on disk.
    const lines = readLines(setup.logFile!);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.properties).toMatchObject({ run_id: 'run-1', event: 'session_start' });
    expect(lines[1]!.properties).toMatchObject({ run_id: 'run-1', method: 'auth.test' });
    expect(lines[1]!.logger).toBe('slackcli.slack-client');
  });

  it('still writes the session_start header when the level is above info', () => {
    const setup = configureLogging({ level: 'error', verbose: false, dir: join(tmp, 'logs') });
    getLogger(['slackcli', 'session']).info('session_start', { event: 'session_start' });
    getLogger(['slackcli', 'slack-client']).info('dropped at error level');
    getLogger(['slackcli', 'slack-client']).error('kept');

    expect(readLines(setup.logFile!).map((r) => r.message)).toEqual(['session_start', 'kept']);
  });

  it('generates a fresh run id per configuration', () => {
    const a = configureLogging({ level: 'info', verbose: false });
    const b = configureLogging({ level: 'info', verbose: false });
    expect(a.runId).not.toBe(b.runId);
    expect(a.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('redacts tokens before they reach the file', () => {
    const setup = configureLogging({ level: 'info', verbose: false, dir: join(tmp, 'logs') });
    getLogger(['slackcli', 'x']).warn('failed with xoxc-123-456-abcdef', {
      cookie: 'd=xoxd-AbC%2FdEf%3D',
      token: 'xoxe.xoxp-1-abcdef',
    });

    const text = readFileSync(setup.logFile!, 'utf-8');
    expect(text).not.toContain('xoxc-123');
    expect(text).not.toContain('AbC%2F');
    expect(text).not.toContain('xoxp-1');
  });

  it.skipIf(!isPosix)('creates the directory 0o700 and the file 0o600, including after rotation', () => {
    const dir = join(tmp, 'nested', 'logs');
    const previousUmask = process.umask(0o022);
    try {
      const setup = configureLogging({ level: 'info', verbose: false, dir });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(setup.logFile!).mode & 0o777).toBe(0o600);

      // Push the file past the rotation threshold, then write once more so the
      // sink rolls over and opens a fresh file.
      const logger = getLogger(['slackcli', 'x']);
      logger.info('big', { blob: 'x'.repeat(LOG_MAX_SIZE_BYTES) });
      logger.info('after rotation');

      expect(existsSync(`${setup.logFile}.1`)).toBe(true);
      expect(statSync(setup.logFile!).mode & 0o777).toBe(0o600);
      expect(readLines(setup.logFile!).at(-1)!.message).toBe('after rotation');
      // The umask tightening is scoped to the sink's own calls.
      expect(process.umask()).toBe(0o022);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(!isPosix)('tightens the mode of a log file left behind with looser permissions', () => {
    const dir = join(tmp, 'logs');
    configureLogging({ level: 'info', verbose: false, dir });
    resetSync();
    const file = join(dir, LOG_FILE_NAME);
    chmodSync(file, 0o644);

    configureLogging({ level: 'info', verbose: false, dir });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!isPosix || isRoot)('keeps working with exactly one warning when the directory is unwritable', () => {
    chmodSync(tmp, 0o500);
    const warnings: string[] = [];
    const captured: LogRecord[] = [];

    const setup = configureLogging({
      level: 'info',
      verbose: false,
      dir: join(tmp, 'logs'),
      warn: (message) => warnings.push(message),
      sinks: { capture: (record) => captured.push(record) },
    });
    getLogger(['slackcli', 'x']).info('still logged elsewhere');
    getLogger(['slackcli', 'x']).info('and again');

    expect(setup.logFile).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(tmp, 'logs'));
    expect(captured).toHaveLength(2);
  });

  it.skipIf(!isPosix || isRoot)('stops file logging with one warning when a write fails mid-run', () => {
    const dir = join(tmp, 'logs');
    const warnings: string[] = [];
    const setup = configureLogging({ level: 'info', verbose: false, dir, warn: (m) => warnings.push(m) });

    // Writes to the open descriptor keep working, so force a failure by
    // removing write access to the directory and triggering a rollover.
    chmodSync(dir, 0o500);
    const logger = getLogger(['slackcli', 'x']);
    expect(() => logger.info('big', { blob: 'x'.repeat(LOG_MAX_SIZE_BYTES) })).not.toThrow();
    expect(() => logger.info('rollover fails here')).not.toThrow();
    expect(() => logger.info('silently dropped')).not.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Stopped writing logs');
    chmodSync(dir, 0o700);
    expect(setup.logFile).toBeDefined();
  });

  it('writes nothing, and creates nothing, when the level is off', () => {
    const dir = join(tmp, 'logs');
    const captured: LogRecord[] = [];
    const stderr: string[] = [];
    const setup = configureLogging({
      level: 'off',
      verbose: true,
      dir,
      writeStderr: (t) => stderr.push(t),
      sinks: { capture: (r) => captured.push(r) },
    });

    getLogger(['slackcli', 'x']).fatal('even fatal is dropped');

    expect(setup.logFile).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(captured).toHaveLength(0);
    expect(stderr).toHaveLength(0);
  });

  it('sends log lines to stderr only when verbose', () => {
    const stderr: string[] = [];
    configureLogging({ level: 'debug', verbose: false, writeStderr: (t) => stderr.push(t) });
    getLogger(['slackcli', 'x']).info('quiet');
    expect(stderr).toHaveLength(0);

    configureLogging({ level: 'debug', verbose: true, writeStderr: (t) => stderr.push(t) });
    getLogger(['slackcli', 'x']).debug('loud {token}', { token: 'xoxb-1-2-secretvalue' });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('loud');
    expect(stderr[0]).not.toContain('secretvalue');
  });

  it('ignores categories outside slackcli', () => {
    const captured: LogRecord[] = [];
    configureLogging({ level: 'trace', verbose: false, sinks: { capture: (r) => captured.push(r) } });
    getLogger(['other']).error('not ours');
    expect(captured).toHaveLength(0);
  });
});

describe('process integration', () => {
  const root = join(import.meta.dir, '..', '..');

  it('keeps a record logged right before process.exit(1)', () => {
    const dir = join(tmp, 'logs');
    const script = join(tmp, 'exit.ts');
    writeFileSync(script, `
      import { configureLogging } from ${JSON.stringify(join(root, 'src/lib/logger.ts'))};
      import { getLogger } from '@logtape/logtape';
      configureLogging({ level: 'info', verbose: false, dir: ${JSON.stringify(dir)} });
      getLogger(['slackcli', 'x']).error('last words');
      process.exit(1);
    `);

    const result = Bun.spawnSync([process.execPath, script], { cwd: root });

    expect(result.exitCode).toBe(1);
    const lines = readLines(join(dir, LOG_FILE_NAME));
    expect(lines.at(-1)!.message).toBe('last words');
  });

  it('never writes logs to stdout, even at trace with -v', () => {
    const dir = join(tmp, 'logs');
    const result = Bun.spawnSync(
      [process.execPath, 'run', join(root, 'src/index.ts'), 'team', 'info', '--json', '-v'],
      {
        cwd: root,
        env: { ...process.env, HOME: tmp, SLACKCLI_LOG_DIR: dir, SLACKCLI_LOG_LEVEL: 'trace' },
      },
    );

    // No workspace is configured under the temporary HOME, so the command
    // fails before any API call — after logging has been configured.
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('session_start');
    const header = readLines(join(dir, LOG_FILE_NAME))[0]!;
    expect(header.properties).toMatchObject({
      event: 'session_start',
      command: 'team info',
      options: ['--json', '--verbose'],
    });
  });

  it('warns once about an invalid SLACKCLI_LOG_LEVEL, naming the level actually used', () => {
    const run = (extra: string[]) => Bun.spawnSync(
      [process.execPath, 'run', join(root, 'src/index.ts'), 'team', 'info', ...extra],
      { cwd: root, env: { ...process.env, HOME: tmp, SLACKCLI_LOG_DIR: join(tmp, 'logs'), SLACKCLI_LOG_LEVEL: 'loud' } },
    ).stderr.toString();

    const quiet = run([]);
    expect(quiet.match(/Ignoring SLACKCLI_LOG_LEVEL="loud"/g)).toHaveLength(1);
    expect(quiet).toContain('Using info.');
    expect(run(['-v'])).toContain('Using debug.');
  });
});
