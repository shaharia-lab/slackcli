import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command, InvalidArgumentError } from 'commander';
import { getLogger, resetSync } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';
import {
  LOG_FILE_NAME,
  LOG_MAX_SIZE_BYTES,
  buildSessionStart,
  configureLogging,
  describeInvocation,
  detectInstallMethod,
  installUsageErrorLogging,
  isUsageError,
  resolveLogDir,
  resolveLogLevel,
  shouldWriteLogFile,
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

describe('shouldWriteLogFile', () => {
  function actionFor(argv: string[]): Command {
    let action: Command | undefined;
    const program = new Command().name('slackcli').exitOverride();
    const capture = (cmd: Command) => cmd.action((_opts, c: Command) => { action = c; });
    const logs = program.command('logs');
    capture(logs.command('show'));
    capture(logs.command('clear'));
    capture(program.command('team').command('info'));
    capture(program.command('update'));
    program.parse(argv, { from: 'user' });
    return action!;
  }

  it('is false for every logs subcommand, so reading the log never adds to it', () => {
    expect(shouldWriteLogFile(actionFor(['logs', 'show']))).toBe(false);
    expect(shouldWriteLogFile(actionFor(['logs', 'clear']))).toBe(false);
  });

  it('is true for other commands, nested or top-level', () => {
    expect(shouldWriteLogFile(actionFor(['team', 'info']))).toBe(true);
    expect(shouldWriteLogFile(actionFor(['update']))).toBe(true);
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

describe('isUsageError', () => {
  it.each([
    'commander.unknownOption',
    'commander.unknownCommand',
    'commander.missingArgument',
    'commander.optionMissingArgument',
    'commander.missingMandatoryOptionValue',
    'commander.invalidArgument',
    'commander.excessArguments',
    'commander.conflictingOption',
    'commander.error',
  ])('is true for %s', (code) => {
    expect(isUsageError(code)).toBe(true);
  });

  it.each([
    'commander.helpDisplayed',
    'commander.help',
    'commander.version',
    'commander.executeSubCommandAsync',
    'unknownOption',
    '',
  ])('is false for %p', (code) => {
    expect(isUsageError(code)).toBe(false);
  });
});

describe('installUsageErrorLogging', () => {
  class Exited extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }

  const envKeys = ['SLACKCLI_LOG_DIR', 'SLACKCLI_LOG_LEVEL'] as const;
  let savedEnv: Record<string, string | undefined>;
  let logDir: string;

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    logDir = join(tmp, 'logs');
    process.env.SLACKCLI_LOG_DIR = logDir;
    delete process.env.SLACKCLI_LOG_LEVEL;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const silence = (cmd: Command): Command => cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  // Mirrors src/index.ts: groups are built on their own and attached with
  // addCommand(), which does not pass an exit override down.
  function buildProgram(): Command {
    const program = silence(new Command().name('slackcli').version('1.2.3').option('-v, --verbose'));
    const messages = silence(new Command('messages'));
    silence(messages.command('send').option('--recipient-id <id>').option('--message <text>').action(() => {}));
    silence(
      messages
        .command('history')
        .option('--limit <n>', 'limit', (value: string) => {
          throw new InvalidArgumentError(`not a number: ${value}`);
        })
        .action(() => {}),
    );
    const users = silence(new Command('users'));
    silence(users.command('info').argument('<user>').action(() => {}));
    const logs = silence(new Command('logs'));
    silence(logs.command('show').action(() => {}));
    program.addCommand(messages);
    program.addCommand(users);
    program.addCommand(logs);
    return program;
  }

  function run(argv: string[], options: { verbose?: boolean; loggingStarted?: boolean } = {}): number | undefined {
    const program = buildProgram();
    installUsageErrorLogging(program, {
      verbose: () => options.verbose ?? false,
      loggingStarted: () => options.loggingStarted ?? false,
      exit: (code) => {
        throw new Exited(code);
      },
    });
    try {
      program.parse(argv, { from: 'user' });
      return undefined;
    } catch (error) {
      if (error instanceof Exited) return error.code;
      throw error;
    }
  }

  const logFile = () => join(logDir, LOG_FILE_NAME);

  it('logs session_start and usage_error for an unknown option on a nested command', () => {
    expect(run(['messages', 'send', '--recipient-id', 'C1', '--message', 'hello there', '--yes'])).toBe(1);

    const [header, record, ...rest] = readLines(logFile());
    expect(rest).toHaveLength(0);
    expect(header!.properties).toMatchObject({
      event: 'session_start',
      command: 'messages send',
      options: ['--message', '--recipient-id'],
    });
    expect(record!.level).toBe('WARN');
    expect(record!.logger).toBe('slackcli.cli');
    expect(record!.properties).toEqual({
      run_id: header!.properties.run_id,
      event: 'usage_error',
      code: 'commander.unknownOption',
      exit_code: 1,
      command: 'messages send',
    });
    const raw = readFileSync(logFile(), 'utf-8');
    expect(raw).not.toContain('hello there');
    expect(raw).not.toContain('C1');
    expect(raw).not.toContain('--yes');
  });

  it('covers every level of the tree: root, group and leaf', () => {
    const cases: Array<[string[], string, string]> = [
      [['nope'], 'commander.unknownCommand', ''],
      [['messages', 'nope'], 'commander.unknownCommand', 'messages'],
      [['users', 'info'], 'commander.missingArgument', 'users info'],
      [['messages', 'send', '--message'], 'commander.optionMissingArgument', 'messages send'],
    ];
    for (const [argv, code, command] of cases) {
      rmSync(logDir, { recursive: true, force: true });
      expect(run(argv)).toBe(1);
      const records = readLines(logFile());
      expect(records.map((r) => r.properties.event)).toEqual(['session_start', 'usage_error']);
      expect(records[1]!.properties).toMatchObject({ code, command });
    }
  });

  it('never logs the value an invalidArgument message echoes', () => {
    expect(run(['messages', 'history', '--limit', 'secret-value'])).toBe(1);

    const raw = readFileSync(logFile(), 'utf-8');
    expect(raw).toContain('commander.invalidArgument');
    expect(raw).not.toContain('secret-value');
    expect(raw).not.toContain('not a number');
  });

  it('keeps help and version exits side-effect free', () => {
    expect(run(['--help'])).toBe(0);
    expect(run(['messages', '--help'])).toBe(0);
    expect(run(['help', 'messages'])).toBe(0);
    expect(run(['--version'])).toBe(0);
    // A group with no subcommand shows help and exits 1: still help, not a usage error.
    expect(run(['messages'])).toBe(1);
    expect(existsSync(logDir)).toBe(false);
  });

  it('does not write the file for a usage error under logs', () => {
    expect(run(['logs', 'show', '--bogus'])).toBe(1);
    expect(existsSync(logDir)).toBe(false);
  });

  it('writes nothing when SLACKCLI_LOG_LEVEL=off', () => {
    process.env.SLACKCLI_LOG_LEVEL = 'off';
    expect(run(['users', 'info'])).toBe(1);
    expect(existsSync(logDir)).toBe(false);
  });

  it('does not write a second session_start when logging already started', () => {
    configureLogging({ level: 'info', verbose: false, dir: logDir });
    expect(run(['users', 'info'], { loggingStarted: true })).toBe(1);

    const records = readLines(logFile());
    expect(records.map((r) => r.properties.event)).toEqual(['usage_error']);
  });

  it('still exits with Commander\'s code when logging cannot be set up', () => {
    writeFileSync(join(tmp, 'not-a-dir'), '');
    process.env.SLACKCLI_LOG_DIR = join(tmp, 'not-a-dir');
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(run(['users', 'info'])).toBe(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not intercept a successful run', () => {
    expect(run(['users', 'info', 'U1'])).toBeUndefined();
    expect(existsSync(logDir)).toBe(false);
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

  it('logs usage errors from every command group in the real tree', () => {
    const indexSource = readFileSync(join(root, 'src/index.ts'), 'utf-8');
    const groups = [...indexSource.matchAll(/program\.addCommand\(create(\w+)Command\(\)\)/g)]
      .map((match) => match[1]!.toLowerCase());
    expect(groups.length).toBeGreaterThanOrEqual(13);
    // The walk only reaches commands registered before it runs.
    expect(indexSource.lastIndexOf('program.addCommand(')).toBeLessThan(indexSource.indexOf('installUsageErrorLogging(program'));

    const run = (args: string[], dir: string) => Bun.spawnSync(
      [process.execPath, 'run', join(root, 'src/index.ts'), ...args],
      { cwd: root, env: { ...process.env, HOME: tmp, SLACKCLI_LOG_DIR: dir, SLACKCLI_LOG_LEVEL: '' } },
    );

    for (const group of groups) {
      const dir = join(tmp, `logs-${group}`);
      expect(run([group, '--no-such-flag'], dir).exitCode).toBe(1);
      if (group === 'logs') {
        expect(existsSync(dir)).toBe(false);
        continue;
      }
      const records = readLines(join(dir, LOG_FILE_NAME));
      expect(records.at(-1)!.properties).toMatchObject({ event: 'usage_error', code: 'commander.unknownOption', command: group });
    }

    const dir = join(tmp, 'logs-mandatory');
    expect(run(['files', 'download', 'F1'], dir).exitCode).toBe(1);
    expect(readLines(join(dir, LOG_FILE_NAME)).at(-1)!.properties).toMatchObject({
      code: 'commander.missingMandatoryOptionValue',
      command: 'files download',
    });
  }, 30_000);

  it('logs a usage error with unchanged stderr and exit code, and help/version write nothing', () => {
    const dir = join(tmp, 'logs');
    const run = (args: string[]) => Bun.spawnSync(
      [process.execPath, 'run', join(root, 'src/index.ts'), ...args],
      { cwd: root, env: { ...process.env, HOME: tmp, SLACKCLI_LOG_DIR: dir, SLACKCLI_LOG_LEVEL: '' } },
    );

    for (const args of [['--help'], ['messages', '--help'], ['help', 'messages'], ['--version']]) {
      expect(run(args).exitCode).toBe(0);
    }
    expect(existsSync(dir)).toBe(false);

    const result = run(['messages', 'send', '--recipient-id', 'C0000000000', '--message', 'x', '--yes']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe("error: unknown option '--yes'\n");
    const records = readLines(join(dir, LOG_FILE_NAME));
    expect(records.map((r) => r.properties.event)).toEqual(['session_start', 'usage_error']);
    expect(records[0]!.properties).toMatchObject({ command: 'messages send' });
    expect(records[1]!.properties).toMatchObject({ code: 'commander.unknownOption', exit_code: 1 });
  }, 15_000);
});
