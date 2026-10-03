// Last-resort handlers for errors nothing else caught.
//
// `src/index.ts` calls `program.parse()`, not `parseAsync()`, so a rejection
// thrown from an async command action is never awaited: without these handlers
// it reaches the runtime's default printer and leaves no trace in the log file.
// The file sink writes each record synchronously, so logging right before
// `process.exit(1)` is safe.

import { homedir } from 'node:os';
import { getLogger } from '@logtape/logtape';
import { errorMessageForLog, tildifyText } from './tildify.ts';
import { error as printError } from './formatter.ts';
import { classifyError, isJsonErrorMode, renderJsonError } from './command-errors.ts';

const logger = getLogger(['slackcli', 'process']);

export type FatalErrorKind = 'unhandledRejection' | 'uncaughtException';

export interface FatalErrorDeps {
  /** Test seam: defaults to `formatter.error` (stderr). Not used in JSON mode. */
  print?: (message: string) => void;
  /** Test seam: whether the command ran with `--json`; defaults to `isJsonErrorMode()`. */
  json?: boolean;
  /** Test seam: where the JSON error line goes; defaults to stderr. */
  writeJson?: (line: string) => void;
  /** Test seam: defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Log the error with its stack, print its message (or, under `--json`, the
 * same error object a failing command writes), and exit non-zero.
 */
export function handleFatalError(kind: FatalErrorKind, err: unknown, deps: FatalErrorDeps = {}): void {
  const isError = err instanceof Error;
  const message = isError ? err.message : String(err);

  // Messages and stack frames carry absolute paths; write the home dir as `~`.
  const home = homedir();
  logger.error('{kind}: {error}', {
    kind,
    error: errorMessageForLog(err, message, home),
    error_name: isError ? err.name : typeof err,
    ...(isError && err.stack ? { stack: tildifyText(err.stack, home) } : {}),
  });

  if (deps.json ?? isJsonErrorMode()) {
    // A short single line, so the exit below cannot cut it short.
    (deps.writeJson ?? ((line: string) => process.stderr.write(line)))(renderJsonError(classifyError(err)));
  } else {
    (deps.print ?? printError)(message);
  }
  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}

let installed = false;

/** Register the handlers once per process. Later calls are no-ops. */
export function installProcessErrorHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
  process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));
}
