// Diagnostic logging: a rotating, redacted JSON Lines file written on every run,
// plus stderr output when `-v/--verbose` is given. stdout is never a sink, so
// `--json` output is unaffected.
//
// Library code logs through LogTape categories and stays side-effect free:
//
//   import { getLogger } from '@logtape/logtape';
//   const logger = getLogger(['slackcli', 'my-area']);
//
// Import `getLogger` from LogTape, not from this module: this module imports
// `updater.ts` and `formatter.ts`, so a lib importing it would risk an import
// cycle. A LogTape logger is a no-op until `configureSync()` runs, so lib
// modules and their tests need no setup. Configuration happens once, in
// `src/index.ts`, through `startLogging()`.
//
// Built on LogTape (`@logtape/logtape`, `@logtape/file`, `@logtape/redaction`):
// zero-dependency packages, and a hand-rolled rotating sink plus redaction layer
// would be several hundred lines to maintain (constitution §8).

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { homedir, platform as osPlatform, release } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import {
  configureSync,
  getJsonLinesFormatter,
  getLogger,
  getTextFormatter,
} from '@logtape/logtape';
import type { LogLevel, LogRecord, Sink } from '@logtape/logtape';
import { getRotatingFileSink } from '@logtape/file';
import { redactFormatter } from './log-redaction.ts';
import { warning } from './formatter.ts';
import { isInstalledViaHomebrew } from './updater.ts';
import { getAppVersion, isRunningUnderBun } from '../version.ts';


export type LogLevelSetting = LogLevel | 'off';

export type InstallMethod = 'homebrew' | 'source' | 'binary';

export const LOG_FILE_NAME = 'slackcli.log';
export const LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;
/** Rotated files kept next to the live one: `slackcli.log.1` … `.5`. */
export const LOG_MAX_FILES = 5;

/** Values accepted by `SLACKCLI_LOG_LEVEL`. */
export const LOG_LEVEL_SETTINGS: readonly LogLevelSetting[] = [
  'trace',
  'debug',
  'info',
  'warning',
  'error',
  'off',
];

type Env = Record<string, string | undefined>;

/**
 * Where the log file lives. Pure, so every platform is testable from any host:
 * each branch composes its path with that platform's own path module.
 *
 * - `SLACKCLI_LOG_DIR` wins everywhere.
 * - Linux and other POSIX: `$XDG_STATE_HOME/slackcli/logs`, falling back to
 *   `~/.local/state/slackcli/logs` (a relative `XDG_STATE_HOME` is ignored, as
 *   the XDG spec requires).
 * - macOS: `~/Library/Logs/slackcli`.
 * - Windows: `%LOCALAPPDATA%\slackcli\logs`, falling back to
 *   `<home>\AppData\Local\slackcli\logs`.
 */
export function resolveLogDir(env: Env, platform: NodeJS.Platform, home: string): string {
  const override = env.SLACKCLI_LOG_DIR?.trim();
  if (override) return override;

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base = localAppData || win32.join(home, 'AppData', 'Local');
    return win32.join(base, 'slackcli', 'logs');
  }

  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Logs', 'slackcli');
  }

  const xdgState = env.XDG_STATE_HOME?.trim();
  const base = xdgState && posix.isAbsolute(xdgState)
    ? xdgState
    : posix.join(home, '.local', 'state');
  return posix.join(base, 'slackcli', 'logs');
}

function isLogLevelSetting(value: string): value is LogLevelSetting {
  return (LOG_LEVEL_SETTINGS as readonly string[]).includes(value);
}

export interface ResolvedLogLevel {
  level: LogLevelSetting;
  /** The raw `SLACKCLI_LOG_LEVEL` value when it was not a recognised level. */
  invalidValue?: string;
}

/**
 * Precedence: `-v/--verbose` > `SLACKCLI_LOG_LEVEL` > `info`.
 *
 * `-v` means `debug`, except that it never makes an explicit
 * `SLACKCLI_LOG_LEVEL=trace` less verbose. An unrecognised env value falls back
 * to `info` and is reported so the caller can warn once.
 */
export function resolveLogLevel(options: { verbose: boolean; envValue?: string }): ResolvedLogLevel {
  const raw = options.envValue?.trim().toLowerCase();
  let fromEnv: LogLevelSetting | undefined;
  let invalidValue: string | undefined;

  if (raw) {
    if (isLogLevelSetting(raw)) {
      fromEnv = raw;
    } else {
      invalidValue = options.envValue;
    }
  }

  let level: LogLevelSetting;
  if (options.verbose) {
    level = fromEnv === 'trace' ? 'trace' : 'debug';
  } else {
    level = fromEnv ?? 'info';
  }

  return invalidValue === undefined ? { level } : { level, invalidValue };
}

/**
 * How this copy of slackcli was installed, reusing the detection the updater
 * already relies on. An npm/bun global install runs under the Bun interpreter,
 * so it reports as `source`.
 */
export function detectInstallMethod(): InstallMethod {
  // Bun first: a Homebrew-installed Bun (`/opt/homebrew/bin/bun`) running from
  // source would otherwise match the Homebrew path check.
  if (isRunningUnderBun()) return 'source';
  if (isInstalledViaHomebrew()) return 'homebrew';
  return 'binary';
}

/** Replaces a leading home directory with `~`, so logs do not carry the username. */
export function tildify(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  for (const separator of ['/', '\\']) {
    if (path.startsWith(home + separator)) return `~${path.slice(home.length)}`;
  }
  return path;
}

export interface Invocation {
  /** Subcommand path, e.g. `messages send`. */
  command: string;
  /** Names of the options given on the command line, e.g. `--json`. Never values. */
  options: string[];
}

/**
 * Describes what was run without recording anything the user typed as a value:
 * positional arguments carry message text, search queries and file paths, and
 * option values can too. Only the subcommand path and option names survive.
 */
export function describeInvocation(actionCommand: Command): Invocation {
  const names: string[] = [];
  const options: string[] = [];

  for (let cmd: Command | null = actionCommand; cmd; cmd = cmd.parent) {
    if (cmd.parent) names.unshift(cmd.name());
    for (const option of cmd.options) {
      if (cmd.getOptionValueSource(option.attributeName()) === 'cli') {
        options.push(option.long ?? option.short ?? option.attributeName());
      }
    }
  }

  return { command: names.join(' '), options: options.sort() };
}

export interface SessionStartInput extends Invocation {
  execPath?: string;
  home?: string;
}

/** The environment header written as each run's first record. */
export function buildSessionStart(input: SessionStartInput): Record<string, unknown> {
  const home = input.home ?? homedir();
  return {
    event: 'session_start',
    version: getAppVersion(),
    os: osPlatform(),
    os_release: release(),
    arch: process.arch,
    runtime: `bun ${process.versions.bun ?? 'unknown'}`,
    install_method: detectInstallMethod(),
    exec_path: tildify(input.execPath ?? process.execPath, home),
    command: input.command,
    options: input.options,
    stdout_tty: Boolean(process.stdout.isTTY),
  };
}

// Files created by the sink (the first open, and the fresh file after each
// rotation) get owner-only permissions. The rotating sink opens files itself
// with the default mode, so the process umask is tightened around its calls.
function withPrivateUmask<T>(fn: () => T): T {
  if (process.platform === 'win32') return fn();
  const previous = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

function withRunId(record: LogRecord, runId: string): LogRecord {
  return { ...record, properties: { run_id: runId, ...record.properties } };
}

function createFileSink(
  dir: string,
  runId: string,
  onFailure: (error: unknown) => void,
): { sink: Sink & Disposable; path: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOG_FILE_NAME);

  // Create (or open) the file up front: it fails fast on an unwritable
  // directory, and fixes the mode of a file left behind by an older run.
  closeSync(openSync(path, 'a', 0o600));
  if (process.platform !== 'win32') chmodSync(path, 0o600);

  const inner = withPrivateUmask(() => getRotatingFileSink(path, {
    formatter: redactFormatter(getJsonLinesFormatter()),
    maxSize: LOG_MAX_SIZE_BYTES,
    maxFiles: LOG_MAX_FILES,
    // Write every record straight to disk: the CLI has many `process.exit()`
    // paths, and a buffered record would be lost on each of them.
    bufferSize: 0,
  }));

  let failed = false;
  const sink = ((record: LogRecord) => {
    if (failed) return;
    try {
      withPrivateUmask(() => inner(withRunId(record, runId)));
    } catch (error) {
      // A full disk or a log file deleted mid-run must never fail the command.
      failed = true;
      onFailure(error);
    }
  }) as Sink & Disposable;
  sink[Symbol.dispose] = () => {
    try {
      inner[Symbol.dispose]();
    } catch {
      // A failed rollover already closed the descriptor; nothing left to close.
    }
  };

  return { sink, path };
}

function createStderrSink(runId: string, write: (text: string) => void): Sink {
  const formatter = redactFormatter(getTextFormatter());
  return (record: LogRecord) => {
    try {
      write(formatter(withRunId(record, runId)));
    } catch {
      // stderr closed (e.g. `2>&-`): nothing useful left to do.
    }
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConfigureLoggingOptions {
  level: LogLevelSetting;
  verbose: boolean;
  /** Log directory. Omit to disable the file sink. */
  dir?: string;
  runId?: string;
  /** Test seam: where verbose output goes. Defaults to stderr. */
  writeStderr?: (text: string) => void;
  /** Test seam: how the one-time warning is emitted. Defaults to `warning()` (stderr). */
  warn?: (message: string) => void;
  /** Test seam: extra sinks that receive every record. */
  sinks?: Record<string, Sink>;
}

export interface LoggingSetup {
  runId: string;
  level: LogLevelSetting;
  /** The log file being written, when file logging is active. */
  logFile?: string;
}

/**
 * Configures LogTape for this process. Never throws: when the log directory is
 * unusable it logs to the remaining sinks and warns exactly once.
 */
export function configureLogging(options: ConfigureLoggingOptions): LoggingSetup {
  const runId = options.runId ?? randomUUID();
  const warn = options.warn ?? warning;
  const sinks: Record<string, Sink> = {};
  let logFile: string | undefined;
  let warned = false;
  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    warn(message);
  };

  if (options.level !== 'off') {
    if (options.dir) {
      const dir = options.dir;
      try {
        const file = createFileSink(dir, runId, (error) => {
          warnOnce(`Stopped writing logs to ${dir}: ${describeError(error)}`);
        });
        sinks.file = file.sink;
        logFile = file.path;
      } catch (error) {
        warnOnce(
          `Cannot write logs to ${dir} (${describeError(error)}); continuing without a log file. ` +
          'Set SLACKCLI_LOG_DIR to a writable directory, or SLACKCLI_LOG_LEVEL=off.',
        );
      }
    }

    if (options.verbose) {
      sinks.stderr = createStderrSink(runId, options.writeStderr ?? ((text) => process.stderr.write(text)));
    }

    for (const [name, sink] of Object.entries(options.sinks ?? {})) {
      sinks[`extra:${name}`] = (record: LogRecord) => sink(withRunId(record, runId));
    }
  }

  const sinkNames = Object.keys(sinks);
  configureSync({
    reset: true,
    sinks,
    loggers: [
      { category: ['slackcli'], lowestLevel: options.level === 'off' ? 'fatal' : options.level, sinks: sinkNames },
      // The session_start header is the context every other line needs, so it
      // is written even when the level is set to warning or error.
      ...(options.level === 'off'
        ? []
        : [{ category: ['slackcli', 'session'], lowestLevel: 'info' as const, parentSinks: 'override' as const, sinks: sinkNames }]),
      // LogTape's own diagnostics. Configuring the category also stops LogTape
      // from attaching its default console sink, which would print to stdout.
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: sinks.file ? ['file'] : [] },
    ],
  });

  return logFile === undefined
    ? { runId, level: options.level }
    : { runId, level: options.level, logFile };
}

/**
 * Entry point for `src/index.ts`: resolves level and directory from the
 * environment, configures logging and writes the `session_start` record.
 */
export function startLogging(options: { verbose: boolean; actionCommand: Command }): LoggingSetup {
  const resolved = resolveLogLevel({ verbose: options.verbose, envValue: process.env.SLACKCLI_LOG_LEVEL });
  if (resolved.invalidValue !== undefined) {
    warning(
      `Ignoring SLACKCLI_LOG_LEVEL="${resolved.invalidValue}"; expected one of ${LOG_LEVEL_SETTINGS.join(', ')}. Using ${resolved.level}.`,
    );
  }

  const setup = configureLogging({
    level: resolved.level,
    verbose: options.verbose,
    dir: resolveLogDir(process.env, process.platform, homedir()),
  });

  getLogger(['slackcli', 'session']).info(
    'session_start {command}',
    buildSessionStart(describeInvocation(options.actionCommand)),
  );

  return setup;
}
